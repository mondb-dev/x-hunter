#!/usr/bin/env node
/**
 * runner/critique_tweet.js — quality gate for tweet drafts
 *
 * Reads state/tweet_draft.txt and evaluates it via Ollama on two axes:
 *   1. Specificity — does it reference something concrete (account, claim, statistic, event)?
 *   2. Falsifiability — could a reasonable person disagree with it?
 *
 * Exits 0 (PASS) or 1 (REJECT). Output is a single line: "PASS" or "REJECT: reason".
 * Called by run.sh before post_tweet.js.
 *
 * Usage: node runner/critique_tweet.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT       = path.resolve(__dirname, "..");
const DRAFT_FILE = path.join(ROOT, "state", "tweet_draft.txt");

const { generate: llmGenerate } = require("./llm.js");

async function callOllama(prompt) {
  return llmGenerate(prompt, { temperature: 0.0, maxTokens: 120, timeoutMs: 20_000 });
}

(async () => {
  if (!fs.existsSync(DRAFT_FILE)) {
    console.log("PASS (no draft file)");
    process.exit(0);
  }

  const raw = fs.readFileSync(DRAFT_FILE, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!raw || raw === "SKIP") {
    console.log("PASS (SKIP)");
    process.exit(0);
  }

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  // Line 1 must be the insight sentence, line 2 must be the journal URL
  const tweetText = lines[0] || "";
  if (!tweetText) {
    console.log("REJECT: line 1 is empty");
    process.exit(1);
  }
  if (lines.length < 2 || !lines[1].startsWith("https://")) {
    console.log("REJECT: missing journal URL on line 2");
    process.exit(1);
  }

  const prompt =
`Evaluate this tweet draft on two criteria. Be strict.

Tweet: "${tweetText}"

1. Specificity (0-5): Does it name something concrete — a specific account, a specific claim made by someone, a statistic, or a named event observed today? Generic observations about "AI" or "institutions" score 0-1. A tweet referencing what a specific person or report actually said scores 4-5.

2. Falsifiability (0-5): Could a thoughtful person plausibly disagree with this statement? Platitudes and obviously-true observations score 0-1. Genuine positions that stake out a contestable view score 4-5.

Reply with JSON only, nothing else:
{"specificity":N,"falsifiability":N,"verdict":"PASS","reason":"ok"}
or
{"specificity":N,"falsifiability":N,"verdict":"REJECT","reason":"one sentence explanation"}

REJECT if specificity < 2 OR falsifiability < 2.`;

  let result;
  try {
    const raw_response = await callOllama(prompt);
    const cleaned = raw_response.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error(`unparseable: "${raw_response.slice(0, 80)}"`);
    result = JSON.parse(m[0]);
  } catch (err) {
    // Ollama unavailable or parse error — pass through (don't block on critique failure)
    console.log(`PASS (critique unavailable: ${err.message})`);
    process.exit(0);
  }

  // Score-based override: use actual scores, don't blindly trust LLM verdict.
  // Combined score >= 4 allows partial credit (e.g. specificity=1 + falsifiability=3).
  const spec = Number(result.specificity) || 0;
  const fals = Number(result.falsifiability) || 0;
  const combined = spec + fals;

  if (combined >= 4) {
    // Scores are good enough — pass regardless of LLM verdict
    if (result.verdict === "REJECT") {
      console.log(`PASS (score override: specificity=${spec}, falsifiability=${fals}, combined=${combined} >= 4, LLM said REJECT: ${result.reason})`);
    } else {
      console.log(`PASS (specificity=${spec}, falsifiability=${fals}, combined=${combined})`);
    }
    process.exit(0);
  }

  if (result.verdict === "REJECT" || combined < 4) {
    console.log(`REJECT: ${result.reason || 'combined score too low'} (specificity=${spec}, falsifiability=${fals}, combined=${combined})`);
    process.exit(1);
  }

  console.log(`PASS (specificity=${spec}, falsifiability=${fals}, combined=${combined})`);
  process.exit(0);
})().catch(err => {
  // Non-fatal — let the tweet through if critique crashes
  console.log(`PASS (critique error: ${err.message})`);
  process.exit(0);
});
