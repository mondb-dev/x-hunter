#!/usr/bin/env node
'use strict';
/**
 * runner/publish_report.js — publish a rich report page to the website at a
 * unique URL: https://sebastianhunter.fun/report/<id>
 *
 * DECOUPLED from research: it takes a generic report spec (title + summary +
 * an ordered list of typed BLOCKS) and writes it as JSON into the web app's
 * data dir, commits + pushes (→ Vercel rebuild), and returns the URL. The web
 * renderer (web/app/report/[id]) + its BLOCK REGISTRY (web/components/report)
 * decide how each block type renders — text, tables, charts, maps, etc. — so new
 * visualizations are added there without touching this tool.
 *
 * Report spec:
 *   { title, summary?, kind?, source?, blocks: [ { type, ...props } ] }
 * Block types (see the web registry): heading, paragraph, markdown, callout,
 *   keyvalue, table, bar_chart, line_chart, pie_chart, map, sources, embed.
 *
 * Usage (CLI): node runner/publish_report.js path/to/report.json
 * Programmatic: const { publishReport } = require('./publish_report');
 *               const url = await publishReport(spec);
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'web', 'public', 'data', 'reports');
const SITE = process.env.SITE_ORIGIN || 'https://sebastianhunter.fun';
const log = (m) => console.log(`[publish_report] ${m}`);

const KNOWN_BLOCKS = new Set(['heading', 'paragraph', 'markdown', 'callout', 'keyvalue', 'table', 'bar_chart', 'line_chart', 'pie_chart', 'map', 'sources', 'embed']);

function slugify(s) {
  return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'report';
}

/** Validate + normalize a report spec; assign a unique id. */
function normalize(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  if (!spec.title) throw new Error('spec.title is required');
  const blocks = (Array.isArray(spec.blocks) ? spec.blocks : []).filter((b) => b && KNOWN_BLOCKS.has(b.type));
  if (!blocks.length) throw new Error('spec.blocks must contain at least one known block');
  const unknown = (spec.blocks || []).filter((b) => b && !KNOWN_BLOCKS.has(b.type)).map((b) => b.type);
  if (unknown.length) log(`dropping unknown block type(s): ${[...new Set(unknown)].join(', ')}`);
  const id = spec.id || `${slugify(spec.title)}-${crypto.randomBytes(3).toString('hex')}`;
  return {
    id,
    title: String(spec.title).slice(0, 200),
    summary: spec.summary ? String(spec.summary).slice(0, 600) : '',
    kind: spec.kind || 'research',
    source: spec.source || 'manual',
    generated_at: new Date().toISOString(),
    blocks,
  };
}

/** Write the report JSON, commit + push, return its URL. */
async function publishReport(spec, { push = true } = {}) {
  const report = normalize(spec);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${report.id}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log(`wrote ${path.relative(ROOT, file)} (${report.blocks.length} block(s))`);

  // Maintain an index for the /report listing + generateStaticParams.
  const indexFile = path.join(REPORTS_DIR, 'index.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  index = index.filter((r) => r.id !== report.id);
  index.unshift({ id: report.id, title: report.title, summary: report.summary, kind: report.kind, generated_at: report.generated_at });
  fs.writeFileSync(indexFile, JSON.stringify(index.slice(0, 500), null, 2));

  const url = `${SITE}/report/${report.id}`;
  if (push) {
    try {
      execFileSync('git', ['add', file, indexFile], { cwd: ROOT });
      execFileSync('git', ['commit', '-q', '-m', `report: ${report.title.slice(0, 60)} [${report.id}]`], { cwd: ROOT });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: ROOT, timeout: 60000 });
      log(`pushed — Vercel will deploy ${url}`);
    } catch (e) { log(`git publish failed (report saved locally): ${e.message}`); }
  }
  return url;
}

module.exports = { publishReport, normalize, KNOWN_BLOCKS };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    if (!arg) { console.error('usage: node runner/publish_report.js <spec.json>'); process.exit(2); }
    const spec = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const url = await publishReport(spec, { push: !process.argv.includes('--no-push') });
    console.log(url);
  })();
}
