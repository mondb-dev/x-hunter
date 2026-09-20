"use strict";
/**
 * runner/lib/posting_gate.js — whether there is anything worth posting.
 *
 * The cycle scheduler posts on a clock: every TWEET_EVERY cycles it composes
 * something, and the prompts treat SKIP as a failure to meet requirements
 * rather than a legitimate answer. That is a quota, and a quota is how an agent
 * ends up narrating its feed to fill airtime.
 *
 * Under a research agenda the rule is simpler: he posts when he has something
 * he established — a finding from his own research, a published brief, an
 * experiment result — and otherwise says nothing. Silence is not a failed
 * cycle. There is no minimum.
 *
 * This is the mechanical half; the prompts carry the same rule in words. Doing
 * it here also saves the compose → critique → voice-filter chain on a cycle
 * that was never going to publish.
 *
 * POSTING_GATE=off disables it (back to posting on the clock).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "state");

/** Notes the writing layer leaves for itself when something publishable lands. */
const SHARE_MARKERS = ["[SOLUTION", "[EXPERIMENT"];

function readJson(p, fb = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; }
}

/** When he last broadcast anything (not replies — those answer someone else). */
function lastBroadcastAt() {
  const d = readJson(path.join(STATE, "posts_log.json"), []);
  const rows = Array.isArray(d) ? d : (d.posts || []);
  const kinds = new Set(["tweet", "quote", "thread", "thread_reply", "prediction", "linkedin_post", "article"]);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] || {};
    if (!kinds.has(r.type)) continue;
    const ts = r.posted_at || r.ts || r.date;
    if (ts) return new Date(ts).getTime();
  }
  return 0;
}

/**
 * @returns {{ok: boolean, reason: string, newFindings: number, pendingShare: boolean}}
 */
function somethingToSay() {
  if (String(process.env.POSTING_GATE || "").toLowerCase() === "off") {
    return { ok: true, reason: "POSTING_GATE=off", newFindings: 0, pendingShare: false };
  }
  let agenda = null;
  try { agenda = require("./research_agenda").getAgenda(); } catch { /* none */ }
  // No agenda → emergent behavior is unchanged; this gate is an agenda rule.
  if (!agenda) return { ok: true, reason: "no research agenda", newFindings: 0, pendingShare: false };

  const since = lastBroadcastAt();

  // Anything he established since the last broadcast: a research finding, a
  // brief (published or withheld — a withheld one is worth saying out loud),
  // or an experiment result.
  let newFindings = 0;
  try {
    newFindings = require("./knowledge_base").readAll()
      .filter((r) => new Date(r.ts || 0).getTime() > since).length;
  } catch { /* no knowledge base yet */ }

  // A brief or experiment that explicitly asked to be shared this cycle.
  let pendingShare = false;
  try {
    const notes = fs.readFileSync(path.join(STATE, "browse_notes.md"), "utf-8");
    pendingShare = SHARE_MARKERS.some((m) => notes.includes(m));
  } catch { /* no notes */ }

  if (pendingShare) return { ok: true, reason: "a published brief or experiment result is waiting to be shared", newFindings, pendingShare };
  if (newFindings > 0) return { ok: true, reason: `${newFindings} new finding(s) since the last post`, newFindings, pendingShare };
  return {
    ok: false,
    reason: since
      ? "nothing established since the last post — saying nothing is the right answer"
      : "nothing established yet — nothing to say",
    newFindings: 0,
    pendingShare: false,
  };
}

module.exports = { somethingToSay, lastBroadcastAt };
