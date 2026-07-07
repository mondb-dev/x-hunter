#!/usr/bin/env node
/**
 * scraper/reply.js — FIFO reply queue processor
 *
 * For each pending mention, the pipeline is:
 *   1. Algorithmic spam pre-filter  (free — no API)
 *   2. Fetch thread context         (HelmStack — reads conversation before this mention)
 *   3. Memory recall                (SQLite FTS5 — retrieves relevant past thinking)
 *   4. Gemini classify + draft      (enriched prompt: thread + memory + mention)
 *   5. Post reply                   (HelmStack X engine reply())
 *   6. Log to state/interactions.json
 *
 * Rate limits: max 3 replies per run, 5 min between posts, 10 per day cap.
 *
 * Usage: node scraper/reply.js
 * Env:   GOOGLE_APPLICATION_CREDENTIALS (service account for Vertex AI)
 *        HelmStack browser API on http://127.0.0.1:7070 (HELMSTACK_AUTH_TOKEN);
 *        HELMSTACK_DRY_RUN=1 drafts + verifies the composer without posting.
 */

"use strict";

const { HelmStackClient, X } = require("../tools/helmstack-social/src");
const { isXSuppressed, suppressionReason } = require("../runner/lib/x_control");
const fs   = require("fs");
const path = require("path");

// Load .env for X API credentials when running standalone
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const db   = require("./db");
const { extractKeywords } = require("./analytics");
const { embed, topK } = require("./embed");
const { buildPersona, buildCoreContext } = require("../runner/lib/sebastian_respond");
const { gatherBrief, formatBriefForPrompt } = require("../runner/lib/intelligence_brief");
let verifyClaim = null;
try { ({ verifyClaim } = require("../runner/lib/verify_claim")); } catch {}

// Interactions store (SQLite or Postgres via db_backend; non-fatal if unavailable)
let interactionsDb = null;
try { interactionsDb = require("../runner/lib/db_backend").loadInteractionsDb(); } catch {}

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
// Skip self-mentions. Lowercased for comparison — the old constant
// ("SebHunts_AI", mixed case, stale handle) could never match.
const OWN_USERNAME = (process.env.X_USERNAME || "SebastianHunts").toLowerCase();

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
  // NOTE: "pump" and "rug" are intentionally NOT here — they collide with
  // legit deep-research asks ("pump.fun trenches", "is this token a rug?"),
  // which the classifier + rugcheck tool are built to handle. Real hype spam
  // is still caught by the multiplier/presale markers below + the Gemini SKIP.
  /\b(100x|1000x|moon|presale|mint\s+now)\b/i,
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

// ── 2. Fetch thread context via HelmStack ─────────────────────────────────────
/**
 * Extract the visible conversation on the mention's permalink, DOM order:
 * ancestor tweets first, then the mention itself. Returns up to 6
 * `{user, text}` snippets (quoted tweets folded into the text).
 */
async function fetchThreadContext(x, item) {
  const tweetUrl = `https://x.com/${item.from_username}/status/${item.id}`;
  try {
    const articles = await x.scrapeConversation(tweetUrl, { limit: 6 });
    return articles.map(a => {
      let text = (a.text || "").trim();
      if (a.quotedText) {
        text += `\n[quoting @${a.quotedUsername || "?"}: "${a.quotedText.slice(0, 200)}"]`;
      }
      return { user: a.username || a.displayName || "?", text };
    }).filter(a => a.text.length > 0);
  } catch (err) {
    console.warn(`[reply] thread context fetch failed: ${err.message}`);
    return [];
  }
}

// ── 3. Memory recall ──────────────────────────────────────────────────────────
/**
 * Semantic recall first (embed mention + thread context), FTS5 fallback.
 * Always called — returns [] on error so the pipeline never stalls.
 */
async function recallForMention(text, threadContext = [], limit = 5) {
  try {
    // Combine mention + thread context for a richer topic signal
    const threadText = threadContext.map(t => t.text).join(' ');
    const combinedText = [text, threadText].filter(Boolean).join(' ').slice(0, 600);

    // Semantic recall — await allEmbeddings (async on Postgres, sync on SQLite)
    const queryVec = await embed(combinedText);
    if (queryVec) {
      const embeddings = await Promise.resolve(db.allEmbeddings('memory'));
      if (embeddings.length > 0) {
        const nearest = topK(queryVec, embeddings, limit * 2);
        const SEM_MIN_SCORE = 0.05;
        const results = [];
        for (const hit of nearest) {
          if ((hit.similarity ?? 0) < SEM_MIN_SCORE) continue;
          // getMemoryById works on both SQLite (sync) and Postgres (async)
          const row = await Promise.resolve(db.getMemoryById(hit.entity_id));
          if (row) results.push(row);
          if (results.length >= limit) break;
        }
        if (results.length > 0) return results;
      }
    }

    // FTS5 fallback
    const keywords = extractKeywords(text, 8);
    if (!keywords.length) return [];
    const words = [...new Set(keywords.flatMap(k => k.split(/\s+/)))];
    return db.recallMemory(words.join(' OR '), limit);
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
  return buildCoreContext({
    maxAxes: 10,
    journalCount: 2,
    journalChars: 500,
    includeCheckpoint: true,
    checkpointChars: 500,
    includeClaims: true,
  });
}

// Focused, single-purpose research-intent classifier. The main classify prompt
// is large and its JSON template defaults needs_research=false, so an explicit
// ask ("do a deep research", "is this token a rug", "who owns this wallet?")
// often slips through as false. This isolated check reliably catches it.
async function detectResearchIntent(text) {
  const { callVertex } = require("../runner/vertex");
  const prompt =
`You classify a single X mention for RESEARCH INTENT only.
Set needs_research=true if the mention ASKS you to find out / verify / analyze something factual that needs looking up — e.g. "do a deep research", "who owns this wallet/address?", "is this token a rug / map its holder clusters", "is <claim> true?", "what's the data/current state of <X>?". Otherwise false.
MENTION: "${String(text).replace(/"/g, "'").slice(0, 500)}"
Respond ONLY with JSON, no fences: {"needs_research":true|false,"research_query":"crisp standalone version of what to research, or empty"}`;
  const raw = await callVertex(prompt, 256, { model: "gemini-2.5-flash", thinkingBudget: 0 });
  const m = String(raw).replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!m) return { needs_research: false, research_query: "" };
  return JSON.parse(m[0]);
}

// ── 5. Gemini: classify + draft with full context ─────────────────────────────
async function geminiClassify(item, threadContext = [], memoryHints = [], userHistory = null, topicAccounts = [], verifiedHints = [], liveVerification = null, intelligenceBrief = null) {
  const { callVertex } = require("../runner/vertex");

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
  // If a topic-matched intelligence brief was provided, use it — otherwise fall back to global top axes
  const beliefBlock = intelligenceBrief
    ? formatBriefForPrompt(intelligenceBrief)
    : loadBeliefContext();

  const prompt = `${buildPersona('reply')}

${beliefBlock}${threadBlock}${memoryBlock}${accountBlock}${userBlock}${verifyBlock}
The mention you are replying to:
@${item.from_username}: "${item.text}"${item.quoted_text ? `\n[This is a quote tweet. The post they quoted (from @${item.quoted_username || "?"}): "${item.quoted_text.slice(0, 400)}"]` : ""}

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
   - SUBSTANCE TEST: your reply must carry concrete information the other person could
     not get from their own post alone — a named party, a specific claim quoted or
     paraphrased, a number, a date, a prior statement, a source. If you stripped every
     proper noun and specific detail from your reply and it still made grammatical
     sense as a generic observation, you have written nothing. Rewrite with the
     specifics in. Gesturing at "narratives", "the truth", "what is really happening",
     "different stories", or "what is being said" without ever naming WHICH narrative,
     WHOSE truth, or WHAT is being said reads as trolling — there is no claim to
     engage with. If the post you are replying to names specific actors making
     specific claims, at least one of those actors and one of those claims must
     appear in your reply by name.

RESEARCH: If the mention ASKS you to find out / verify / analyze something factual that needs looking up — e.g. "who owns this wallet/address?", "is this token a rug / map its holder clusters", "is <claim> true?", "what's the data on <X>?" — set needs_research=true and research_query to a crisp standalone version of what to research. Otherwise needs_research=false.

Respond ONLY with valid JSON, no markdown fences:
{"verdict":"WORTHY","reply":"your reply text here","needs_research":false,"research_query":""}
or
{"verdict":"SKIP","reason":"brief reason"}`;

  const text = await callVertex(prompt, 2048, { model: 'gemini-2.5-flash', thinkingBudget: 0 });

  // Strip optional markdown fences, then extract the JSON object (greedy match)
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Vertex returned no JSON. Raw: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(match[0]);
  // Research intent is easy to miss inside this large prompt; re-check it with a
  // focused classifier whenever the main pass didn't already flag it.
  if (parsed.verdict === "WORTHY" && !parsed.needs_research) {
    try {
      const ri = await detectResearchIntent(item.text);
      if (ri && ri.needs_research) {
        parsed.needs_research = true;
        parsed.research_query = ri.research_query || item.text;
        console.log(`[reply] research intent detected on re-check → "${String(parsed.research_query).slice(0, 80)}"`);
      }
    } catch (e) { console.warn(`[reply] research-intent re-check failed (non-fatal): ${e.message}`); }
  }
  parsed.sourceUrls = [];
  return parsed;
}

// ── 5. Post reply via HelmStack X engine ──────────────────────────────────────
/**
 * Delegates to X.reply(): navigate (wedge-checked), click reply on the article
 * matching this status id, exact-match verified insert, toast check, submit.
 * Throws on any non-posted outcome so the caller's error handling records it.
 * Returns the engine result (`{ok, reason?, dryRun?}`).
 */
async function postReply(x, item, replyText, dryRun) {
  console.log(`[reply] posting reply to @${item.from_username} via HelmStack`);
  const tweetUrl = `https://x.com/${item.from_username}/status/${item.id}`;
  const res = await x.reply(tweetUrl, replyText, { dryRun });
  if (res.dryRun) return res;
  if (!res.ok) throw new Error(res.reason || "reply failed");
  console.log(`[reply] posted reply to @${item.from_username} on ${tweetUrl}`);
  return res;
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

  // Mirror to Postgres (fire-and-forget)
  if (interactionsDb && process.env.DATABASE_URL) {
    interactionsDb.insertInteraction({
      tweet_id:       item.id,
      type:           'reply',
      from_username:  item.from_username,
      from_display:   item.display_name || null,
      their_text:     item.text,
      our_reply:      replyText,
      memory_used:    memoryHints.map(m => `${m.type}:${m.title}`),
      interaction_at: data.last_reply_at,
    }).catch(e => console.warn('[reply] interactions_db write failed:', e.message));
  }
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

  // Connect to the HelmStack browser
  const dryRun = process.env.HELMSTACK_DRY_RUN === "1";
  let x;
  try {
    x = new X(new HelmStackClient(), {
      ownHandle: (process.env.X_USERNAME || "SebastianHunts"),
      dedicatedTab: true, // collect.js adopts+navigates the shared tab mid-flow
      log: (m) => console.log(`[reply] ${m}`),
    });
    await x.ensureTab();
    if (!(await x.sessionOk())) {
      throw new Error("X session not present in HelmStack (auth_token/ct0 missing)");
    }
  } catch (err) {
    console.error(`[reply] could not connect to HelmStack: ${err.message}`);
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
    const threadContext = await fetchThreadContext(x, item);
    console.log(`[reply] thread: ${threadContext.length} tweet(s) in view`);

    // ── Step 3: Memory recall + account lookup ────────────────────────────
    const memoryHints = await recallForMention(item.text, threadContext);
    const topicAccounts = accountsForTopic(item.text);
    if (memoryHints.length > 0) {
      console.log(`[reply] memory: ${memoryHints.length} relevant entry(s) (${memoryHints.map(m => m.title).join(", ")})`);
    } else {
      console.log(`[reply] memory: no relevant past entries found`);
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
    if (verifyClaim) {
      // If the message is a short "verify this" intent, extract claim from the
      // parent post (threadContext[0]) instead of the user's own short message.
      const isVerifyIntent = /\b(verify|fact.?check|is this true|check this|true or false)\b/i.test(item.text)
        && item.text.length <= 80;
      const claimSource = isVerifyIntent && threadContext.length > 0
        ? threadContext[0].text
        : item.text;
      const claimHandle = isVerifyIntent && threadContext.length > 0
        ? threadContext[0].user
        : item.from_username;

      if (claimSource && claimSource.length > 40) {
        try {
          if (isVerifyIntent) console.log(`[reply] verify intent detected — checking parent post claim`);
          liveVerification = verifyClaim({ claim: claimSource, handle: claimHandle });
          if (liveVerification) {
            console.log(`[reply] live verify: ${liveVerification.verdict_label} (${Math.round((liveVerification.confidence || 0) * 100)}%)`);
          }
        } catch (err) {
          console.warn(`[reply] live verify failed (non-fatal): ${err.message}`);
        }
      }
    }

    // Gather topic-matched intelligence brief (axes, drift, claims, memory) for this mention
    let intelligenceBrief = null;
    try {
      const briefQuery = [item.text, item.quoted_text].filter(Boolean).join(" ").slice(0, 300);
      intelligenceBrief = gatherBrief(briefQuery);
      if (intelligenceBrief.axes.length) {
        console.log(`[reply] intelligence brief: ${intelligenceBrief.axes.length} axes, ${intelligenceBrief.drift.length} drift alerts, ${intelligenceBrief.claims.length} claims`);
      }
    } catch (err) {
      console.warn(`[reply] intelligence brief failed (non-fatal): ${err.message}`);
    }

    let verdict;
    try {
      verdict = await geminiClassify(item, threadContext, memoryHints, userHistory, topicAccounts, [], liveVerification, intelligenceBrief);
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
    if (!replyText) {
      item.status = "skipped";
      item.skip_reason = "reply text empty";
      continue;
    }

    // ── Autonomous deep research: if the mention asks a factual question, run
    //    the research tool, publish a report page, and answer with a link. ──
    let researchUrl = null;
    if (verdict.needs_research && process.env.X_AUTO_RESEARCH === '1' && !dryRun) {
      const q = (verdict.research_query || item.text).trim();
      try {
        console.log(`[reply] research question → deep_research: "${q.slice(0, 90)}"`);
        const { researchAndPublish } = require('../runner/deep_research');
        const rr = await researchAndPublish(q, { maxFetch: 3, source: 'x_mention' });
        if (rr.shortAnswer) replyText = rr.shortAnswer;
        if (rr.url) { researchUrl = rr.url; liveVerification = null; verdict.sourceUrls = [rr.url]; }
        console.log(`[reply] research done → ${rr.url || '(no report)'}`);
      } catch (e) { console.error(`[reply] research failed (${e.message}) — using plain draft`); }
    }

    // Always prepend @from_username so the person gets a mention notification.
    // Gemini omits it; X may pre-fill it in the compose box but the CDP
    // insertion path clears the box, losing the pre-fill.
    const mentionPrefix = `@${item.from_username} `;
    if (!replyText.startsWith(mentionPrefix)) {
      replyText = mentionPrefix + replyText;
    }

    // ── Trailing link: never promise a link we don't include ─────────────────
    // Priority: research/source report URL → Veritas Lens (when verified) → the
    // journal permalink we actually grounded in, whenever the draft points the
    // reader at "my journal / a link / a past piece". Budget against raw length
    // and TRIM the draft to make room, rather than silently dropping the link
    // (which is how replies ended up saying "check my journal" with no URL).
    const journalUrl = (memoryHints.find(m => m && m.webUrl) || {}).webUrl || null;
    const alreadyHasUrl = /https?:\/\//.test(replyText);
    const promisesLink = /\b(journals?|links?|wrote about|see my|check my|my (post|piece|article)|as I (noted|wrote|said)|previously)\b/i.test(replyText);

    let trailingUrl = null;
    const sourceUrls = verdict.sourceUrls || [];
    if (sourceUrls.length > 0) trailingUrl = sourceUrls[0];
    else if (liveVerification && liveVerification.lens_url) trailingUrl = liveVerification.lens_url;
    else if (promisesLink && journalUrl) trailingUrl = journalUrl;

    if (trailingUrl && !alreadyHasUrl) {
      const room = 280 - (trailingUrl.length + 1); // +1 for the newline
      if (replyText.length > room) replyText = replyText.slice(0, room - 1).trimEnd() + "…";
      replyText = replyText + '\n' + trailingUrl;
    } else if (replyText.length > 280) {
      replyText = replyText.slice(0, 277) + "…";
    }

    // Last-resort guard: if the draft still points the reader at a journal/link
    // but none got attached, drop the dangling clause so we don't post a hollow
    // reference. Only apply when a substantial reply survives the strip.
    if (!/https?:\/\//.test(replyText) && promisesLink) {
      const stripped = replyText
        .replace(/\s*(?:[—,-]\s*)?(?:you can |please |pls )?(?:check|see|read)(?:\s+out)?\s+(?:my\s+)?journals?(?:\s+links?)?(?:\s+for\s+(?:more\s+)?context)?\.?/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      // Keep the strip only if what remains is still a real reply (prefix + ~1 clause).
      if (stripped.length >= mentionPrefix.length + 25) replyText = stripped;
    }

    // ── Step 5: Post reply ────────────────────────────────────────────────
    try {
      const res = await postReply(x, item, replyText, dryRun);
      if (res.dryRun) {
        console.log(`[reply] DRY RUN — composer verified for @${item.from_username}, item left pending. Draft: "${replyText.slice(0, 100)}"`);
        repliedThisRun++;
        continue;
      }
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
  await x.close();
  process.exit(0);
})();
