#!/usr/bin/env node
'use strict';
/**
 * runner/export_public_data.js — the public, machine-readable interface to
 * Sebastian's research: a versioned, cross-linked, static JSON export under
 * web/public/data/, served by the site he already deploys.
 *
 * Why this exists: his internal state is not an interface. ontology.json is a
 * multi-MB file (13k evidence entries, no per-axis addressability), the sqlite
 * DBs never leave the machine, and the existing *_export.json files are internal
 * shapes with no version and no documented semantics. Anything outside this repo
 * — a person, a script, another agent — needs stable ids, links, and a contract.
 *
 * Layout (mirrors the working reports pattern: an index + one file per object):
 *   data/index.json              catalog: collections, counts, schema version
 *   data/schema.json             field-level contract + what the numbers do NOT mean
 *   data/agenda.json             current agenda, tracks, integrity rules, vocation
 *   data/axes/{index,<id>}.json  belief axes (summaries + recent evidence, not the dump)
 *   data/solutions/{index,<id>}.json  solution briefs — published AND withheld, with reasons
 *   data/predictions/index.json  scored track record + calibration
 *   data/reports/index.json      (already written by publish_report.js — linked, not rewritten)
 *
 * HONEST NAMING is the point, not the format. An axis's internal `score` is a
 * recency-weighted mean of pole alignments — a measure of what his feed showed
 * him — and `confidence` counts distinct trust-weighted sources. Consumers read
 * those names as "belief" and "probability", which his own code did for months.
 * They are exported as `observed_pole_balance` / `evidence_breadth`, and every
 * axis carries a pointer to the semantics.
 *
 * Usage: node runner/export_public_data.js [--out <dir>] [--commit]
 * Runs daily from runner/lib/daily.js (reports block). Non-fatal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./lib/config');

const SCHEMA_VERSION = '1.0.0';
const SITE = process.env.SITE_ORIGIN || 'https://sebastianhunter.fun';
const ROOT = config.PROJECT_ROOT;
const STATE = config.STATE_DIR;
const RECENT_EVIDENCE = 20;   // per axis — enough to audit, not the whole log
const log = (m) => console.log(`[export_public_data] ${m}`);

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// ── Semantics: stated once, pointed at from every object that needs it ────────

const SEMANTICS = {
  observed_pole_balance:
    'Recency-weighted mean of which pole the observed evidence illustrates (-1 = left pole, +1 = right pole). ' +
    'This measures the COMPOSITION OF WHAT WAS READ, not what Sebastian believes and not a probability that either pole is true. ' +
    'A feed dominated by one side produces a strong balance with no epistemic content.',
  evidence_breadth:
    'How many distinct trust-weighted SOURCES fed this axis, mapped to 0-1 (0.95 * (1 - e^(-sources/35))). ' +
    'It is a breadth-of-sourcing signal, not a calibrated confidence and not a probability of truth.',
  axis_status:
    'agenda = an axis of the current research agenda; these are the only ones that speak for him now. ' +
    'legacy = an axis from a previous focus, kept for the public record and still carrying its old evidence. ' +
    'A legacy axis is NOT a current position, however high its numbers look.',
  solution_status:
    'proposed = passed the grounding + red-team gate and was published. withheld = failed the gate (see gate_failures) and was NOT published. ' +
    'no_solution = the evidence did not support a proposal. Nothing here has been empirically tested unless a test_outcome says so.',
  expected_outcome_confidence:
    "The author's stated probability that the proposed test would succeed, capped at 80%. Untested. " +
    'Compare against the prediction track record in /data/predictions/index.json before trusting any stated confidence.',
};

// ── Collections ───────────────────────────────────────────────────────────────

function exportAgenda(outDir) {
  let agenda = null;
  try { agenda = require('./lib/research_agenda').getAgenda(); } catch { /* none */ }
  const voc = readJson(path.join(STATE, 'vocation.json'), {}) || {};
  const doc = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    agenda: agenda ? {
      id: agenda.id,
      label: agenda.label,
      mode: agenda.mode,
      since: agenda.since,
      final_output: 'solution briefs — see /data/solutions/index.json',
      tracks: agenda.tracks.map((t) => ({
        id: t.id, label: t.label, why: t.why,
        foundation_questions: t.foundations || [],
        solution_questions: t.solutions || [],
        axes: agenda.axes.filter((a) => a.track === t.id).map((a) => a.id),
      })),
      integrity_rules: agenda.integrity,
    } : null,
    vocation: {
      label: voc.label || null,
      description: voc.description || null,
      statement: voc.statement || null,
      status: voc.status || null,
      pinned_by: voc.pinned_by || null,
      note: voc.pinned_by
        ? 'Vocation is set by the operator research agenda, not derived from the feed.'
        : 'Vocation is derived from the belief axes and changes as they do.',
    },
  };
  writeJson(path.join(outDir, 'agenda.json'), doc);
  return doc;
}

function exportAxes(outDir) {
  const onto = readJson(config.ONTOLOGY_PATH, { axes: [] }) || { axes: [] };
  let trackOf = () => null;
  let statusOf = () => 'agenda';
  try {
    const { getAgenda, isAgendaAxis } = require('./lib/research_agenda');
    const agenda = getAgenda();
    if (agenda) {
      trackOf = (id) => (agenda.axes.find((a) => a.id === id) || {}).track || null;
      // Pre-pivot axes stay in the record but must not read as current positions.
      statusOf = (axis) => (isAgendaAxis(axis, agenda) ? 'agenda' : 'legacy');
    }
  } catch { /* none */ }

  const items = [];
  for (const a of onto.axes || []) {
    const evidence = (a.evidence_log || []);
    const sources = new Set(evidence.map((e) => e.source).filter(Boolean));
    const item = {
      schema_version: SCHEMA_VERSION,
      id: a.id,
      label: a.label,
      left_pole: a.left_pole,
      right_pole: a.right_pole,
      track: trackOf(a.id),
      status: statusOf(a),
      status_meaning: SEMANTICS.axis_status,
      seeded_by: a.seeded_by || null,
      observed_pole_balance: a.score ?? 0,
      evidence_breadth: a.confidence ?? 0,
      evidence_count: evidence.length,
      distinct_sources: sources.size,
      created_at: a.created_at || null,
      last_updated: a.last_updated || null,
      semantics: {
        axis_status: SEMANTICS.axis_status,
        observed_pole_balance: SEMANTICS.observed_pole_balance,
        evidence_breadth: SEMANTICS.evidence_breadth,
        schema: `${SITE}/data/schema.json`,
      },
      recent_evidence: evidence.slice(-RECENT_EVIDENCE).map((e) => ({
        source: e.source || null,
        summary: e.summary || e.content || '',
        illustrates_pole: e.pole_alignment === 'right' ? 'right' : 'left',
        timestamp: e.timestamp || null,
      })),
      links: { self: `${SITE}/data/axes/${a.id}.json`, index: `${SITE}/data/axes/index.json` },
    };
    writeJson(path.join(outDir, 'axes', `${a.id}.json`), item);
    items.push({
      id: a.id, label: a.label, track: item.track, status: item.status,
      observed_pole_balance: item.observed_pole_balance,
      evidence_breadth: item.evidence_breadth,
      evidence_count: item.evidence_count,
      distinct_sources: item.distinct_sources,
      last_updated: item.last_updated,
      url: item.links.self,
    });
  }
  // Current agenda axes first — a consumer reading top-down sees present positions
  // before the historical record.
  items.sort((x, y) => (x.status === y.status ? y.evidence_count - x.evidence_count : x.status === 'agenda' ? -1 : 1));
  writeJson(path.join(outDir, 'axes', 'index.json'), {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    count: items.length,
    by_status: items.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {}),
    semantics: { axis_status: SEMANTICS.axis_status, observed_pole_balance: SEMANTICS.observed_pole_balance, evidence_breadth: SEMANTICS.evidence_breadth },
    items,
  });
  return items.length;
}

function exportSolutions(outDir) {
  const rows = readJsonl(path.join(STATE, 'solutions.jsonl'));
  // One record per brief id — later entries (e.g. a test outcome) win.
  const byId = new Map();
  for (const r of rows) {
    const id = r.id || `${(r.ts || '').slice(0, 10)}-${crypto.createHash('sha1').update(String(r.question || '')).digest('hex').slice(0, 8)}`;
    byId.set(id, { ...(byId.get(id) || {}), ...r, id });
  }
  const items = [];
  for (const r of byId.values()) {
    const item = {
      schema_version: SCHEMA_VERSION,
      id: r.id,
      created_at: r.ts || null,
      track: r.track || null,
      question: r.question || null,
      title: r.title || null,
      one_line: r.one_line || null,
      status: r.status || null,
      status_meaning: SEMANTICS.solution_status,
      red_team_verdict: r.review_verdict || null,
      evidence_count: r.evidence_count ?? null,
      test: r.test || null,
      expected_outcome: r.expected_outcome
        ? { ...r.expected_outcome, confidence_meaning: SEMANTICS.expected_outcome_confidence }
        : null,
      test_outcome: r.test_outcome || null,          // written back when a test is actually run
      testable_on_sebastian: r.self_test || null,
      gate_failures: r.gate_failures || null,        // why a withheld brief was not published
      links: {
        self: `${SITE}/data/solutions/${r.id}.json`,
        index: `${SITE}/data/solutions/index.json`,
        report: r.url || null,                       // the published brief, when it passed
        built_on: r.foundations || [],               // foundation reports it stands on
        agenda: `${SITE}/data/agenda.json`,
      },
    };
    writeJson(path.join(outDir, 'solutions', `${r.id}.json`), item);
    items.push({
      id: item.id, created_at: item.created_at, track: item.track, title: item.title,
      one_line: item.one_line, status: item.status, red_team_verdict: item.red_team_verdict,
      tested: !!item.test_outcome, url: item.links.self, report: item.links.report,
    });
  }
  items.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  const byStatus = items.reduce((acc, i) => { acc[i.status || 'unknown'] = (acc[i.status || 'unknown'] || 0) + 1; return acc; }, {});
  writeJson(path.join(outDir, 'solutions', 'index.json'), {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    count: items.length,
    by_status: byStatus,                              // withheld count is part of the record, on purpose
    status_meaning: SEMANTICS.solution_status,
    items,
  });
  return items.length;
}

function exportPredictions(outDir) {
  const src = readJson(path.join(STATE, 'prediction_export.json'), null);
  if (!src) return 0;
  const preds = (src.predictions || []).slice(0, 100).map((p) => ({
    id: p.id || null,
    created_at: p.ts || null,
    prediction: p.prediction || p.tweet || null,
    stated_confidence_pct: p.confidence_pct ?? null,
    resolution_status: p.resolution_status || 'pending',
    resolved_at: p.resolved_at || null,
    resolution_note: p.resolution_note || null,
  }));
  const c = src.calibration || {};
  writeJson(path.join(outDir, 'predictions', 'index.json'), {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    stats: src.stats || null,
    calibration: {
      ...c,
      meaning: 'stated vs actual. A large overconfidence gap means his stated confidences — including those on solution briefs — should be discounted.',
    },
    count: preds.length,
    items: preds,
  });
  return preds.length;
}

// ── Contract ──────────────────────────────────────────────────────────────────

function writeSchema(outDir) {
  writeJson(path.join(outDir, 'schema.json'), {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: "Sebastian D. Hunter — public research data",
    schema_version: SCHEMA_VERSION,
    description:
      'Static, versioned JSON describing an autonomous research agent\'s beliefs, proposals and track record. ' +
      'Every collection is an index plus one file per object; ids are stable; links are absolute URLs. ' +
      'Read the semantics notes before using any number: several of them do not mean what their names would suggest elsewhere.',
    semantics: SEMANTICS,
    definitions: {
      axis: {
        type: 'object',
        required: ['id', 'label', 'left_pole', 'right_pole', 'observed_pole_balance', 'evidence_breadth'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          left_pole: { type: 'string', description: 'the -1 end' },
          right_pole: { type: 'string', description: 'the +1 end' },
          track: { type: ['string', 'null'], description: 'research agenda track, if any' },
          status: { enum: ['agenda', 'legacy'], description: SEMANTICS.axis_status },
          observed_pole_balance: { type: 'number', minimum: -1, maximum: 1, description: SEMANTICS.observed_pole_balance },
          evidence_breadth: { type: 'number', minimum: 0, maximum: 1, description: SEMANTICS.evidence_breadth },
          evidence_count: { type: 'integer' },
          distinct_sources: { type: 'integer' },
          recent_evidence: { type: 'array', items: { type: 'object' }, description: `last ${RECENT_EVIDENCE} entries; the full log is not exported` },
        },
      },
      solution: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          track: { type: ['string', 'null'] },
          question: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          one_line: { type: ['string', 'null'] },
          status: { enum: ['proposed', 'withheld', 'no_solution', 'bailed', 'failed', 'publish_failed'], description: SEMANTICS.solution_status },
          red_team_verdict: { type: ['string', 'null'], enum: ['sound', 'revise', 'reject', null] },
          test: { type: ['object', 'null'], description: 'design, metric, success_threshold, falsified_if, timeframe' },
          expected_outcome: { type: ['object', 'null'], description: SEMANTICS.expected_outcome_confidence },
          test_outcome: { type: ['object', 'null'], description: 'present only when the test was actually run; absent means untested' },
          gate_failures: { type: ['array', 'null'], description: 'why a withheld brief was not published' },
          links: { type: 'object', description: 'self, index, report, built_on[], agenda' },
        },
      },
      prediction: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'] },
          prediction: { type: ['string', 'null'] },
          stated_confidence_pct: { type: ['number', 'null'] },
          resolution_status: { enum: ['pending', 'correct', 'wrong', 'partial', 'expired'] },
        },
      },
    },
  });
}

function writeCatalog(outDir, counts) {
  writeJson(path.join(outDir, 'index.json'), {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    agent: 'Sebastian D. Hunter',
    site: SITE,
    about: 'Machine-readable research data: what he proposes, what it rests on, and what held up.',
    schema: `${SITE}/data/schema.json`,
    read_this_first: SEMANTICS.observed_pole_balance,
    collections: [
      { name: 'agenda', description: 'current research agenda, tracks and vocation', url: `${SITE}/data/agenda.json` },
      { name: 'solutions', description: 'solution briefs — the final output, published and withheld', index: `${SITE}/data/solutions/index.json`, item: `${SITE}/data/solutions/{id}.json`, count: counts.solutions },
      { name: 'axes', description: 'belief axes with recent evidence', index: `${SITE}/data/axes/index.json`, item: `${SITE}/data/axes/{id}.json`, count: counts.axes },
      { name: 'predictions', description: 'scored prediction record + calibration', index: `${SITE}/data/predictions/index.json`, count: counts.predictions },
      { name: 'reports', description: 'deep-research reports (written by publish_report.js)', index: `${SITE}/data/reports/index.json` },
    ],
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function exportAll(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  exportAgenda(outDir);
  const counts = {
    axes: exportAxes(outDir),
    solutions: exportSolutions(outDir),
    predictions: exportPredictions(outDir),
  };
  writeSchema(outDir);
  writeCatalog(outDir, counts);
  return counts;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : path.join(ROOT, 'web', 'public', 'data');

  const counts = exportAll(outDir);
  log(`exported ${counts.axes} axes, ${counts.solutions} solution brief(s), ${counts.predictions} prediction(s) → ${outDir}`);

  if (args.includes('--commit')) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('git', ['add', path.relative(ROOT, outDir)], { cwd: ROOT, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'data: refresh public research export'], { cwd: ROOT, stdio: 'ignore' });
      execFileSync('git', ['push'], { cwd: ROOT, stdio: 'ignore' });
      log('committed + pushed');
    } catch (e) { log(`commit skipped: ${e.message.split('\n')[0]}`); }
  }
}

module.exports = { exportAll, SCHEMA_VERSION, SEMANTICS };

if (require.main === module) {
  try { main(); } catch (e) { log(`error (non-fatal): ${e.message}`); }
  process.exit(0);
}
