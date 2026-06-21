#!/usr/bin/env node
"use strict";
/**
 * runner/adversarial_eval.js — adversarial evaluator for published posts
 *
 * Runs after each TWEET cycle. Evaluates the post from a skeptical perspective
 * using Ollama (local model — different evaluator from Gemini, surfaces systematic bias).
 *
 * Checks:
 *   1. FACTUAL_CLAIM — does the post make a specific factual claim?
 *   2. EVIDENCE_GROUNDED — is the claim grounded in the observed evidence log?
 *   3. COUNTER_ARGUMENT — what is the strongest plausible counter-argument?
 *   4. OVERCLAIM — does the post assert more certainty than the evidence supports?
 *   5. AXIS_MATCH — does the post position match the relevant axis score direction?
 *
 * Outputs:
 *   state/adversarial_eval_log.jsonl  — one entry per evaluated post
 *   state/adversarial_eval_last.json  — last evaluation (for next browse cycle context)
 *
 * Flags posts with OVERCLAIM=true or AXIS_MATCH=false into the eval log.
 * These are surfaced in the next browse cycle via context.js.
 *
 * Usage:
 *   node runner/adversarial_eval.js              # evaluate last post
 *   node runner/adversarial_eval.js --dry-run    # print result, no write
 *   node runner/adversarial_eval.js --post-id <id>
 */

const fs   = require("fs");
const path = require("path");

const ROOT          = path.resolve(__dirname, "..");
const STATE         = path.join(ROOT, "state");
const POSTS_LOG     = path.join(STATE, "posts_log.json");
const ONTOLOGY_PATH = path.join(STATE, "ontology.json");
const EVAL_LOG      = path.join(STATE, "adversarial_eval_log.jsonl");
const EVAL_LAST     = path.join(STATE, "adversarial_eval_last.json");

const isDryRun  = process.argv.includes("--dry-run");
const postIdArg = (() => { const i = process.argv.indexOf("--post-id"); return i !== -1 ? process.argv[i+1] : null; })();

// Cooldown: max one eval per 2h to avoid Ollama queue backup
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const STAMP       = path.join(STATE, ".last_adversarial_eval");

function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } }
function today()     { return new Date().toISOString(); }

// ── Cooldown check ────────────────────────────────────────────────────────────
if (!isDryRun && !postIdArg) {
  try {
    const lastMs = new Date(fs.readFileSync(STAMP, "utf-8").trim()).getTime();
    if (Date.now() - lastMs < COOLDOWN_MS) {
      console.log("[adversarial_eval] cooldown — skipping");
      process.exit(0);
    }
  } catch { /* first run */ }
}

// ── Load last post ────────────────────────────────────────────────────────────
function getTargetPost() {
  const log = loadJson(POSTS_LOG);
  if (!log?.posts?.length) return null;
  if (postIdArg) return log.posts.find(p => p.id === postIdArg || p.tweet_url?.includes(postIdArg)) || null;
  // Most recent original tweet (not quote, not signal)
  return [...log.posts].reverse().find(p => (p.type || "tweet") === "tweet") || null;
}

// ── Load relevant axes ────────────────────────────────────────────────────────
function getTopAxes(n = 5) {
  const onto = loadJson(ONTOLOGY_PATH);
  if (!onto?.axes) return [];
  const axes = Array.isArray(onto.axes) ? onto.axes : Object.values(onto.axes);
  return axes
    .filter(a => a.confidence > 0.5)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, n)
    .map(a => ({
      id:    a.id,
      label: a.label || a.name || a.id,
      score: a.score || 0,
      conf:  a.confidence || 0,
      stance: a.current_stance || null,
    }));
}

// ── Ollama call ───────────────────────────────────────────────────────────────
async function callOllama(prompt) {
  const { execSync } = require("child_process");
  const model = process.env.OLLAMA_MODEL || "qwen2.5:7b";

  try {
    const payload = JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1, num_predict: 400 } });
    const result = execSync(
      `curl -s http://localhost:11434/api/generate -d '${payload.replace(/'/g, "'\\''")}'`,
      { timeout: 45_000, encoding: "utf-8" }
    );
    const parsed = JSON.parse(result);
    return parsed.response?.trim() || "";
  } catch (e) {
    console.warn("[adversarial_eval] Ollama unavailable:", e.message.slice(0, 80));
    return null;
  }
}

// ── Parse evaluation response ─────────────────────────────────────────────────
function parseEval(raw) {
  if (!raw) return null;
  const lines = raw.split("\n");
  const get = (key) => {
    const line = lines.find(l => l.toUpperCase().startsWith(key.toUpperCase() + ":"));
    return line ? line.slice(key.length + 1).trim() : null;
  };
  return {
    factual_claim:    get("FACTUAL_CLAIM"),
    evidence_grounded: /yes|grounded|supported/i.test(get("EVIDENCE_GROUNDED") || ""),
    counter_argument:  get("COUNTER_ARGUMENT"),
    overclaim:        /yes|overclaim|overstates/i.test(get("OVERCLAIM") || ""),
    axis_match:       !/no|mismatch|contradicts/i.test(get("AXIS_MATCH") || "yes"),
    raw,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const post = getTargetPost();
  if (!post) { console.log("[adversarial_eval] no target post found"); process.exit(0); }

  const axes = getTopAxes(5);
  const axesBlock = axes.map(a => {
    const dir = a.score > 0.1 ? "→" : a.score < -0.1 ? "←" : "·";
    return `  ${dir} ${a.label} (${(a.conf * 100).toFixed(0)}% conf, score ${a.score.toFixed(3)})${a.stance ? ` — "${a.stance}"` : ""}`;
  }).join("\n");

  const prompt = `You are a skeptical fact-checker evaluating an AI agent's published post.
Be adversarial but fair. Your job is to find weaknesses.

POST:
"${(post.content || post.text || "").slice(0, 280)}"

AGENT'S CURRENT BELIEF AXES (what the agent claims to believe):
${axesBlock || "(no axes available)"}

Evaluate the post on these dimensions. Be brief and specific.

FACTUAL_CLAIM: [State the specific factual claim made, or "opinion/observation only" if no factual claim]
EVIDENCE_GROUNDED: [Yes/No — does the claim follow from the axes and evidence above, or does it assert more than the axes support?]
COUNTER_ARGUMENT: [One sentence — the strongest plausible counter-argument a well-informed skeptic would make]
OVERCLAIM: [Yes/No — does the post assert more certainty or specificity than the evidence warrants?]
AXIS_MATCH: [Yes/No — is the post's position consistent with the relevant axis direction?]`;

  console.log(`[adversarial_eval] evaluating post: "${(post.content || "").slice(0, 60)}..."`);

  const raw    = await callOllama(prompt);
  const result = parseEval(raw);

  if (!result) {
    console.log("[adversarial_eval] Ollama unavailable — skipping");
    process.exit(0);
  }

  const entry = {
    ts:               today(),
    post_id:          post.id || post.tweet_url,
    post_text:        (post.content || "").slice(0, 280),
    post_type:        post.type || "tweet",
    factual_claim:    result.factual_claim,
    evidence_grounded: result.evidence_grounded,
    counter_argument: result.counter_argument,
    overclaim:        result.overclaim,
    axis_match:       result.axis_match,
    flagged:          result.overclaim || !result.axis_match,
    raw_eval:         raw,
  };

  if (isDryRun) {
    console.log("\n[adversarial_eval] DRY RUN result:");
    console.log(JSON.stringify(entry, null, 2));
    process.exit(0);
  }

  fs.appendFileSync(EVAL_LOG, JSON.stringify(entry) + "\n");
  fs.writeFileSync(EVAL_LAST, JSON.stringify(entry, null, 2));
  fs.writeFileSync(STAMP, new Date().toISOString());

  const flag = entry.flagged ? " ⚠️  FLAGGED" : " ✓";
  console.log(`[adversarial_eval] done.${flag}`);
  if (entry.overclaim)  console.log(`  overclaim: yes — "${result.counter_argument}"`);
  if (!entry.axis_match) console.log(`  axis mismatch: post position inconsistent with axes`);
})().catch(err => {
  console.error("[adversarial_eval] error:", err.message);
  process.exit(0);
});
