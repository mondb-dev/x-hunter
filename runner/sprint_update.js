#!/usr/bin/env node
/**
 * runner/sprint_update.js — Generate tweet + Moltbook content for sprint milestones
 *
 * Called daily from run.sh after sprint_manager.js.
 * Only produces output when something noteworthy happened:
 *   - A sprint was completed
 *   - All tasks in a sprint are done
 *   - A new sprint was activated
 *   - Significant accomplishments recorded today
 *
 * Writes:
 *   state/sprint_tweet.txt       — tweet text (≤ 257 chars + URL)
 *   state/sprint_update_draft.md — longer Moltbook post
 *
 * Non-fatal: exits 0 on any error.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state");

const { callVertex } = require("./vertex.js");
const sprintDb       = require("./sprint/db.js");

const SNAPSHOT_PATH     = path.join(STATE, "sprint_snapshot.json");
const TWEET_PATH        = path.join(STATE, "sprint_tweet.txt");
const MOLTBOOK_DRAFT    = path.join(STATE, "sprint_update_draft.md");
const LAST_UPDATE_PATH  = path.join(STATE, "last_sprint_update.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Detect noteworthy events ──────────────────────────────────────────────────

function detectEvents(snapshot, lastUpdate) {
  if (!snapshot || snapshot.plan_status === "none") return [];

  const events = [];
  const lastDate = lastUpdate?.date || "1970-01-01";

  // Check for completed sprints since last update
  for (const s of snapshot.sprints) {
    if (s.status === "completed" && s.tasks_done === s.tasks_total) {
      const key = `sprint_w${s.week}_complete`;
      if (!lastUpdate?.posted_events?.includes(key)) {
        events.push({
          type: "sprint_completed",
          key,
          week: s.week,
          goal: s.goal,
          tasks_done: s.tasks_done,
        });
      }
    }
  }

  // Check for today's accomplishments
  const todaysAccomplishments = (snapshot.accomplishments || []).filter(
    a => a.date === today()
  );
  if (todaysAccomplishments.length >= 2) {
    const key = `accomplishments_${today()}`;
    if (!lastUpdate?.posted_events?.includes(key)) {
      events.push({
        type: "accomplishments",
        key,
        count: todaysAccomplishments.length,
        items: todaysAccomplishments.map(a => a.description),
      });
    }
  }

  // Plan completed
  if (snapshot.plan_status === "completed") {
    const key = `plan_completed_${snapshot.plan_id}`;
    if (!lastUpdate?.posted_events?.includes(key)) {
      events.push({ type: "plan_completed", key, title: snapshot.plan_title });
    }
  }

  return events;
}

// ── Generate content via Vertex ───────────────────────────────────────────────

async function generateTweet(snapshot, events) {
  const eventSummary = events.map(e => {
    if (e.type === "sprint_completed") return `Week ${e.week} sprint completed: "${e.goal}" (${e.tasks_done} tasks done)`;
    if (e.type === "accomplishments") return `${e.count} accomplishments today: ${e.items.join("; ")}`;
    if (e.type === "plan_completed") return `Plan "${e.title}" completed!`;
    return "";
  }).join("\n");

  const prompt = `You are Sebastian D. Hunter, an AI agent building a worldview from scratch.
You are working on a plan called "${snapshot.plan_title}".
Currently on Week ${snapshot.current_week || "?"}: ${snapshot.current_goal || "in progress"}.

Today's progress:
${eventSummary}

Write a single, honest tweet about this progress. Rules:
- First person, casual but substantive
- Under 240 characters (a journal URL will be appended)
- No hashtags, no engagement bait, no self-congratulation
- Focus on what you learned or what moved, not just "I did X"
- Sound like someone working through a real project, not a PR bot

Tweet text only, no quotes:`;

  const raw = await callVertex(prompt, 2048);
  // Clean: strip quotes, trim, ensure length
  let tweet = raw.replace(/^["']|["']$/g, "").trim();
  if (tweet.length > 250) tweet = tweet.slice(0, 247) + "...";
  return tweet;
}

async function generateMoltbookPost(snapshot, events) {
  const eventSummary = events.map(e => {
    if (e.type === "sprint_completed") return `- Completed Week ${e.week} sprint: "${e.goal}" (${e.tasks_done} tasks)`;
    if (e.type === "accomplishments") return `- ${e.count} accomplishments: ${e.items.join("; ")}`;
    if (e.type === "plan_completed") return `- Plan "${e.title}" completed`;
    return "";
  }).join("\n");

  const taskSummary = (snapshot.current_tasks || []).map(t => {
    const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "○";
    return `  ${icon} ${t.title}`;
  }).join("\n");

  const prompt = `You are Sebastian D. Hunter, an AI agent building a worldview from scratch.
You are working on: "${snapshot.plan_title}"
Brief: ${snapshot.brief || ""}

Current sprint: Week ${snapshot.current_week || "?"} — ${snapshot.current_goal || ""}
Tasks:
${taskSummary || "(none listed)"}

Today's noteworthy events:
${eventSummary}

Write a Moltbook post (markdown) updating your community on this progress. Rules:
- First person, reflective, substantive
- 200-500 words
- Include what happened, what you learned, and what's next
- Be honest about challenges or uncertainties
- No marketing language, no engagement bait
- Use ## headings for structure

Output markdown only:`;

  return callVertex(prompt, 4096);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[sprint_update] checking for noteworthy events");

  const snapshot = loadJson(SNAPSHOT_PATH);
  if (!snapshot || snapshot.plan_status === "none") {
    console.log("[sprint_update] no sprint snapshot — skipping");
    return;
  }

  const lastUpdate = loadJson(LAST_UPDATE_PATH);
  const events = detectEvents(snapshot, lastUpdate);

  if (events.length === 0) {
    console.log("[sprint_update] no noteworthy events — skipping");
    return;
  }

  console.log(`[sprint_update] ${events.length} event(s) detected: ${events.map(e => e.type).join(", ")}`);

  // Generate tweet
  try {
    const tweet = await generateTweet(snapshot, events);
    const journalUrl = `https://sebastianhunter.fun/plan`;
    const fullTweet = `${tweet}\n${journalUrl}`;
    fs.writeFileSync(TWEET_PATH, fullTweet);
    console.log(`[sprint_update] tweet draft written (${tweet.length} chars)`);
  } catch (err) {
    console.error(`[sprint_update] tweet generation failed: ${err.message}`);
  }

  // Generate Moltbook post
  try {
    const post = await generateMoltbookPost(snapshot, events);
    const title = events.find(e => e.type === "sprint_completed")
      ? `Sprint update — Week ${events.find(e => e.type === "sprint_completed").week} complete`
      : events.find(e => e.type === "plan_completed")
        ? `Plan complete: ${snapshot.plan_title}`
        : `Sprint update — ${today()}`;
    const fullPost = `# ${title}\n\n${post}\n\n---\n*Plan: ${snapshot.plan_title} | Week ${snapshot.current_week || "?"}*\n*Journal: https://sebastianhunter.fun/plan*`;
    fs.writeFileSync(MOLTBOOK_DRAFT, fullPost);
    console.log(`[sprint_update] Moltbook draft written (${fullPost.length} chars)`);
  } catch (err) {
    console.error(`[sprint_update] Moltbook draft generation failed: ${err.message}`);
  }

  // Record what we posted to avoid duplicates
  const postedEvents = (lastUpdate?.posted_events || []).concat(events.map(e => e.key));
  fs.writeFileSync(LAST_UPDATE_PATH, JSON.stringify({
    date: today(),
    posted_events: postedEvents.slice(-50), // keep last 50
  }, null, 2));

  sprintDb.close();
  console.log("[sprint_update] done");
}

main().catch(err => {
  console.error(`[sprint_update] fatal: ${err.message}`);
  try { sprintDb.close(); } catch {}
  process.exit(0); // non-fatal
});
