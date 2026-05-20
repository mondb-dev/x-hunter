#!/usr/bin/env node
// runner/write_article.js — daily long-form article writer (two-stage)
//
// Stage 1 (synthesize_case.js): pick the concrete current case for the axis,
//   produce a belief-agnostic structured brief (chronology, actors, verified
//   facts, disputed claims, competing frames). Wire-service voice.
//
// Stage 2 (this file): load Sebastian's prose convictions + vocation, hand
//   them the synthesis as ground truth, ask for an editorial. Convictions
//   shape the *commentary*; synthesis pins the *facts*. The model cannot
//   retrieve its own evidence — it can only argue from the brief.
//
// CLI flags:
//   --force                bypass 22h cooldown
//   --axis=<axis_id>       override axis selection
//   --target-date=YYYY-MM-DD  write under this date (overwrites articles/<date>.md)
//   --case-seed="..."      force the case (skips identifyCase); also seeds topic recall
//
// Run: node runner/write_article.js [--force] [--axis=axis_id] [--target-date=YYYY-MM-DD]

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { loadScraperDb } = require("./lib/db_backend");
const db = loadScraperDb();

const { synthesizeCase, renderSynthesisForPrompt } = require("./lib/synthesize_case.js");
const { buildConvictions } = require("./lib/convictions.js");
const { callVertex } = require("./vertex.js");

// ── Env ───────────────────────────────────────────────────────────────────────
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const FLAGS = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const ARTICLE_DRAFT = path.join(ROOT, "state", "article_draft.md");
const ARTICLE_STATE = path.join(ROOT, "state", "article_state.json");
const ARTICLES_DIR  = path.join(ROOT, "articles");
const ONTOLOGY      = path.join(ROOT, "state", "ontology.json");
const VOCATION      = path.join(ROOT, "state", "vocation.json");

function loadJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

function loadArticleState() {
  return loadJSON(ARTICLE_STATE) || { last_written_at: null, last_axis: null, recent_axes: [] };
}

function saveArticleState(s) {
  fs.writeFileSync(ARTICLE_STATE, JSON.stringify(s, null, 2));
}

function pickAxis(ontology, artState, override) {
  const axes = Object.values(ontology.axes || ontology);
  if (override) {
    const hit = axes.find(a => a.id === override || a.label === override);
    if (hit) return hit;
    console.warn(`[article] --axis "${override}" not found, falling back to rotation`);
  }
  const candidates = axes
    .filter(a => (a.confidence || 0) > 0.3 && Math.abs(a.score || 0) > 0.1)
    .sort((a, b) => (b.confidence * Math.abs(b.score)) - (a.confidence * Math.abs(a.score)));

  const top5 = candidates.slice(0, 5);
  const recentlyUsed = new Set(artState.recent_axes || []);
  const fresh = top5.filter(a => !recentlyUsed.has(a.id || a.label));
  return (fresh.length > 0 ? fresh : top5)[0] || candidates[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[article] starting two-stage article writer...");

  const targetDate = FLAGS["target-date"] || new Date().toISOString().slice(0, 10);
  const force = !!FLAGS.force;

  // 22h cooldown (unless --force)
  const artState = loadArticleState();
  if (!force && artState.last_written_at) {
    const elapsed = Date.now() - new Date(artState.last_written_at).getTime();
    if (elapsed < 22 * 3600 * 1000) {
      console.log(`[article] cooldown: last article ${(elapsed/3600000).toFixed(1)}h ago — skipping (use --force to override)`);
      process.exit(0);
    }
  }

  const ontology = loadJSON(ONTOLOGY);
  if (!ontology) { console.error("[article] no ontology.json"); process.exit(1); }
  const vocation = loadJSON(VOCATION) || {};

  // ── Pick axis (hybrid: top-confidence rotation; --axis overrides) ─────────
  const axis = pickAxis(ontology, artState, FLAGS.axis);
  if (!axis) { console.error("[article] no developed axis"); process.exit(0); }
  console.log(`[article] axis: ${axis.label} (conf=${((axis.confidence||0)*100).toFixed(0)}%, score=${(axis.score||0).toFixed(3)})`);

  // ── Pull source material ──────────────────────────────────────────────────
  const leftPole  = axis.left_pole  || axis.pole_left  || "";
  const rightPole = axis.right_pole || axis.pole_right || "";
  const caseSeed = FLAGS["case-seed"] || null;
  const seedKeywords = caseSeed ? String(caseSeed) : "";
  const topicKeywords = [seedKeywords, axis.label, leftPole, rightPole].filter(Boolean).join(" ").replace(/[^\w\s]/g, " ");

  const recentJournals = await db.recentMemory("journal", 20);
  const recentIds = new Set(recentJournals.map(r => r.id));
  // If a case seed is provided, pull more topic-matched journals (case may not be in last 20).
  const topicLimit = caseSeed ? 40 : 15;
  const topicJournals = (await db.recallMemory(topicKeywords, topicLimit))
    .filter(r => r.type === "journal" && !recentIds.has(r.id));
  const journals = [...recentJournals, ...topicJournals]
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.hour||0) - (b.hour||0));
  console.log(`[article] loaded ${journals.length} journal entries`);

  let discourseDigest = "";
  try { discourseDigest = fs.readFileSync(path.join(ROOT, "state", "discourse_digest.txt"), "utf-8"); } catch {}
  let feedDigest = "";
  try { feedDigest = fs.readFileSync(path.join(ROOT, "state", "feed_digest.txt"), "utf-8"); } catch {}

  // ── Stage 1: synthesize the case (belief-agnostic) ────────────────────────
  let synthesis;
  try {
    synthesis = await synthesizeCase({
      topic: axis.label,
      axisId: axis.id,
      journals,
      discourseDigest,
      feedDigest,
      caseSeed,
      useCache: !force,
    });
  } catch (e) {
    console.error("[article] synthesis failed:", e.message);
    process.exit(1);
  }
  console.log(`[article] synthesized case: ${synthesis.event_headline}`);

  // ── Stage 2: convictions (prose, derived from axes + vocation) ────────────
  const convictions = buildConvictions({ ontology, vocation });

  // ── Composition prompt ────────────────────────────────────────────────────
  const synthBlock = renderSynthesisForPrompt(synthesis);
  const prompt = `You are Sebastian D. Hunter, an independent analyst and autonomous AI agent who has been watching X/Twitter since February 23, 2026. Today is ${targetDate}. You are writing an editorial for Moltbook.

════════════════════════════════════════════════════════
YOUR CONVICTIONS (this is who you are — your voice, your priors)
════════════════════════════════════════════════════════
${convictions || '(still forming)'}

════════════════════════════════════════════════════════
THE CASE (a neutral brief assembled by a reporter — this is the ground truth you may work from)
════════════════════════════════════════════════════════
${synthBlock}

════════════════════════════════════════════════════════
WRITE THE EDITORIAL
════════════════════════════════════════════════════════

800–1000 words. The case above is the *only* factual material you may use. Do not invent events, actors, dates, or quotes that are not in the brief.

─── HOW THIS PIECE WORKS ────────────────────────────────
The brief tells you what happened. Your convictions tell you what you make of it. The editorial is the meeting of those two — your honest read of this specific case, grounded in what you actually value.

Stay close to the brief. If the brief says actor X did Y, do not write that X "appeared to" do Y or "framed it as" Y. Y is what happened. If the chronology shows the OSG opposing a block, the OSG opposed the block — describe that plainly before commenting on it.

The brief lists competing frames. Engage the one that genuinely challenges your read, if any does. Do not pretend it is not there. If your convictions still hold after engaging it, say so and why. If they shift, say that.

─── ABSOLUTE PROHIBITIONS ──────────────────────────────
✗ Never write: "confidence score", "belief axis", "my axis", "% confidence", "my belief leans", "my established belief", "my internal model", "this aligns with my belief"
✗ Do not announce your view — argue it.
✗ Do not invert what the brief says actually happened to fit a frame. If the brief shows actor X opposing Y, you cannot recast X as defending Y. The brief is the floor.
✗ Do not open with "I" as the first word. Open with the event itself.
✗ Do not end with a rhetorical open question. End on a specific consequence or prediction.
✗ Do not describe what you are about to say ("This article examines...").

─── OPENING ────────────────────────────────────────────
Open with the sharpest, most specific moment from the chronology. Name actors and dates. That is your lede.

─── ARGUMENT ───────────────────────────────────────────
One claim. Stated in one sentence within the first three paragraphs. The rest defends or sharpens that claim. Count exactly — if the brief shows three instances, write "three"; if two, write "two."

─── CLOSING ────────────────────────────────────────────
End on what follows: a specific prediction, a consequence, an action that needs to happen.

─── CITATIONS ──────────────────────────────────────────
- Inline-link factual claims to their source_url from the brief: [date](url).
- Never invent a URL. Never reuse a URL across distinct events. If the brief gives no source_url for an event, do not link it — either use a footnote or do not assert it.
- For verified facts in the brief, the citation rules in the brief apply absolutely:
  - SUPPORTED → cite plainly with [Veritas Lens](lens_url).
  - UNVERIFIED / CONTESTED / EXPIRED → qualify the claim ("reportedly", "Amnesty International reported", "Iran alleges") AND cite Lens. Do not write as confirmed fact.
  - REFUTED → do not assert; mention only as a debunked claim.
- Use footnotes [^N] for items without a URL; define under "---" at the end.
- Aim for 4+ citations total.

─── IMAGES ─────────────────────────────────────────────
At 2 natural section breaks, on their own line:
[IMAGE: vivid concrete scene — specific objects, specific setting, no abstract concepts]

─── TITLE ──────────────────────────────────────────────
First line, exactly:
TITLE: <title here>
Specific headline a skeptical reader would click. Max 12 words. Not the topic. Not a question.

Output ONLY the TITLE line followed by the article. No preamble.`;

  console.log("[article] composing editorial...");
  let article;
  try {
    article = await callVertex(prompt, 16384, { thinkingBudget: 8192 });
  } catch (e) {
    console.error("[article] composition failed:", e.message);
    process.exit(1);
  }

  if (!article || article.length < 200) {
    console.error("[article] response too short");
    process.exit(1);
  }

  // ── Title extraction ──────────────────────────────────────────────────────
  let title = synthesis.event_headline || axis.label;
  let body = article;
  const titleMatch = article.match(/^TITLE:\s*(.+)\n/i);
  if (titleMatch) {
    const raw = titleMatch[1].trim();
    title = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1).trim() : raw;
    body = article.slice(titleMatch[0].length).trimStart();
  }

  // ── Write outputs ─────────────────────────────────────────────────────────
  const draftContent = `# ${title}\n\n*${targetDate} · Sebastian D. Hunter · @SebastianHunts*\n\n${body}`;
  fs.writeFileSync(ARTICLE_DRAFT, draftContent);

  if (!fs.existsSync(ARTICLES_DIR)) fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  const fm = `---\ndate: "${targetDate}"\ntitle: "${title.replace(/"/g, '\\"')}"\naxis: "${(axis.label || "").replace(/"/g, '\\"')}"\ncase_slug: "${synthesis.case_slug}"\n---\n\n`;
  fs.writeFileSync(path.join(ARTICLES_DIR, `${targetDate}.md`), fm + body);

  // ── State update ──────────────────────────────────────────────────────────
  if (!FLAGS["target-date"]) {
    const newState = loadArticleState();
    newState.last_written_at = new Date().toISOString();
    newState.last_axis = axis.label;
    newState.last_case_slug = synthesis.case_slug;
    newState.title = title;
    newState.recent_axes = [...(newState.recent_axes || []), axis.id || axis.label].slice(-3);
    saveArticleState(newState);
  }

  console.log(`[article] written (${article.length} chars)`);
  console.log(`[article] title: "${title}"`);
  console.log(`[article] case:  ${synthesis.case_slug}`);
  console.log(`[article] file:  articles/${targetDate}.md`);
})();
