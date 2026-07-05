#!/usr/bin/env node
/**
 * runner/linkedin_draft.js — generate a LinkedIn post draft for Sebastian.
 *
 * LinkedIn posting needs a content source (unlike tweets, which the TWEET cycle
 * writes). This synthesises one long-form LinkedIn post from Sebastian's recent
 * X posts + the latest journal reflection, in his voice, and writes it to
 * state/linkedin_draft.txt for linkedin_post.js to publish.
 *
 * Skips (exit 0, no write) if a pending draft already exists — never clobbers an
 * unposted draft.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./lib/config");

const ROOT = path.resolve(__dirname, "..");
const DRAFT = path.join(config.STATE_DIR, "linkedin_draft.txt");
const VOCATION = path.join(ROOT, "vocation.md");
const log = (m) => console.log(`[linkedin_draft] ${m}`);

function latestJournalText() {
  try {
    const files = fs.readdirSync(config.JOURNALS_DIR).filter((f) => f.endsWith(".html")).sort();
    if (!files.length) return "";
    const html = fs.readFileSync(path.join(config.JOURNALS_DIR, files[files.length - 1]), "utf-8");
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
  } catch { return ""; }
}

function recentTweets(n = 6) {
  try {
    const d = JSON.parse(fs.readFileSync(config.POSTS_LOG_PATH, "utf-8"));
    const posts = (Array.isArray(d) ? d : d.posts || []).filter((p) => ["tweet", "quote", "prediction"].includes(p.type));
    return posts.slice(-n).map((p) => `- ${(p.content || "").replace(/\n/g, " ").slice(0, 200)}`).join("\n");
  } catch { return ""; }
}

(async () => {
  if (fs.existsSync(DRAFT)) {
    const existing = fs.readFileSync(DRAFT, "utf-8").trim();
    if (existing && existing !== "SKIP") { log("pending draft exists — not overwriting"); process.exit(0); }
  }

  let vocation = "";
  try { vocation = fs.readFileSync(VOCATION, "utf-8").slice(0, 1500); } catch {}
  const journal = latestJournalText();
  const tweets = recentTweets();
  if (!journal && !tweets) { log("no source material — skipping"); process.exit(0); }

  const { callVertex } = require("./vertex");
  const prompt =
`You are Sebastian Hunter writing a LinkedIn post. Your vocation and voice:
${vocation}

Your recent observations (latest journal reflection):
"""
${journal}
"""

Your recent X posts:
${tweets}

Write ONE original LinkedIn post that develops a single idea from the material above
into long-form. LinkedIn norms: professional, first person, 150-350 words, plain
paragraphs (no hashtags, no emojis, no "thread"/"1/n"). Name specific tensions,
actors, or claims — no vague gesturing at "narratives" or "the truth". Open with the
idea, not throat-clearing. End with a question or a sharp line that invites discussion.

Return ONLY the post text.`;

  try {
    const raw = await callVertex(prompt, 900, { model: "gemini-2.5-flash", thinkingBudget: 0 });
    const text = (raw || "").trim().replace(/^["']|["']$/g, "");
    if (!text || text.length < 120) { log("generation too short — skipping"); process.exit(0); }
    fs.writeFileSync(DRAFT, text);
    log(`wrote draft (${text.length} chars)`);
    process.exit(0);
  } catch (err) {
    log(`generation failed: ${err.message}`);
    process.exit(0);
  }
})();
