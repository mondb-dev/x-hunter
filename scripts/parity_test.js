#!/usr/bin/env node
// Compare key context outputs between bash inline code and context.js module.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// ── 1. currentAxes (bash node -e vs context.js) ─────────────────────────
function bashCurrentAxes() {
  const d = JSON.parse(fs.readFileSync('state/ontology.json','utf-8'));
  const lines = [];
  (d.axes||[]).forEach(a => {
    const ev = (a.evidence_log||[]).length;
    const conf = ((a.confidence||0)*100).toFixed(0);
    lines.push('  ['+a.id+'] '+a.label+' (conf:'+conf+'%, ev:'+ev+')');
    lines.push('    L: '+a.left_pole.slice(0,80));
    lines.push('    R: '+a.right_pole.slice(0,80));
  });
  return lines.join('\n');
}

// ── 2. topAxes (quote prompt) ────────────────────────────────────────────
function bashTopAxes() {
  const o = JSON.parse(fs.readFileSync('state/ontology.json','utf-8'));
  const raw = Array.isArray(o.axes) ? o.axes : Object.values(o.axes||{});
  const axes = raw
    .filter(a => a.confidence >= 0.65)
    .sort((a,b) => b.confidence - a.confidence)
    .slice(0, 6);
  const out = axes.map(a => {
    const ev = (a.evidence_log||[]).slice(-2).map(e => '    * '+e.content.slice(0,120)).join('\n');
    return '- '+a.label+' (conf: '+(a.confidence*100).toFixed(0)+'%)\n'+
           '  LEFT: '+a.left_pole+'\n'+
           '  RIGHT: '+a.right_pole+
           (ev ? '\n  Recent evidence:\n'+ev : '');
  });
  return out.join('\n\n');
}

// ── 3. quotedSources ────────────────────────────────────────────────────
function bashQuotedSources() {
  const posts = JSON.parse(fs.readFileSync('state/posts_log.json','utf-8')).posts||[];
  const quotes = posts.filter(p => p.type==='quote' && p.source_url);
  if (quotes.length===0) return '(none yet)';
  return quotes.map(q => '- '+q.source_url).join('\n');
}

// ── 4. activePlanContext ────────────────────────────────────────────────
function bashActivePlanContext() {
  try {
    const content = fs.readFileSync('state/sprint_context.txt','utf-8');
    if (content.trim()) return content.replace(/`/g, "'");
  } catch {}
  try {
    const a = JSON.parse(fs.readFileSync('state/active_plan.json','utf-8'));
    if (a && a.status==='active') {
      const days = Math.floor((Date.now()-new Date(a.activated_date).getTime())/86400000);
      return 'ACTIVE PLAN: '+a.title+'\nGoal: '+(a.first_sprint?.week_1_goal||'(none)')+'\nDay '+days+' of 30';
    }
  } catch {}
  return '(no active plan)';
}

// ── Run comparisons ─────────────────────────────────────────────────────
const loadContext = require(path.join(ROOT, 'runner/lib/prompts/context'));
const browseCtx = loadContext({type:'browse',cycle:144,dayNumber:27,today:'2026-03-21',now:'14:30',hour:'14'});
const quoteCtx  = loadContext({type:'quote',cycle:9,dayNumber:27,today:'2026-03-21',now:'14:30',hour:'14'});
const tweetCtx  = loadContext({type:'tweet',cycle:12,dayNumber:27,today:'2026-03-21',now:'14:30',hour:'14'});

const tests = [
  ['currentAxes (browse)',  bashCurrentAxes(),     browseCtx.currentAxes],
  ['currentAxes (tweet)',   bashCurrentAxes(),     tweetCtx.currentAxes],
  ['topAxes (quote)',       bashTopAxes(),         quoteCtx.topAxes],
  ['quotedSources (quote)', bashQuotedSources(),   quoteCtx.quotedSources],
  ['activePlanContext',     bashActivePlanContext(),tweetCtx.activePlanContext],
];

let pass = 0, fail = 0;
for (const [label, expected, actual] of tests) {
  if (expected === actual) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    // Show first difference
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (expected[i] !== actual[i]) {
        console.log(`    First diff at char ${i}:`);
        console.log(`    expected: ${JSON.stringify(expected.slice(Math.max(0,i-20), i+30))}`);
        console.log(`    actual:   ${JSON.stringify(actual.slice(Math.max(0,i-20), i+30))}`);
        break;
      }
    }
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed out of ${tests.length}`);
process.exit(fail > 0 ? 1 : 0);
