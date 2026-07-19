#!/usr/bin/env node
'use strict';
/**
 * scripts/docs_drift_audit.js — weekly docs-vs-code drift detector.
 *
 * Two checks, both cheap and mechanical (no LLM):
 *   1. DEAD REFERENCES — every `path/to/file.js|sh|ts` mentioned in the doc set
 *      (root *.md + docs/*.md, excluding docs/archive/) that does not exist on
 *      disk. A dead reference means the doc describes code that moved or died.
 *   2. STALENESS — days since each doc's last git commit vs the number of
 *      substantive commits (non-journal/cycle/daily) landed since then. A doc
 *      untouched across many substantive commits is drift-suspect.
 *
 * Output: state/docs_drift_report.json + console summary. Findings are meant
 * to be picked up by process reflection / the sprint queue — this script never
 * edits docs itself and never exits non-zero (non-fatal by design).
 *
 * Usage: node scripts/docs_drift_audit.js [--verbose]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const NOISE_COMMIT_RE = /^(journal|cycle \d+|daily|tweet compose|verify: update|predictions: (resolve|update)|report)[:\s]/i;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function listDocs() {
  const docs = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.md')) docs.push(f);
  }
  const docsDir = path.join(ROOT, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir)) {
      if (f.endsWith('.md')) docs.push(path.join('docs', f));
    }
  }
  return docs; // docs/archive/ intentionally excluded — archived docs may reference dead code
}

function extractPathRefs(text) {
  // repo-relative code paths like runner/lib/foo.js, scraper/collect.js, web/app/x.tsx
  const re = /\b((?:runner|scraper|lib|pipelines|workers|tools|scripts|web|src|analyzer)\/[A-Za-z0-9_\-./]+\.(?:js|ts|tsx|sh|py))\b/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

function main() {
  const docs = listDocs();
  const report = { generated_at: new Date().toISOString(), dead_references: [], stale_docs: [] };

  for (const doc of docs) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    const dead = extractPathRefs(text).filter((p) => !fs.existsSync(path.join(ROOT, p)));
    if (dead.length) report.dead_references.push({ doc, missing: dead });

    const lastDate = git(['log', '-1', '--format=%as', '--', doc]);
    if (!lastDate) continue;
    const commitsSince = git(['log', '--oneline', '--no-merges', `--since=${lastDate}`])
      .split('\n')
      .filter((l) => l && !NOISE_COMMIT_RE.test(l.replace(/^\w+\s+/, '')));
    if (commitsSince.length >= 30) {
      report.stale_docs.push({ doc, last_commit: lastDate, substantive_commits_since: commitsSince.length });
    }
  }

  const outPath = path.join(ROOT, 'state', 'docs_drift_report.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  } catch (err) {
    console.error('[docs_drift] could not write report: ' + err.message);
  }

  console.log(
    `[docs_drift] ${report.dead_references.length} docs with dead references, ` +
      `${report.stale_docs.length} drift-suspect docs → state/docs_drift_report.json`
  );
  if (VERBOSE) {
    for (const d of report.dead_references) console.log(`  dead-refs ${d.doc}: ${d.missing.join(', ')}`);
    for (const s of report.stale_docs) console.log(`  stale ${s.doc} (last ${s.last_commit}, ${s.substantive_commits_since} substantive commits since)`);
  }
}

main();
