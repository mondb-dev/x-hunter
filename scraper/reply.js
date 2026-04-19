#!/usr/bin/env node
/**
 * scraper/reply.js — FIFO reply queue processor
 *
 * For each pending mention, the pipeline is:
 *   1. Algorithmic spam pre-filter  (free — no API)
 *   2. Fetch thread context         (CDP — reads conversation before this mention)
 *   3. Memory recall                (SQLite FTS5 — retrieves relevant past thinking)
 *   4. Gemini classify + draft      (enriched prompt: thread + memory + mention)
 *   5. Post reply                   (CDP — page already on tweet, no re-navigation)
 *   6. Log to state/interactions.json
 *
 * Rate limits: max 3 replies per run, 5 min between posts, 10 per day cap.
 *
 * Usage: node scraper/reply.js
 * Env:   GOOGLE_APPLICATION_CREDENTIALS (service account for Vertex AI)
 *        CDP browser on http://127.0.0.1:18801
 */

"use strict";

const { connectBrowser, getXPage } = require("../runner/cdp");
const { replyToTweet } = require("../runner/x_api");
const { isXSuppressed, suppressionReason } = require("../runner/lib/x_control");
const fs   = require("fs");
const path = require("path");

// Load .env for X API credentials when running standalone
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const db   = require("./db");
const { extractKeywords } = require("./analytics");
const { buildPersona, buildCoreContext } = require("../runner/lib/sebastian_respond");
let verifyClaim = null;
try { ({ verifyClaim } = require("../runner/lib/verify_claim")); } catch {}

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, "..");
const REPLY_QUEUE  = path.join(ROOT, "state", "reply_queue.jsonl");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");
const ONTOLOGY     = path.join(ROOT, "state", "ontology.json");
const VOCATION     = path.join(ROOT, "state", "vocation.json");

const MAX_PER_RUN  = 3;
const MIN_GAP_MS   = 5 * 60 * 1000;  // 5 minutes between replies
const MAX_PER_DAY  = 10;
const MAX_AGE_MS   = 48 * 60 * 60 * 1000;  // ignore mentions older than 48h
const OWN_USERNAME = "SebHunts_AI";  // skip self-mentions

if (isXSuppressed("reply")) {
  console.log(`[reply] X reply suppression active — skipping (${suppressionReason("reply")})`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readQueue() {
  try {
    return fs.readFileSync(REPLY_QUEUE, "utf-8")
      .trim().split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeQueue(items) {
  fs.writeFileSync(REPLY_QUEUE, items.map(i => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
}

// ── 1. Spam pre-filter (algorithmic, no API) ──────────────────────────────────
const SPAM_PATTERNS = [
  /\bgiveaway\b/i,
  /\bwin\s+(free|big|prizes?)\b/i,
  /\b(dm\s+me|dm\s+for|message\s+me)\b/i,
  /\b(click|buy\s+now|limited\s+time|act\s+now)\b/i,
  /\b(100x|1000x|moon|pump|rug|presale|mint\s+now)\b/i,
  /\b(nft|token)\s+(drop|launch|sale)\b/i,
  /\bfollow\s+(back|for\s+follow)\b/i,
  /http[s]?:\/\/\S+\.(ru|cn|tk|xyz)\b/i,
];

function isSpam(item) {
  const t = item.text || "";
  const u = item.from_username || "";

  const stripped = t.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
  if (stripped.length < 10) return { spam: true, reason: "no real content" };

  for (const pat of SPAM_PATTERNS) {
    if (pat.test(t)) return { spam: true, reason: `spam pattern: ${pat.source}` };
  }

  if (/\d{6,}$/.test(u)) return { spam: true, reason: "bot-like username" };

  return { spam: false };
}

// ── 2. Fetch thread context via CDP ───────────────────────────────────────────
/**
 * Navigate to the tweet page and extract the visible conversation thread.
 * Returns up to 6 tweet snippets (ancestor tweets + the mention itself).
 * Leaves the page on the tweet URL so postReply can skip re-navigation.
 */
async function fetchThreadContext(page, item) {
  const tweetUrl = `https://x.com/${item.from_username}/status/${item.id}`;
  try {
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
    await new Promise(r => setTimeout(r, 1_500));

    const articles = await page.$$eval('article[data-testid="tweet"]', els =>
      els.slice(0, 6).map(a => {
        const userEl = a.querySelector('[data-testid="User-Name"]');
        const textEl = a.querySelector('[data-testid="tweetText"]');
        return {
          user: (userEl?.innerText || "").split("\n")[0].trim(),
          text: (textEl?.innerText || "").trim(),
        };
      }).filter(a => a.text.length > 0)
    );

    return articles;
  } catch (err) {
    console.warn(`[reply] thread context fetch failed: ${err.message}`);
    // Navigate anyway so we end up on the right page for posting
    try { await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }); } catch {}
    return [];
  }
}

// ── 3. Memory recall ──────────────────────────────────────────────────────────
/**
 * Extract RAKE keywords from the mention text and query the local memory FTS5
 * index for relevant past journal/checkpoint entries.
 *
 * FTS5 uses implicit AND for space-separated tokens, so we join individual
 * words with OR to broaden recall (RAKE often produces multi-word phrases
 * whose AND conjunction matches almost nothing).
 */
function recallForMention(text, limit = 5) {
  try {
    const keywords = extractKeywords(text, 8);
    if (!keywords.length) return [];
    // Split all RAKE phrases into individual words, dedupe, join with OR
    const words = [...new Set(keywords.flatMap(k => k.split(/\s+/)))];
    const ftsQuery = words.join(" OR ");
    return db.recallMemory(ftsQuery, limit);
  } catch {
    return [];
  }
}

// ── 3b. Account lookup — find accounts discussing this topic ────────────────
/**
 * Query the posts table for accounts whose posts match keywords from the mention.
 * Returns an array of { username, post_count, sample_text } objects — real
 * accounts Sebastian has observed, suitable for citing in replies.
 */
function accountsForTopic(text, limit = 8) {
  try {
    const keywords = extractKeywords(text, 6);
    if (!keywords.length) return [];
    // Build a LIKE-based query — FTS5 is on memory, not posts
    const words = [...new Set(keywords.flatMap(k => k.split(/\s+/)))];
    if (!words.length) return [];
    const likeClauses = words.slice(0, 4).map(() => "text LIKE ?").join(" OR ");
    const params = words.slice(0, 4).map(w => `%${w}%`);
    const sql = `
      SELECT username, COUNT(*) as post_count,
             MAX(text) as sample_text
      FROM posts
      WHERE (${likeClauses})
        AND username != 'SebastianHunts'
        AND username != ''
      GROUP BY username
      ORDER BY post_count DESC
      LIMIT ?
    `;
    const dbInstance = db.raw();
    if (!dbInstance) return [];
    return dbInstance.prepare(sql).all(...params, limit);
  } catch {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a memory file_path to its public web URL on sebastianhunter.fun.
 * journals/YYYY-MM-DD_HH.html → https://sebastianhunter.fun/journal/YYYY-MM-DD/HH
 * Anything else returns null (checkpoints/tweets have no dedicated public page yet).
 */
function memoryWebUrl(filePath) {
  const m = filePath && filePath.match(/^journals\/(\d{4}-\d{2}-\d{2})_(\d{2})\.html$/);
  if (!m) return null;
  return `https://sebastianhunter.fun/journal/${m[1]}/${parseInt(m[2], 10)}`;
}

// ── 4. Belief & vocation context — delegated to sebastian_respond ─────────────
function loadBeliefContext() {
  return buildCoreContext({ maxAxes: 6, journalCount: 0 });
}

// ── 5. Gemini: classify + draft with full context ─────────────────────────────
async function geminiClassify(item, threadContext = [], memoryHints = [], userHistory = null, topicAccounts = [], verifiedHints = [], liveVerification = null) {
  const { getAccessToken, getProjectConfig } = require("../runner/gcp_auth");
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();

  // Build thread context block
  let threadBlock = "";
  if (threadContext.length > 0) {
    threadBlock = "\nThread context (conversation before this mention):\n" +
      threadContext
        .map(a => `  @${a.user}: "${a.text.slice(0, 220)}"`)
        .join("\n") + "\n";
  }

  // Build memory block
  let memoryBlock = "";
  if (memoryHints.length > 0) {
    memoryBlock = "\nYour relevant past thinking (from journals/checkpoints):\n" +
      memoryHints.map(m => {
        const excerpt = (m.text_content || "").replace(/\s+/g, " ").trim().slice(0, 500);
        const webUrl  = memoryWebUrl(m.file_path);
        const urlLine = webUrl ? `\n  URL: ${webUrl}` : "";
        return `  [${m.type} · ${m.title} · ${m.date}]${urlLine}\n  "${excerpt}..."`;
      }).join("\n\n") + "\n";
  }

  // Build user history block
  let userBlock = "";
  if (userHistory && userHistory.reply_count > 0) {
    const prior = userHistory.exchanges.slice(-3).map(e =>
      `  Them: "${(e.their_text || "").slice(0, 120)}"\n  Us: "${(e.our_reply || "").slice(0, 120)}"`
    ).join("\n---\n");
    userBlock = `\nPrior exchanges with @${item.from_username} (${userHistory.reply_count} total):\n${prior}\n\nReference prior exchanges if relevant. Do not repeat what was already said.\n`;
  }

  // Build accounts block — real accounts Sebastian has observed discussing this topic
  let accountBlock = "";
  if (topicAccounts && topicAccounts.length > 0) {
    accountBlock = "\nAccounts you've seen discussing this topic (cite these when asked for sources):\n" +
      topicAccounts.map(a => {
        const sample = (a.sample_text || "").replace(/\s+/g, " ").trim().slice(0, 150);
        return `  @${a.username} (${a.post_count} posts) — e.g. "${sample}"`;
      }).join("\n") + "\n";
  }

  // Build live verification block
  let verifyBlock = "";
  if (liveVerification) {
    const v = liveVerification;
    const urls = (v.evidence_urls || []).slice(0, 2).join(" | ");
    verifyBlock = `\nLIVE VERIFICATION of this mention's claim:\n` +
      `  Verdict: ${v.verdict_label} (confidence ${Math.round((v.confidence || 0) * 100)}%)\n` +
      `  Summary: ${v.summary || "No summary."}\n` +
      (v.framing ? `  Framing: ${v.framing.slice(0, 200)}\n` : "") +
      (urls ? `  Evidence: ${urls}\n` : "") +
      `  Veritas Lens: ${v.lens_url}\n` +
      `CRITICAL GROUNDING RULES:\n` +
      `- "Refuted" = PROVEN FALSE by evidence. You may correct using the counter-evidence above.\n` +
      `- "Unverified" = COULD NOT CONFIRM OR DENY. This is NOT "false". Do NOT say the claim is wrong.\n` +
      `- "Supported" = Claim checks out. You may cite the evidence.\n` +
      `- NEVER fabricate corrections. Only correct when you have specific counter-evidence from sources above.\n`;
  }

  // Build belief axes + vocation context
  const beliefBlock = loadBeliefContext();

  const prompt = `${buildPersona('reply')}

${beliefBlock}${threadBlock}${memoryBlock}${accountBlock}${userBlock}${verifyBlock}
The mention you are replying to:
@${item.from_username}: "${item.text}"

Instructions:
1. Read the thread context to understand what conversation this is part of.
2. Check your past thinking — you have journal entries and positions above.
3. Decide: WORTHY or SKIP?
   - SKIP: spam, marketing, NFT/crypto hype, scam, bot, low-effort mention, insults with no substance.
   - SKIP if asking about: contract address (CA), token address, where to buy, collection details,
     mint link, or anything related to purchasing/collecting Sebastian's work.
     Reply with: {"verdict":"WORTHY","reply":"My handler @0xAnomalia handles that side of things — hit them up."}
   - WORTHY: genuine question, interesting pushback, thoughtful observation, anything inviting real engagement.
4. If WORTHY, draft a reply (max 200 chars):
   - If the person asks for specific accounts, sources, or evidence — use the
     "Accounts you've seen" list above. Cite real @usernames you've observed.
     Do NOT say "I don't track individual accounts" — you do.
   - Talk like a person. Short, direct sentences. Say what you think and why.
   - NEVER include internal metrics: no confidence scores, no percentages, no axis names,
     no "(0.16)", no "conf 85%", no axis labels like "Truth and Evidence".
     These are internal — the public must never see them.
   - NEVER use robotic/formal openers: no "Acknowledged", no "I will assess",
     no "My focus:", no "My belief". Talk like you would to someone at a bar.
   - Good examples: "Been watching this — the evidence keeps pointing at X."
     "Interesting. I noticed the opposite pattern last week."
     "I'd push back on that — here's what I actually saw: [concrete thing]."
   - If you have relevant journal entries above, you can reference them naturally:
     "I wrote about this a few days ago" or include the journal URL.
   - Can be a question back, a one-liner, or a brief counterpoint.
   - No filler ("great question!", "thanks!", "love this!")
   - No metaphors about hunting, journeys, or archives.
   - GROUNDING RULE (AGENTS.md §18): Before claiming any prior observation or belief
     history ("I noted previously", "Day X"), verify it appears in your past thinking above.
     If not, ground the reply in what you see RIGHT NOW. Do not invent a history.

Respond ONLY with valid JSON, no markdown fences:
{"verdict":"WORTHY","reply":"your reply text here"}
or
{"verdict":"SKIP","reason":"brief reason"}`;

  const res = await fetch(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  // Extract grounding URLs from Vertex response
  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sourceUrls = groundingChunks
    .filter(c => c.web?.uri)
    .map(c => c.web.uri)
    .slice(0, 3);

  // Strip optional markdown fences, then extract the JSON object (greedy match)
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini returned no JSON. Raw: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(match[0]);
  parsed.sourceUrls = sourceUrls;
  return parsed;
}

// ── 5. Post reply via X API ─────────────────────────────────────────────────
async function postReply(page, item, replyText) {
  console.log(`[reply] posting reply to @${item.from_username} via API`);

  // Extract tweet ID from the item
  const tweetId = item.id;
  if (!tweetId) throw new Error("no tweet ID on queue item");

  const result = await replyToTweet(replyText, tweetId);
  console.log(`[reply] posted reply to @${item.from_username}: https://x.com/SebHunts_AI/status/${result.id}`);
}

// ── Interactions log ──────────────────────────────────────────────────────────
function loadInteractions() {
  const today = new Date().toISOString().slice(0, 10);
  const data = loadJson(INTERACTIONS, { total_replies: 0, today_count: 0, today_date: today, last_reply_at: null, replies: [], users: {} });
  if (data.today_date !== today) { data.today_count = 0; data.today_date = today; }
  if (!data.users) data.users = {};
  return data;
}

function getUserHistory(data, username) {
  return (data.users || {})[username] || null;
}

function logInteraction(data, item, replyText, memoryHints) {
  data.total_replies = (data.total_replies || 0) + 1;
  data.today_count   = (data.today_count   || 0) + 1;
  data.last_reply_at = new Date().toISOString();
  data.replies.push({
    id:            item.id,
    from:          item.from_username,
    their_text:    item.text,
    our_reply:     replyText,
    memory_used:   memoryHints.map(m => `${m.type}:${m.title}`),
    replied_at:    data.last_reply_at,
  });
  if (data.replies.length > 500) data.replies = data.replies.slice(-500);

  // Update per-user conversation history
  const u = data.users[item.from_username] || { reply_count: 0, last_reply_at: null, exchanges: [] };
  u.reply_count += 1;
  u.last_reply_at = data.last_reply_at;
  u.exchanges.push({ their_text: item.text, our_reply: replyText, replied_at: data.last_reply_at });
  if (u.exchanges.length > 5) u.exchanges = u.exchanges.slice(-5);
  data.users[item.from_username] = u;

  saveJson(INTERACTIONS, data);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[reply] starting reply queue processor...");

  const interactions = loadInteractions();

  // Check daily cap
  if ((interactions.today_count || 0) >= MAX_PER_DAY) {
    console.log(`[reply] daily cap reached (${interactions.today_count}/${MAX_PER_DAY}). skipping.`);
    process.exit(0);
  }

  // Check minimum gap since last reply
  if (interactions.last_reply_at) {
    const elapsed = Date.now() - new Date(interactions.last_reply_at).getTime();
    if (elapsed < MIN_GAP_MS) {
      const waitMin = Math.ceil((MIN_GAP_MS - elapsed) / 60_000);
      console.log(`[reply] too soon since last reply (${waitMin}min remaining). skipping.`);
      process.exit(0);
    }
  }

  // Build set of tweet IDs we already replied to (from interactions.json)
  const repliedIds = new Set(
    (interactions.replies || []).map(r => r.id).filter(Boolean)
  );

  // Load queue — oldest first (FIFO), only pending items
  const queue = readQueue();
  const now = Date.now();
  let skippedStale = 0, skippedDupe = 0, skippedSelf = 0;

  const pending = queue.filter(i => {
    if (i.status !== "pending" && i.status !== "error") return false;

    // Skip self-mentions
    if ((i.from_username || "").toLowerCase() === OWN_USERNAME) {
      i.status = "skipped"; i.skip_reason = "self-mention";
      skippedSelf++; return false;
    }

    // Skip already-replied tweets (dedup against interactions.json)
    if (repliedIds.has(i.id)) {
      i.status = "skipped"; i.skip_reason = "already replied (interactions dedup)";
      skippedDupe++; return false;
    }

    // Skip stale mentions (older than 48h)
    if (i.ts && (now - i.ts) > MAX_AGE_MS) {
      i.status = "skipped"; i.skip_reason = `stale (${Math.round((now - i.ts) / 3600000)}h old)`;
      skippedStale++; return false;
    }

    return true;
  }).sort((a, b) => a.ts - b.ts);

  if (skippedStale || skippedDupe || skippedSelf) {
    console.log(`[reply] filtered: ${skippedDupe} already-replied, ${skippedStale} stale, ${skippedSelf} self`);
  }
  console.log(`[reply] queue: ${pending.length} pending item(s)`);

  if (pending.length === 0) { console.log("[reply] nothing to process."); process.exit(0); }

  // Connect to browser
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[reply] could not connect to CDP: ${err.message}`);
    process.exit(1);
  }

  // Open a dedicated tab — avoids CDP session conflicts with the runner
  let page;
  try {
    page = await browser.newPage();
  } catch (err) {
    console.error(`[reply] could not open new tab: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  let repliedThisRun = 0;

  for (const item of pending) {
    if (repliedThisRun >= MAX_PER_RUN) break;
    if ((interactions.today_count || 0) >= MAX_PER_DAY) break;

    console.log(`[reply] processing @${item.from_username}: "${item.text.slice(0, 80)}"`);

    // ── Step 1: Spam pre-filter ────────────────────────────────────────────
    const spamCheck = isSpam(item);
    if (spamCheck.spam) {
      console.log(`[reply] skipping (spam: ${spamCheck.reason})`);
      item.status = "skipped";
      item.skip_reason = spamCheck.reason;
      continue;
    }

    // ── Step 2: Fetch thread context (navigate to tweet) ──────────────────
    console.log(`[reply] fetching thread context...`);
    const threadContext = await fetchThreadContext(page, item);
    console.log(`[reply] thread: ${threadContext.length} tweet(s) in view`);

    // ── Step 3: Memory recall + account lookup ────────────────────────────
    const memoryHints = recallForMention(item.text);
    const topicAccounts = accountsForTopic(item.text);
    if (memoryHints.length > 0) {
      console.log(`[reply] memory: ${memoryHints.length} relevant entry(s) found (${memoryHints.map(m => m.title).join(", ")})`);
    } else {
      console.log(`[reply] memory: no relevant past entries`);
    }
    if (topicAccounts.length > 0) {
      console.log(`[reply] accounts: ${topicAccounts.length} relevant (${topicAccounts.slice(0,3).map(a => "@"+a.username).join(", ")})`);
    }

    // ── Step 4: Gemini classify + draft ───────────────────────────────────
    const userHistory = getUserHistory(interactions, item.from_username);
    if (userHistory) {
      console.log(`[reply] user history: @${item.from_username} has ${userHistory.reply_count} prior exchange(s)`);
    }

    // ── Step 3b: Live claim verification ──────────────────────────────────
    let liveVerification = null;
    if (verifyClaim && item.text.length > 40) {
      try {
        liveVerification = verifyClaim({ claim: item.text, handle: item.from_username });
        if (liveVerification) {
          console.log(`[reply] live verify: ${liveVerification.verdict_label} (${Math.round((liveVerification.confidence || 0) * 100)}%)`);
        }
      } catch (err) {
        console.warn(`[reply] live verify failed (non-fatal): ${err.message}`);
      }
    }

    let verdict;
    try {
      verdict = await geminiClassify(item, threadContext, memoryHints, userHistory, topicAccounts, verifiedHints, liveVerification);
    } catch (err) {
      console.error(`[reply] Gemini error: ${err.message}`);
      item.status = "error";
      item.error = err.message;
      continue;
    }

    console.log(`[reply] Gemini verdict: ${verdict.verdict}`);

    if (verdict.verdict !== "WORTHY") {
      item.status = "skipped";
      item.skip_reason = verdict.reason || "Gemini SKIP";
      continue;
    }

    let replyText = verdict.reply;
    if (!replyText || replyText.length > 280) {
      item.status = "skipped";
      item.skip_reason = "reply text invalid or too long";
      continue;
    }

    // Append one grounding source URL if it fits (X shortens to ~23 chars via t.co)
    const sourceUrls = verdict.sourceUrls || [];
    if (sourceUrls.length > 0 && replyText.length <= 247) {
      replyText = replyText + '\n' + sourceUrls[0];
    }

    // ── Step 5: Post reply (page already on tweet URL) ────────────────────
    try {
      await postReply(page, item, replyText);
      item.status    = "done";
      item.our_reply = replyText;
      item.replied_at = new Date().toISOString();
      logInteraction(interactions, item, replyText, memoryHints); // increments today_count
      repliedThisRun++;
      interactions.last_reply_at = item.replied_at;

      if (repliedThisRun < MAX_PER_RUN && pending.indexOf(item) < pending.length - 1) {
        console.log(`[reply] waiting 5 min before next reply...`);
        await new Promise(r => setTimeout(r, MIN_GAP_MS));
      }
    } catch (err) {
      console.error(`[reply] failed to post: ${err.message}`);
      item.status = "error";
      item.error  = err.message;
    }
  }

  writeQueue(queue);

  console.log(`[reply] done. replied ${repliedThisRun} time(s) this run.`);
  await page.close().catch(() => {});
  browser.disconnect();
  process.exit(0);
})();
