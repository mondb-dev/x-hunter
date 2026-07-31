#!/usr/bin/env node
/**
 * runner/sprint/verify_artifact.js — does a task's claimed artifact actually exist?
 *
 * WHY: sprint/tracker.js used to mark a task "done" purely on an LLM matching a
 * one-line signal ("Posted tweet: ...") to a task title, and passed null for the
 * artifact. Nothing ever checked that the claimed output existed. The result, as
 * of 2026-07-31: 20 tasks marked done, 12 with no artifact at all, and all 8 of
 * the remaining references unresolvable — several were unsubstituted templates
 * (`articles/YYYY-MM-DD.md`, `x.com/handle/status/<id>`) and one named an account
 * that isn't Sebastian's. "Done" meant nothing you could check afterwards.
 *
 * This module is the check. A task may only reach "done" when its artifact
 * resolves to something real:
 *
 *   - an X/LinkedIn URL that appears in state/posts_log.json (the record of what
 *     was actually published), or
 *   - a file path that exists on disk.
 *
 * Anything else — missing, templated, or pointing at nothing — fails, and the
 * caller demotes the task to in_progress rather than silently accepting it.
 *
 * Exports:
 *   isTemplate(ref)            → boolean   unsubstituted placeholder?
 *   verifyArtifact(ref, opts)  → { ok, kind, reason, ref }
 *
 * No external deps — Node built-ins only.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

// Values the planner/LLM emits in place of a real artifact.
const PLACEHOLDERS = new Set(['', '(none)', 'none', 'n/a', 'na', 'null', 'tbd', 'todo', 'undefined']);

// Unsubstituted template markers. These are the ones that actually slipped
// through the old PLACEHOLDER_ARTIFACTS check and got stored as "evidence".
const TEMPLATE_PATTERNS = [
  /YYYY[-_]?MM[-_]?DD/i,   // articles/YYYY-MM-DD.md
  /YYYYMMDD/i,             // status/YYYYMMDD_thread1_ID
  /<[^>]+>/,               // x.com/handle/status/<id>
  /\{[^}]*\}/,             // {date}, {id}
  /\bW\d+\.md$/i,          // moltbook_article_draft_W3.md — week template
  /_ID\b/i,
  /\bReport_\$\{/,         // Report_${nextWeek}.md echoed from the prompt
  /^or\s/i,                // "or null if no file output" echoed back
  /if no file output/i,
];

/** True when ref is a placeholder or an unsubstituted template. */
function isTemplate(ref) {
  const s = String(ref == null ? '' : ref).trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return true;
  return TEMPLATE_PATTERNS.some(re => re.test(s));
}

/** Every URL this account has actually published, from the posts log. */
function loadPublishedUrls() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'state', 'posts_log.json'), 'utf-8');
    const data = JSON.parse(raw);
    const posts = Array.isArray(data) ? data : (data.posts || []);
    const urls = new Set();
    for (const p of posts) {
      for (const v of [p.tweet_url, p.url, p.post_url, p.permalink]) {
        if (v) urls.add(String(v).trim());
      }
    }
    return urls;
  } catch { return new Set(); }
}

/** Compare URLs ignoring scheme, www, trailing slash and query string. */
function canonicalUrl(u) {
  return String(u)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * verifyArtifact(ref, opts) → { ok, kind, reason, ref }
 *
 * kind is 'url' | 'file' | 'none'. opts.publishedUrls lets a caller pass a
 * pre-loaded Set to avoid re-reading posts_log.json per task.
 */
function verifyArtifact(ref, opts = {}) {
  const raw = String(ref == null ? '' : ref).trim();

  if (!raw)            return { ok: false, kind: 'none', reason: 'no artifact recorded', ref: raw };
  if (isTemplate(raw)) return { ok: false, kind: 'none', reason: 'unsubstituted template/placeholder', ref: raw };

  // A comma-separated list counts as verified only if EVERY entry resolves —
  // "articles/x.md,LinkedIn_posts/y.md" claims both were produced.
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const results = parts.map(p => verifyArtifact(p, opts));
    const bad = results.find(r => !r.ok);
    return bad
      ? { ok: false, kind: 'none', reason: `part "${bad.ref}" ${bad.reason}`, ref: raw }
      : { ok: true, kind: 'multi', reason: `${parts.length} artifacts verified`, ref: raw };
  }

  const looksLikeUrl = /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com|linkedin\.com)\//i.test(raw);
  if (looksLikeUrl) {
    const published = opts.publishedUrls || loadPublishedUrls();
    const target = canonicalUrl(raw);
    for (const u of published) {
      if (canonicalUrl(u) === target) return { ok: true, kind: 'url', reason: 'found in posts_log', ref: raw };
    }
    return { ok: false, kind: 'url', reason: 'URL not found in posts_log — nothing was published there', ref: raw };
  }

  // Otherwise treat it as a repo-relative file path.
  if (raw.includes('://')) return { ok: false, kind: 'none', reason: 'unrecognized URL host', ref: raw };
  const abs = path.resolve(ROOT, raw);
  if (!abs.startsWith(ROOT)) return { ok: false, kind: 'file', reason: 'path escapes the repo', ref: raw };
  if (fs.existsSync(abs))    return { ok: true, kind: 'file', reason: 'file exists', ref: raw };
  return { ok: false, kind: 'file', reason: 'file does not exist', ref: raw };
}

module.exports = { verifyArtifact, isTemplate, loadPublishedUrls, canonicalUrl };

// ── CLI: audit every done task — `node runner/sprint/verify_artifact.js` ───────
if (require.main === module) {
  // Read the sqlite file directly rather than through sprint/db.js — its
  // accessors are all plan-scoped, and an audit wants every task regardless of
  // which plan it belongs to.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(ROOT, 'state', 'sprints.db'), { readonly: true });
  const tasks = db.prepare("SELECT id, title, status, output_ref, completed_date FROM tasks WHERE status = 'done' ORDER BY completed_date").all();
  const published = loadPublishedUrls();
  let ok = 0, bad = 0;
  for (const t of tasks) {
    const r = verifyArtifact(t.output_ref, { publishedUrls: published });
    if (r.ok) { ok++; console.log(`[  ok  ] task ${t.id} "${String(t.title).slice(0, 46)}" — ${r.reason}`); }
    else { bad++; console.log(`[UNVERIFIED] task ${t.id} "${String(t.title).slice(0, 46)}" — ${r.reason} (${r.ref || 'null'})`); }
  }
  console.log(`\n${ok} verified, ${bad} unverified out of ${ok + bad} done task(s)`);
  db.close();
}
