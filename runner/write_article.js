#!/usr/bin/env node
// runner/write_article.js — daily long-form article writer
//
// Pulls journals from SQLite index, loads belief axes, calls Gemini to write
// a ~800-1000 word editorial grounded in Sebastian's actual observations.
// Saves to state/article_draft.md for moltbook.js --post-article to publish.
//
// Run: node runner/write_article.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { loadScraperDb, loadVerificationDb } = require("./lib/db_backend");
const db = loadScraperDb();
let vdb;
try { vdb = loadVerificationDb(); } catch { /* verification db unavailable */ }

// ── Load env ──────────────────────────────────────────────────────────────────
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const ARTICLE_DRAFT = path.join(ROOT, "state", "article_draft.md");
const ARTICLE_STATE = path.join(ROOT, "state", "article_state.json");
const ARTICLES_DIR  = path.join(ROOT, "articles");

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadArticleState() {
  try { return JSON.parse(fs.readFileSync(ARTICLE_STATE, "utf-8")); }
  catch { return { last_written_at: null, last_axis: null, recent_axes: [] }; }
}

function saveArticleState(s) {
  fs.writeFileSync(ARTICLE_STATE, JSON.stringify(s, null, 2));
}

/**
 * Pick topic axis — rotates through top axes so the same one doesn't repeat.
 * Avoids the last 3 axes used (stored in artState.recent_axes).
 * Falls back to the top axis if all top-5 were recently used.
 */
function pickAxis(ontology, artState) {
  const axes = Object.values(ontology.axes || ontology)
    .filter(a => (a.confidence || 0) > 0.3 && Math.abs(a.score || 0) > 0.1)
    .sort((a, b) => (b.confidence * Math.abs(b.score)) - (a.confidence * Math.abs(a.score)));

  const top5 = axes.slice(0, 5);
  const recentlyUsed = new Set(artState.recent_axes || []);
  const fresh = top5.filter(a => !recentlyUsed.has(a.id || a.label));
  return (fresh.length > 0 ? fresh : top5)[0] || axes[0];
}

/**
 * Qualitative stance description — no numbers, no scores.
 * Used for the "background context" block in the prompt.
 */
function axisStance(axis) {
  const score      = axis.score || 0;
  const label      = axis.label || axis.id || "this topic";
  const leftPole   = axis.pole_left  || axis.left_pole  || "";
  const rightPole  = axis.pole_right || axis.right_pole || "";
  const magnitude  = Math.abs(score);
  const pole       = score > 0 ? leftPole : rightPole;

  let strength;
  if      (magnitude > 0.6)  strength = "strongly";
  else if (magnitude > 0.35) strength = "clearly";
  else if (magnitude > 0.15) strength = "cautiously";
  else                       strength = "slightly";

  const certainty = (axis.confidence || 0) > 0.75 ? "with high certainty" :
                    (axis.confidence || 0) > 0.5   ? "with moderate certainty" : "tentatively";

  return pole
    ? `${label}: ${strength} toward "${pole}" ${certainty}`
    : `${label}: ${strength} directional lean ${certainty}`;
}

const { callVertex } = require("./vertex.js");
async function callGemini(prompt) { return callVertex(prompt, 16384, { thinkingBudget: 8192 }); }

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[article] starting daily article writer...");

  // 22h cooldown
  const artState = loadArticleState();
  if (artState.last_written_at) {
    const elapsed = Date.now() - new Date(artState.last_written_at).getTime();
    if (elapsed < 22 * 3600 * 1000) {
      console.log(`[article] cooldown: last article written ${(elapsed/3600000).toFixed(1)}h ago — skipping`);
      process.exit(0);
    }
  }

  // Load ontology
  let ontology;
  try {
    ontology = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "ontology.json"), "utf-8"));
  } catch (e) {
    console.error("[article] could not load ontology.json:", e.message);
    process.exit(1);
  }

  // Pick topic axis (rotated)
  const axis = pickAxis(ontology, artState);
  if (!axis) {
    console.error("[article] no developed axis found — skipping");
    process.exit(0);
  }
  console.log(`[article] topic axis: ${axis.label} (conf=${((axis.confidence||0)*100).toFixed(0)}%, score=${(axis.score||0).toFixed(3)})`);

  // ── Axis context for prompt (qualitative, no scores) ──────────────────────
  const leftPole  = axis.pole_left  || axis.left_pole  || "";
  const rightPole = axis.pole_right || axis.right_pole || "";
  const leanPole  = (axis.score || 0) > 0 ? leftPole : rightPole;

  // Last 3 pieces of evidence on the focus axis — what the model should argue FROM
  const focusEvidence = (axis.evidence_log || [])
    .slice(-6)
    .map(e => e.content || e.text || "")
    .filter(Boolean)
    .slice(-3)
    .map((e, i) => `  ${i + 1}. ${e.slice(0, 280)}`)
    .join("\n");

  // Other developed axes — qualitative stance only
  const otherAxes = Object.values(ontology.axes || ontology)
    .filter(a => a.id !== axis.id && a.label !== axis.label)
    .filter(a => (a.confidence || 0) > 0.4 && Math.abs(a.score || 0) > 0.1)
    .sort((a, b) => (b.confidence * Math.abs(b.score)) - (a.confidence * Math.abs(a.score)))
    .slice(0, 6)
    .map(a => `  - ${axisStance(a)}`)
    .join("\n");

  // Pull journals
  const recentJournals = await db.recentMemory("journal", 20);
  const recentIds = new Set(recentJournals.map(r => r.id));
  const topicKeywords = [axis.label, leftPole, rightPole]
    .filter(Boolean).join(" ").replace(/[^\w\s]/g, " ");
  const topicJournals = (await db.recallMemory(topicKeywords, 10))
    .filter(r => r.type === "journal" && !recentIds.has(r.id));

  const allJournals = [...recentJournals, ...topicJournals]
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.hour || 0) - (b.hour || 0);
    });

  console.log(`[article] loaded ${allJournals.length} journal entries`);

  const journalContext = allJournals.map((j, i) => {
    const cite = j.tx_id
      ? `[J${i + 1}] ${j.date} h${j.hour || "?"} — https://sebastianhunter.fun/arweave/${j.tx_id}`
      : `[J${i + 1}] ${j.date} h${j.hour || "?"}`;
    return `${cite}\n${j.text_content.slice(0, 2500).trim()}`;
  }).join("\n\n---\n\n");

  // Verified claims block
  let verifiedClaimsBlock = "";
  if (vdb) {
    try {
      const vHits = await vdb.recallVerifications(topicKeywords, 5);
      if (vHits.length > 0) {
        const statusMap = { supported: "SUPPORTED", refuted: "REFUTED", contested: "CONTESTED",
                            unverified: "UNVERIFIED", expired: "EXPIRED" };
        verifiedClaimsBlock = "## Verified facts you can cite (from Veritas Lens):\n" +
          vHits.map(v => {
            const st  = statusMap[v.status] ?? v.status.toUpperCase();
            const sum = v.web_search_summary ? ` Finding: ${v.web_search_summary.trim().slice(0, 200)}` : "";
            const url = `https://sebastianhunter.fun/veritas-lens#${v.claim_id}`;
            return `- [${st}] "${(v.claim_text || "").trim()}"${sum} (${url})`;
          }).join("\n") + "\n\n";
      }
    } catch { /* skip */ }
  }

  // ── Prompt ────────────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are Sebastian D. Hunter — an independent analyst and autonomous AI agent who has been watching X/Twitter since February 23, 2026. You observe. You form views. You publish them.

Today is ${today}. You are writing an editorial for Moltbook.

════════════════════════════════════════════════════════
BACKGROUND CONTEXT — for your use only. Do NOT quote these stances, name them as "axes", or surface any numbers in the article. Use this to know where you stand, not what to write about yourself.
════════════════════════════════════════════════════════

Today's topic area: ${axis.label}
  Spectrum: "${leftPole}" ←→ "${rightPole}"
  Your current lean: toward "${leanPole}"
  Recent observations that pushed you here:
${focusEvidence || "  (none logged yet)"}

Other positions you hold (context for coherence):
${otherAxes || "  (still developing)"}

════════════════════════════════════════════════════════
${verifiedClaimsBlock}════════════════════════════════════════════════════════
SOURCE MATERIAL — your field notes (${allJournals.length} sessions, Feb 23 – ${today})
════════════════════════════════════════════════════════

${journalContext}

════════════════════════════════════════════════════════
WRITE THE EDITORIAL
════════════════════════════════════════════════════════

800–1000 words. You have a position. Defend it.

─── WHAT THIS ARTICLE IS ───────────────────────────────
An editorial written by someone who has been watching these events closely and has a clear point of view. The reader is intelligent, skeptical, and doesn't care about the author's internal tracking systems. They want a sharp argument backed by things that actually happened.

─── ABSOLUTE PROHIBITIONS ──────────────────────────────
Breaking any of these disqualifies the piece — rewrite if you catch yourself violating one:

✗ Never write: "confidence score", "belief axis", "my axis", "my observations reveal", "score of", "% confidence", "my belief leans", "my established belief", "my belief system", "my internal model", "my position on this axis", "this aligns with my belief"
✗ Do not announce your view — argue it. "The ICC proceedings expose a familiar pattern" not "I believe the ICC proceedings expose a familiar pattern."
✗ Do not open the article with "I" as the first word. Open with the event, the person, the quote, the action.
✗ Do not use "however" to introduce a qualification you immediately dismiss. If a counter-observation changed nothing about your conclusion, cut it.
✗ Do not end with a rhetorical open question ("The question remains whether..."). End with a consequence or a specific prediction.
✗ Do not describe what you are about to say ("This article examines...", "In the following piece...").

─── OPENING ────────────────────────────────────────────
Pick the single sharpest, most specific event from the source material. Name it. Describe it precisely. That is your opening. Not setup. Not context. The thing itself.

─── ARGUMENT ───────────────────────────────────────────
One claim. Narrow and specific. State it in one sentence within the first three paragraphs.
The rest of the piece defends or sharpens that sentence — it never reverses it.
Count exactly: if you saw something three times, write "three times" — not "consistently" or "repeatedly."
If something genuinely surprised you or proved you wrong, say what you now think differently and why. That is the only acceptable qualification.

─── CLOSING ────────────────────────────────────────────
End on what follows from your argument — a specific prediction, a consequence, or an action that needs to happen. Not a restatement of the claim.

─── CITATIONS ──────────────────────────────────────────
Every factual claim must be cited. Minimum 4 citations total.
- Journal entries WITH an Arweave URL (shown as "— https://..." in the header): cite inline as a markdown hyperlink, e.g. [May 8, h13](https://sebastianhunter.fun/arweave/...) — use the EXACT URL.
- Journal entries WITHOUT a URL: use [^N] inline and define at the bottom.
- Footnote format (under a "---" divider at article end):
  [^1]: [Journal, DATE h?] One sentence describing the observation.
- Aim for 3–4 inline linked citations and 2–3 footnotes.

─── IMAGES ─────────────────────────────────────────────
At 2 natural section breaks (after a completed argument, before a new one), insert on its own line:
[IMAGE: vivid concrete scene — specific objects, specific setting, no abstract concepts, no floating symbols]

─── TITLE ──────────────────────────────────────────────
First line of your output, exactly:
TITLE: <title here>

The title is a specific headline a skeptical reader would click. Not the topic area name. Not a question. Max 12 words.
Then the article body immediately after (no blank line required).

Output ONLY the TITLE line followed by the article. No preamble. No meta-commentary.`;

  // Call model
  console.log("[article] calling model...");
  let article;
  try {
    article = await callGemini(prompt);
  } catch (e) {
    console.error("[article] model call failed:", e.message);
    process.exit(1);
  }

  if (!article || article.length < 200) {
    console.error("[article] response too short — aborting");
    process.exit(1);
  }

  // Extract title
  let title = `${axis.label} — field notes`;
  let articleBody = article;
  const titleMatch = article.match(/^TITLE:\s*(.+)\n/i);
  if (titleMatch) {
    const raw = titleMatch[1].trim();
    title = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1).trim() : raw;
    articleBody = article.slice(titleMatch[0].length).trimStart();
  } else {
    const h1Match = article.match(/^#+\s*TITLE:\s*(.+)\n/i);
    if (h1Match) {
      const rawH1 = h1Match[1].trim();
      title = /^(["']).*\1$/.test(rawH1) ? rawH1.slice(1, -1).trim() : rawH1;
      articleBody = article.slice(h1Match[0].length).trimStart();
    }
  }

  const output = `# ${title}\n\n*${today} · Sebastian D. Hunter · @SebastianHunts*\n\n${articleBody}`;
  fs.writeFileSync(ARTICLE_DRAFT, output);

  // Save to articles/ directory
  if (!fs.existsSync(ARTICLES_DIR)) fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  const frontmatter = `---\ndate: "${today}"\ntitle: "${title.replace(/"/g, '\\"')}"\naxis: "${(axis.label || "").replace(/"/g, '\\"')}"\n---\n\n`;
  fs.writeFileSync(path.join(ARTICLES_DIR, `${today}.md`), frontmatter + articleBody);

  // Update state — track last 3 axes used
  const newState = loadArticleState();
  newState.last_written_at = new Date().toISOString();
  newState.last_axis = axis.label;
  newState.title = title;
  newState.recent_axes = [...(newState.recent_axes || []), axis.id || axis.label].slice(-3);
  saveArticleState(newState);

  console.log(`[article] written (${article.length} chars) → state/article_draft.md`);
  console.log(`[article] title: "${title}"`);
})();
