/**
 * runner/lib/convictions.js — what Sebastian is prepared to say, and why.
 *
 * Under a research agenda the substance comes from the KNOWLEDGE BASE — findings
 * from his own research and briefs that survived the gate, each with a source —
 * not from axis scores. An axis score is the balance of what he read; deriving
 * "I strongly hold that X" from it was the system stating the feed's composition
 * as a conviction (see the 2026-09 ontology assessment). Axes are research
 * anchors now: they say where to look, not what to think.
 *
 * Without an agenda (RESEARCH_AGENDA=off) the original axis-derived behavior
 * stands, so the emergent mode is unchanged.
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
  // Under a full-pivot research agenda only the agenda's axes speak for him —
  // the pre-pivot axes still hold the highest confidence and would otherwise
  // supply every "what I hold" line long after the pivot.
  const { getAgenda, isFullPivot, isAgendaAxis } = require('./research_agenda');
  const agenda = getAgenda();
  const onAgenda = (a) => !isFullPivot(agenda) || isAgendaAxis(a, agenda);
  const axes = Object.values(ontology?.axes || ontology || {})
    .filter(onAgenda)
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

  // Under an agenda the knowledge base speaks first: findings he established
  // himself, with sources, and the proposals that survived the red-team.
  let knowledge = [];
  if (agenda) {
    try {
      knowledge = require('./knowledge_base').recent(maxAxes);
    } catch { /* no knowledge base yet */ }
  }

  if (agenda && knowledge.length) {
    parts.push(`## What I have established (my own research — cite the source)`);
    for (const k of knowledge) {
      if (k.kind === 'brief' && k.status === 'proposed') {
        parts.push(`- I have proposed: ${k.claim}${k.url ? ` (${k.url})` : ''} — a proposal, not a proven result.`);
      } else if (k.kind === 'brief') {
        parts.push(`- I withheld a proposal on "${(k.title || k.question || '').slice(0, 80)}" — ${String(k.reason || 'it did not survive the gate').slice(0, 120)}. I do not argue it as if it held.`);
      } else {
        parts.push(`- ${k.claim}${k.sources && k.sources.length ? ` [${k.sources[0]}]` : ''}`);
      }
    }
    parts.push('');
    parts.push(`I speak from these. Where the research has not reached, I say so instead of inferring a position.`);
  } else if (agenda) {
    // Nothing researched yet — the honest state, and the one to say out loud.
    parts.push(`## What I have established`);
    parts.push(`- Nothing yet. ${agenda.label} is the agenda; the research is under way and I argue from cited findings and published briefs, never from settled belief I have not earned.`);
    parts.push(...agenda.tracks.map(t => `- Working on: ${t.label} — ${t.why}`));
  } else if (lines.length) {
    parts.push(`## What I hold`);
    parts.push(...lines);
  }

  if (agenda) {
    const anchors = axes.slice(0, 5).map(a => `- ${a.label}`).filter(Boolean);
    if (anchors.length) {
      parts.push('');
      parts.push(`## Where I am looking (research anchors, not positions)`);
      parts.push(...anchors);
    }
  }

  // Committed stances (lib/stances): specific sides already taken on live
  // events — downstream writing must stay consistent with them.
  try {
    const block = require('./stances').stancesPromptBlock();
    if (block) { parts.push(''); parts.push(block.trim()); }
  } catch { /* non-fatal */ }

  return parts.join('\n').trim();
}

module.exports = { buildConvictions, convictionLine, poleAtScore, strengthWord };
