/**
 * runner/lib/convictions.js — derive prose convictions from ontology + vocation.
 *
 * Converts numeric axes into "I hold that..." statements so the writing layer
 * never sees raw scores. Prose can't be sign-flipped the way a ternary can,
 * and forces the reader (a downstream LLM) to engage with the *substance* of
 * the position rather than a defend-this directive.
 *
 * buildConvictions({ ontology, vocation, opts }) → string
 */

'use strict';

function poleAtScore(axis) {
  // Sign convention (apply_ontology_delta.js): right_pole = +1, left_pole = -1
  const score = axis.score || 0;
  const leftPole  = axis.left_pole  || axis.pole_left  || '';
  const rightPole = axis.right_pole || axis.pole_right || '';
  if (score > 0) return { pole: rightPole, direction: 'right' };
  if (score < 0) return { pole: leftPole,  direction: 'left'  };
  return { pole: '', direction: 'neutral' };
}

function strengthWord(score) {
  const m = Math.abs(score || 0);
  if (m > 0.6)  return 'strongly';
  if (m > 0.35) return 'clearly';
  if (m > 0.15) return 'cautiously';
  return 'tentatively';
}

function convictionLine(axis) {
  const { pole } = poleAtScore(axis);
  if (!pole) return null;
  const strength = strengthWord(axis.score);
  // Render as a first-person commitment, not as "axis X = Y"
  return `I ${strength} hold that ${pole.trim().replace(/\.$/, '')}.`;
}

function buildConvictions({ ontology, vocation, maxAxes = 8, minConf = 0.45 } = {}) {
  const axes = Object.values(ontology?.axes || ontology || {})
    .filter(a => (a.confidence || 0) >= minConf && Math.abs(a.score || 0) > 0.1)
    .sort((a, b) => (b.confidence * Math.abs(b.score)) - (a.confidence * Math.abs(a.score)))
    .slice(0, maxAxes);

  const lines = axes.map(convictionLine).filter(Boolean);

  const parts = [];

  if (vocation && vocation.label) {
    parts.push(`## Who I am`);
    parts.push(`${vocation.label}.`);
    if (vocation.intent) parts.push(vocation.intent);
    parts.push('');
  }

  if (lines.length) {
    parts.push(`## What I hold`);
    parts.push(...lines);
  }

  // Committed stances (lib/stances): specific sides already taken on live
  // events — downstream writing must stay consistent with them.
  try {
    const block = require('./stances').stancesPromptBlock();
    if (block) { parts.push(''); parts.push(block.trim()); }
  } catch { /* non-fatal */ }

  return parts.join('\n').trim();
}

module.exports = { buildConvictions, convictionLine, poleAtScore };
