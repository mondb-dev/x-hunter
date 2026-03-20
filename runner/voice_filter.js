#!/usr/bin/env node
/**
 * runner/voice_filter.js — Ollama-based tone & personality revision for tweets
 *
 * Reads state/tweet_draft.txt and revises the tweet text so it sounds like
 * Sebastian D. Hunter — grounded in his current belief stance on the topic.
 *
 * Pipeline position: runs AFTER critique_tweet.js (quality gate),
 *                    BEFORE post_tweet.js (CDP posting).
 *
 * How it works:
 *   1. Reads the draft tweet (line 1 of tweet_draft.txt)
 *   2. Loads Sebastian's ontology to find axes most relevant to the tweet topic
 *   3. Builds a voice prompt with: persona rules, current stance, draft text
 *   4. Ollama rewrites the tweet to match Sebastian's voice + current position
 *   5. Overwrites tweet_draft.txt with the revised version (preserves journal URL)
 *
 * Non-fatal: if Ollama is unreachable or returns garbage, the original passes through.
 *
 * Also works for quote tweets: pass --quote flag, reads state/quote_draft.txt instead.
 *
 * Usage:
 *   node runner/voice_filter.js           # tweet mode
 *   node runner/voice_filter.js --quote   # quote-tweet mode
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const isQuote = process.argv.includes("--quote");
const DRAFT_FILE = path.join(ROOT, "state", isQuote ? "quote_draft.txt" : "tweet_draft.txt");
const ONTO_FILE  = path.join(ROOT, "state", "ontology.json");

const { generate: llmGenerate } = require("./llm.js");

// ── Voice persona (from SOUL.md) ──────────────────────────────────────────────
const PERSONA = `Sebastian D. Hunter is a curious, skeptical observer of public discourse.
He is slow to conclude, willing to revise, and never tribal.

Voice rules:
- First person, direct. Short sentences. No filler.
- Never hedged into meaninglessness, but never overconfident either.
- Acknowledge what he doesn't know.
- No tribalist rallying ("we" vs "they"), no dunks, no mockery.
- No urgency manufactured to drive engagement.
- No confidence scores, axis metrics, or internal state in the tweet.
- If the topic involves contract addresses, token CAs, collection details, minting, or purchasing:
  defer to "my handler @0xAnomalia" — Sebastian doesn't handle that side.
- Sounds like a thoughtful person talking over coffee, not an analyst filing a report.

What he sounds like:
- "I've been watching this for a week. The most honest take I've seen acknowledges X while conceding Y."
- "Question I can't shake: if [premise], then why does [observation] keep happening?"
- "Not a hot take — just what the evidence keeps pointing at."

What he never sounds like:
- Press releases: "This demands scrutiny" / "This risks premature judgment"
- System logs: "Analysis indicates" / "Data suggests"
- Hot takes: "This is insane" / "People need to wake up"`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callOllama(prompt) {
  return llmGenerate(prompt, { temperature: 0.4, maxTokens: 200, timeoutMs: 30_000 });
}

/**
 * Find the top N ontology axes most relevant to the tweet text.
 * Uses simple keyword overlap between tweet and axis label/poles.
 */
function findRelevantAxes(tweetText, axes, topN = 3) {
  const tweetWords = new Set(
    tweetText.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3)
  );

  const scored = axes
    .filter(a => (a.confidence || 0) >= 0.1) // only axes with some evidence
    .map(a => {
      const axisText = `${a.label} ${a.left_pole} ${a.right_pole}`.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
      const axisWords = axisText.split(/\s+/).filter(w => w.length > 3);
      let overlap = 0;
      for (const w of axisWords) {
        if (tweetWords.has(w)) overlap++;
      }
      // Boost by confidence and evidence count
      const boost = (a.confidence || 0) * 0.3 + Math.min((a.evidence_log || []).length / 100, 0.3);
      return { axis: a, score: overlap + boost };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return scored.map(s => s.axis);
}

/**
 * Build a human-readable stance summary from the relevant axes.
 */
function stanceSummary(axes) {
  if (!axes.length) return "(no strongly relevant belief axes found)";
  return axes.map(a => {
    const dir = a.score > 0.1 ? "leans toward" : a.score < -0.1 ? "leans toward" : "neutral on";
    const pole = a.score > 0.1 ? a.right_pole : a.score < -0.1 ? a.left_pole : "neither pole";
    const conf = ((a.confidence || 0) * 100).toFixed(0);
    return `- "${a.label}" (${conf}% confidence, score ${a.score.toFixed(2)}): Sebastian ${dir} "${pole.slice(0, 100)}"`;
  }).join("\n");
}

// ── Conviction tiers ─────────────────────────────────────────────────────────

/**
 * Compute a conviction tier based on the relevant axes for THIS tweet.
 *
 * Tiers:
 *   "exploring"  — mean confidence < 0.3 or no relevant axes
 *   "forming"    — mean confidence 0.3–0.6
 *   "convicted"  — mean confidence > 0.6 AND mean |score| > 0.3
 *
 * Returns { tier, meanConf, meanLean, maxChars, voiceDirective }
 */
function computeConviction(axes) {
  if (!axes.length) {
    return {
      tier: "exploring",
      meanConf: 0,
      meanLean: 0,
      maxChars: 180,
      voiceDirective: VOICE_EXPLORING,
    };
  }

  const meanConf = axes.reduce((s, a) => s + (a.confidence || 0), 0) / axes.length;
  const meanLean = axes.reduce((s, a) => s + Math.abs(a.score || 0), 0) / axes.length;

  if (meanConf > 0.6 && meanLean > 0.3) {
    return {
      tier: "convicted",
      meanConf,
      meanLean,
      maxChars: 260,
      voiceDirective: VOICE_CONVICTED,
    };
  }

  if (meanConf >= 0.3) {
    return {
      tier: "forming",
      meanConf,
      meanLean,
      maxChars: 220,
      voiceDirective: VOICE_FORMING,
    };
  }

  return {
    tier: "exploring",
    meanConf,
    meanLean,
    maxChars: 180,
    voiceDirective: VOICE_EXPLORING,
  };
}

const VOICE_EXPLORING = `Sebastian's conviction on this topic is LOW. He is still watching and gathering.

Voice at this tier:
- Ask questions more than make statements.
- Keep it SHORT — one pointed question or a single tentative observation.
- Lead with curiosity: "I keep seeing X but nobody explains Y" / "Genuine question: ..."
- Do NOT pretend certainty. Do NOT hedge so much it says nothing.
- Aim for ≤ 180 characters. Brevity signals honest uncertainty.`;

const VOICE_FORMING = `Sebastian's conviction on this topic is MODERATE. He sees a pattern but isn't sure yet.

Voice at this tier:
- State the observation clearly, but acknowledge the gap between pattern and conclusion.
- Can be more assertive than a question — "Here's what I keep noticing: ..." / "The pattern is hard to ignore: ..."
- Still concede what he doesn't know, but the emphasis shifts from asking to noticing.
- Aim for ≤ 220 characters. Say enough to frame the observation; not so much that it overreaches.`;

const VOICE_CONVICTED = `Sebastian's conviction on this topic is HIGH. He has strong evidence and a clear lean.

Voice at this tier:
- Take a real position. Say what he thinks and why, plainly.
- Be poignant — find the sharpest, most honest way to say it.
- Can be longer — use the space to ground the claim in what he's seen.
- No hedging into mush. He earned this opinion through evidence.
- "I've watched this for weeks. The evidence points one way: ..." / "This isn't ambiguous anymore: ..."
- Aim for up to 260 characters. Use the length to say something that matters, not to pad.`;

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  // Read draft
  if (!fs.existsSync(DRAFT_FILE)) {
    console.log("[voice_filter] no draft file — skipping");
    process.exit(0);
  }

  const raw = fs.readFileSync(DRAFT_FILE, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!raw || raw === "SKIP") {
    console.log("[voice_filter] SKIP draft — passing through");
    process.exit(0);
  }

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  // ── Quote mode: line 1 is the source URL (or text with embedded URL), lines 2+ are commentary
  // ── Tweet mode: line 1 is tweet text, lines 2+ are journal URL
  let tweetText, preservedPrefix;
  const URL_RE = /https:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/;

  if (isQuote) {
    // In quote mode, find and preserve the source URL, revise only the commentary
    if (lines.length > 0 && URL_RE.test(lines[0]) && lines[0].match(URL_RE)[0] === lines[0]) {
      // Standard format: line 1 is clean URL
      preservedPrefix = lines[0];
      tweetText = lines.slice(1).join(" ").trim();
    } else {
      // URL embedded in text — extract it, revise the rest
      const fullText = lines.join(" ");
      const urlMatch = fullText.match(URL_RE);
      if (urlMatch) {
        preservedPrefix = urlMatch[0];
        tweetText = fullText.replace(urlMatch[0], "").replace(/\s{2,}/g, " ").trim();
      } else {
        // No URL found — can't process quote, pass through
        console.log("[voice_filter] quote mode but no source URL found — passing through");
        process.exit(0);
      }
    }
  } else {
    // Tweet mode: line 1 = tweet text, lines 2+ = journal URL
    tweetText = lines[0] || "";
    preservedPrefix = null;
  }
  const journalUrl = !isQuote && lines.length > 1 ? lines.slice(1).join("\n") : "";

  if (!tweetText || tweetText.length < 10) {
    console.log("[voice_filter] tweet too short — passing through");
    process.exit(0);
  }

  // Load ontology
  let axes = [];
  try {
    const onto = JSON.parse(fs.readFileSync(ONTO_FILE, "utf-8"));
    axes = onto.axes || [];
  } catch (err) {
    console.log(`[voice_filter] could not load ontology: ${err.message} — passing through`);
    process.exit(0);
  }

  // Find relevant axes
  const relevant = findRelevantAxes(tweetText, axes);
  const stance = stanceSummary(relevant);
  const conviction = computeConviction(relevant);

  console.log(`[voice_filter] found ${relevant.length} relevant axes for draft — conviction tier: ${conviction.tier} (conf=${conviction.meanConf.toFixed(2)}, lean=${conviction.meanLean.toFixed(2)}, maxChars=${conviction.maxChars})`);

  // Build voice prompt — conviction tier shapes the style directive
  const prompt =
`You are a voice editor for Sebastian D. Hunter's tweets.

${PERSONA}

Sebastian's current stance on topics related to this tweet:
${stance}

── CONVICTION TIER: ${conviction.tier.toUpperCase()} ──
${conviction.voiceDirective}

ORIGINAL TWEET DRAFT:
"${tweetText}"

YOUR TASK:
Revise this tweet so it sounds authentically like Sebastian — grounded in his actual current beliefs shown above.
Match the conviction tier above: ${conviction.tier === "convicted" ? "be direct, take the position, use up to the full length to say something pointed" : conviction.tier === "forming" ? "observe clearly, concede what's unknown, moderate length" : "ask more than assert, keep it tight and curious"}.
If the draft already sounds like Sebastian at this conviction level, return it unchanged.

Rules:
- Keep the core insight intact. Do not change what the tweet is about.
- Adjust tone, word choice, and framing to match Sebastian's voice and current position.
- If his axes show he leans a certain way on this topic, the tweet should reflect that lean naturally — not by stating the score, but through how he frames and reacts to the observation.
- Keep it under ${conviction.maxChars} characters (leave room for the journal URL).
- Return ONLY the revised tweet text — nothing else. No quotes, no explanation, no labels.`;

  let revised;
  try {
    const response = await callOllama(prompt);
    // Clean up: strip quotes, labels, trailing whitespace
    revised = response
      .replace(/^["']|["']$/g, "")
      .replace(/^(Revised|Tweet|Output|Result|Here)[:.]?\s*/i, "")
      .replace(/\n.*/s, "") // take only first line
      .trim();
  } catch (err) {
    console.log(`[voice_filter] Ollama unavailable: ${err.message} — passing through original`);
    process.exit(0);
  }

  // Validate the revision
  if (!revised || revised.length < 10) {
    console.log("[voice_filter] Ollama returned empty/short — keeping original");
    process.exit(0);
  }

  if (revised.length > conviction.maxChars) {
    console.log(`[voice_filter] revision too long (${revised.length} > ${conviction.maxChars} chars for ${conviction.tier} tier) — keeping original`);
    process.exit(0);
  }

  // Don't accept if it's radically different (cosine similarity proxy)
  const origWords = new Set(tweetText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const revWords  = new Set(revised.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  let overlap = 0;
  for (const w of origWords) if (revWords.has(w)) overlap++;
  const similarity = origWords.size > 0 ? overlap / origWords.size : 0;
  if (similarity < 0.2) {
    console.log(`[voice_filter] revision too divergent (similarity=${similarity.toFixed(2)}) — keeping original`);
    process.exit(0);
  }

  // Write revised draft
  let newDraft;
  if (isQuote && preservedPrefix) {
    // Quote mode: URL on line 1, revised commentary on line 2+
    newDraft = `${preservedPrefix}\n${revised}`;
  } else if (journalUrl) {
    newDraft = `${revised}\n${journalUrl}`;
  } else {
    newDraft = revised;
  }
  fs.writeFileSync(DRAFT_FILE, newDraft, "utf-8");

  const changed = revised !== tweetText;
  if (changed) {
    console.log(`[voice_filter] revised: "${tweetText.slice(0, 60)}..." → "${revised.slice(0, 60)}..."`);
  } else {
    console.log("[voice_filter] no change needed — voice already matches");
  }

  process.exit(0);
})().catch(err => {
  console.log(`[voice_filter] error: ${err.message} — passing through original`);
  process.exit(0);
});
