/**
 * runner/lib/synthesize_case.js — belief-agnostic case synthesis.
 *
 * Two-stage:
 *   1. identifyCase(): given a topic seed + raw source material, pick the single
 *      most concrete, currently-active news event and return its handle.
 *   2. synthesizeCase(): produce a structured factual brief — chronology, actors,
 *      verified facts, disputed claims, competing frames. NO axis context, NO
 *      "you are Sebastian." Wire-service voice. Then run verifyClaim() on the
 *      flagged factual_claims and merge the verifications back in.
 *
 * The brief is cached under state/case_synthesis/<slug>.json so a thread,
 * journal reflection, and article on the same case can share it.
 *
 * Exports: synthesizeCase({ topic, journals, discourseDigest, feedDigest })
 *          → { case_slug, event_headline, chronology, key_actors,
 *              verified_facts, disputed_claims, competing_frames,
 *              primary_sources, generated_at }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { callVertex } = require('../vertex.js');
const { verifyClaim } = require('./verify_claim.js');

const ROOT = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(ROOT, 'state', 'case_synthesis');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function parseJsonLoose(raw) {
  const cleaned = String(raw || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function journalUrl(j) {
  if (j.tx_id) return `https://sebastianhunter.fun/arweave/${j.tx_id}`;
  if (j.source_url) return j.source_url;
  return null;
}

function formatJournalsForPrompt(journals) {
  return journals.map((j, i) => {
    const url = journalUrl(j);
    const header = url
      ? `[J${i + 1}] ${j.date} h${j.hour ?? '?'} — ${url}`
      : `[J${i + 1}] ${j.date} h${j.hour ?? '?'}`;
    return `${header}\n${(j.text_content || '').slice(0, 2500).trim()}`;
  }).join('\n\n---\n\n');
}

// ── Stage 1: identify the concrete case ─────────────────────────────────────

async function identifyCase({ topic, journals, discourseDigest, feedDigest }) {
  const prompt = `You are a wire-service news desk editor. Your job is to look at field observations and pick the single most concrete, currently-active news event that exemplifies a topic area.

Topic area: ${topic}

Field observations (journals from the last few days):
${formatJournalsForPrompt(journals.slice(0, 20))}

Recent discourse:
${(discourseDigest || '').slice(0, 4000)}

Recent feed digest (excerpts):
${(feedDigest || '').slice(0, 3000)}

Identify the SINGLE most concrete, named, currently-active event in this material — the one with specific actors, specific actions, and specific dates. Not a theme. Not a trend. A *case*.

Reply with JSON only:
{
  "event_headline": "<one-line headline naming the case>",
  "case_slug": "<kebab-case slug, 30-80 chars, descriptive>",
  "key_terms": ["term1","term2","term3"],
  "source_journal_ids": ["J1","J3","J7"]
}`;

  const raw = await callVertex(prompt, 1024, { thinkingBudget: 2048 });
  return parseJsonLoose(raw);
}

// ── Stage 2: structured factual brief ───────────────────────────────────────

async function buildBrief({ caseInfo, journals, discourseDigest, feedDigest }) {
  const prompt = `You are a wire-service reporter producing a neutral factual brief for editorial use. You are NOT taking a position. You are NOT an analyst. You are a reporter assembling what is known, what is disputed, and what competing frames exist in the source material.

Case: ${caseInfo.event_headline}

Source material — field observations indexed by journal ID:
${formatJournalsForPrompt(journals)}

${discourseDigest ? `Recent discourse:\n${discourseDigest.slice(0, 3000)}\n\n` : ''}
${feedDigest ? `Feed excerpts:\n${feedDigest.slice(0, 2500)}\n\n` : ''}

Produce a structured brief. Reply with JSON only, no other text:

{
  "chronology": [
    {"date": "YYYY-MM-DD", "actor": "name/role", "action": "what they did, factually", "source_journal": "J3"}
  ],
  "key_actors": [
    {"name": "name", "role": "their role in this case", "stated_position": "their own stated position, neutrally summarized", "source_journal": "J3"}
  ],
  "factual_claims": [
    {"claim": "specific factual claim that could be verified", "source_journal": "J3", "needs_verification": true}
  ],
  "disputed_claims": [
    {"claim": "claim in the discourse", "competing_accounts": "how it is being read differently", "source_journal": "J3"}
  ],
  "competing_frames": [
    {"frame": "name of frame", "proponents": "who advances it", "summary": "one-sentence neutral summary"}
  ]
}

Rules:
- Use only what is in the source material. Do not invent events, dates, names, or quotes.
- CITATION INTEGRITY (critical): every chronology entry, actor position, and factual_claim must include "source_journal" — the EXACT journal ID (e.g. "J3", "J7") of the SPECIFIC journal entry that documents that event. If multiple journals reference one event, pick the most direct. If NO journal documents the specific event, set source_journal to null and do NOT include it in the brief at all. Do not reuse one journal ID for events it does not actually contain.
- For "competing_frames", list at least the dominant frame and any clearly opposing frame visible in the source material. Do not editorialize about which is correct.
- "factual_claims" should be the load-bearing factual assertions a reader would want verified.
- Be specific. "OSG filed comment opposing Dela Rosa petition on 2026-05-17" — not "officials commented on legal matters."`;

  const raw = await callVertex(prompt, 8192, { thinkingBudget: 4096 });
  const brief = parseJsonLoose(raw);

  // Resolve "J3" → real URL using the journals array. Drop entries with
  // unresolvable or missing references. This is the only way the writer
  // gets a URL; prevents the model fabricating or reusing URLs.
  const journalMap = {};
  journals.forEach((j, i) => {
    const id = `J${i + 1}`;
    journalMap[id] = journalUrl(j);
  });
  const resolveSource = (entry) => {
    const ref = entry.source_journal;
    if (!ref) return null;
    const url = journalMap[ref];
    return url || null;
  };
  ['chronology', 'key_actors', 'factual_claims', 'disputed_claims'].forEach(key => {
    if (!Array.isArray(brief[key])) return;
    brief[key] = brief[key].map(e => ({ ...e, source_url: resolveSource(e) }));
  });

  // Re-derive primary_sources from actual cited journals to prevent the
  // model from listing the full journal pool as "primary."
  const used = new Set();
  ['chronology', 'key_actors', 'factual_claims', 'disputed_claims'].forEach(key => {
    (brief[key] || []).forEach(e => { if (e.source_url) used.add(e.source_url); });
  });
  brief.primary_sources = [...used];

  return brief;
}

// ── Stage 3: verify flagged claims (best-effort, non-blocking on errors) ───

async function verifyFactualClaims(brief, axisId) {
  const claims = (brief.factual_claims || []).filter(c => c && c.claim && c.needs_verification);
  const verified_facts = [];
  for (const c of claims.slice(0, 6)) {
    try {
      const result = verifyClaim({
        claim: c.claim,
        url: c.source_url || undefined,
        axis: axisId || undefined,
      });
      if (result && result.status) {
        verified_facts.push({
          claim: c.claim,
          status: String(result.status).toUpperCase(),
          confidence: result.confidence,
          finding: result.summary || '',
          lens_url: result.lens_url || '',
          source_url: c.source_url || '',
        });
      }
    } catch (e) {
      console.warn(`[synthesize] verifyClaim failed for "${c.claim.slice(0, 50)}": ${e.message}`);
    }
  }
  return verified_facts;
}

// ── Public API ──────────────────────────────────────────────────────────────

async function synthesizeCase({ topic, axisId, journals, discourseDigest, feedDigest, caseSeed, useCache = true }) {
  ensureCacheDir();

  let caseInfo;
  if (caseSeed && String(caseSeed).trim()) {
    console.log(`[synthesize] using forced case seed: "${caseSeed}"`);
    caseInfo = {
      event_headline: String(caseSeed).trim(),
      case_slug: slugify(caseSeed),
      key_terms: String(caseSeed).split(/\s+/).filter(Boolean),
    };
  } else {
    console.log(`[synthesize] identifying case for topic: ${topic}`);
    caseInfo = await identifyCase({ topic, journals, discourseDigest, feedDigest });
  }
  const slug = slugify(caseInfo.case_slug || caseInfo.event_headline);
  const cachePath = path.join(CACHE_DIR, `${slug}.json`);

  if (useCache && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const ageHours = (Date.now() - new Date(cached.generated_at).getTime()) / 3_600_000;
    if (ageHours < 12) {
      console.log(`[synthesize] using cached synthesis (${ageHours.toFixed(1)}h old): ${slug}`);
      return cached;
    }
  }

  console.log(`[synthesize] building factual brief: ${caseInfo.event_headline}`);
  const brief = await buildBrief({ caseInfo, journals, discourseDigest, feedDigest });

  // Empty-brief guard: refuse to compose when the brief has no factual ground.
  // Without chronology + actors + frames, the writer has nothing to constrain it
  // and convictions will fabricate the case. This was the original failure mode.
  const chronCount  = (brief.chronology || []).length;
  const actorCount  = (brief.key_actors || []).length;
  const framesCount = (brief.competing_frames || []).length;
  if (chronCount === 0 && actorCount === 0 && framesCount === 0) {
    throw new Error(
      `synthesis brief is empty for case "${caseInfo.event_headline}" — ` +
      `no chronology, actors, or frames found in source material. ` +
      `Refusing to compose; the writer would fabricate.`
    );
  }

  console.log(`[synthesize] brief: ${chronCount} chronology, ${actorCount} actors, ${framesCount} frames`);
  console.log(`[synthesize] verifying ${(brief.factual_claims || []).length} factual claims...`);
  const verified_facts = await verifyFactualClaims(brief, axisId);

  const synthesis = {
    case_slug: slug,
    event_headline: caseInfo.event_headline,
    generated_at: new Date().toISOString(),
    topic,
    chronology: brief.chronology || [],
    key_actors: brief.key_actors || [],
    factual_claims: brief.factual_claims || [],
    verified_facts,
    disputed_claims: brief.disputed_claims || [],
    competing_frames: brief.competing_frames || [],
    primary_sources: brief.primary_sources || [],
  };

  fs.writeFileSync(cachePath, JSON.stringify(synthesis, null, 2));
  console.log(`[synthesize] cached → ${path.relative(ROOT, cachePath)}`);
  return synthesis;
}

function renderSynthesisForPrompt(s) {
  const out = [];
  out.push(`CASE: ${s.event_headline}`);
  out.push('');
  if (s.chronology?.length) {
    out.push('## Chronology');
    s.chronology.forEach(e => {
      const src = e.source_url ? ` — ${e.source_url}` : '';
      out.push(`- ${e.date || '?'}: ${e.actor || '?'} — ${e.action || ''}${src}`);
    });
    out.push('');
  }
  if (s.key_actors?.length) {
    out.push('## Key actors and their stated positions');
    s.key_actors.forEach(a => {
      out.push(`- ${a.name} (${a.role}): ${a.stated_position}`);
    });
    out.push('');
  }
  if (s.verified_facts?.length) {
    out.push('## Verification results (status drives how you must cite)');
    out.push('  Citation rules per status:');
    out.push('   - SUPPORTED: state as fact, link to lens_url.');
    out.push('   - REFUTED: do NOT assert this claim. May mention only as a debunked claim.');
    out.push('   - UNVERIFIED / CONTESTED / EXPIRED: must qualify ("reportedly", "allegedly",');
    out.push('     "according to X", "Iran alleges") — never state as established fact.');
    s.verified_facts.forEach(v => {
      const url = v.lens_url ? ` [${v.lens_url}]` : '';
      out.push(`- [${v.status}] ${v.claim} — ${v.finding}${url}`);
    });
    out.push('');
  }
  if (s.disputed_claims?.length) {
    out.push('## Disputed claims');
    s.disputed_claims.forEach(d => {
      out.push(`- ${d.claim} — competing: ${d.competing_accounts}`);
    });
    out.push('');
  }
  if (s.competing_frames?.length) {
    out.push('## Competing frames present in the discourse');
    s.competing_frames.forEach(f => {
      out.push(`- "${f.frame}" (advanced by ${f.proponents}): ${f.summary}`);
    });
    out.push('');
  }
  return out.join('\n').trim();
}

module.exports = { synthesizeCase, renderSynthesisForPrompt, identifyCase };
