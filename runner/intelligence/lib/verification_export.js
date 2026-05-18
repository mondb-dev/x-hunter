/**
 * runner/intelligence/lib/verification_export.js — export claim_verifications to JSON for web
 *
 * Reads all verifications from the DB and writes state/verification_export.json.
 * Used by both the batch pipeline and on-demand verification.
 *
 * Exports:
 *   exportVerificationData(vdb, exportPath) → void
 */

'use strict';

const fs = require('fs');

function log(msg) { console.log(`[verification_export] ${msg}`); }

/**
 * Filter out ephemeral Vertex AI grounding redirect URLs.
 */
function filterStableUrls(urls) {
  return (urls || []).filter(u => !String(u).includes('vertexaisearch.cloud.google.com'));
}

/**
 * Composite display relevance score (0–1).
 * Weights: confidence 30%, source tier 20%, axis-linked 20%,
 *          tweet posted 15%, deep investigation 10%, reverification 5%.
 */
function computeDisplayScore(c) {
  const tierNorm = c.source_tier ? Math.min((6 - c.source_tier) / 4, 1) : 0;
  return (
    0.30 * (c.confidence_score || 0) +
    0.20 * tierNorm +
    0.20 * (c.related_axis_id ? 1 : 0) +
    0.15 * (c.tweet_posted ? 1 : 0) +
    0.10 * (c.investigation_depth === 'deep' ? 1 : 0) +
    0.05 * Math.min((c.verification_count || 0) / 3, 1)
  );
}

/**
 * Export all claim verifications to JSON for the web frontend.
 *
 * @param {object} vdb - verification DB module (must have getAllVerifications())
 * @param {string} exportPath - absolute path to write the JSON file
 * @returns {Promise<void>}
 */
async function exportVerificationData(vdb, exportPath) {
  try {
    const all = await Promise.resolve(vdb.getAllVerifications());
    const visible = all.filter(c => !c.is_suppressed);
    const stats = { total: visible.length, supported: 0, refuted: 0, contested: 0, unverified: 0, expired: 0 };
    for (const c of visible) { stats[c.status] = (stats[c.status] || 0) + 1; }

    const exportData = {
      generated_at: new Date().toISOString(),
      stats,
      claims: visible.map(c => {
        const claim = {
          claim_id:           c.claim_id,
          claim_text:         c.claim_text,
          status:             c.status,
          confidence_score:   c.confidence_score,
          display_score:      Math.round(computeDisplayScore(c) * 1000) / 1000,
          scoring_breakdown:  c.scoring_breakdown,
          source_handle:      c.source_handle,
          source_tier:        c.source_tier,
          evidence_urls:      filterStableUrls(c.evidence_urls),
          tweet_url:          c.tweet_url,
          category:           c.category,
          related_axis_id:    c.related_axis_id,
          verification_count: c.verification_count,
          verified_at:        c.last_verified_at,
          created_at:         c.created_at,
          original_source:    c.original_source || null,
          claim_date:         c.claim_date || null,
          supporting_sources: c.supporting_sources || [],
          dissenting_sources: c.dissenting_sources || [],
          framing_analysis:   c.framing_analysis || null,
          web_search_summary: c.web_search_summary || null,
          investigation_depth: c.investigation_depth || 'quick',
        };

        // Include investigation data if available
        if (c.investigation_id && typeof vdb.getInvestigation === 'function') {
          try {
            const inv = vdb.getInvestigation(c.investigation_id);
            if (inv) {
              claim.investigation = {
                investigation_id: inv.investigation_id,
                sub_questions:    inv.sub_questions || [],
                attribution_chain: inv.attribution_chain || [],
                supporting_evidence: inv.supporting_evidence || [],
                contradicting_evidence: inv.contradicting_evidence || [],
                overall_verdict:  inv.overall_verdict,
                summary:          inv.summary,
                key_finding:      inv.key_finding,
                duration_seconds: inv.duration_seconds,
                created_at:       inv.created_at,
              };
            }
          } catch {}
        }

        return claim;
      }),
    };

    fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');
    const suppressed = all.length - visible.length;
    log(`exported ${stats.total} claims (${suppressed} suppressed)`);
  } catch (err) {
    log(`error: ${err.message}`);
  }
}

module.exports = { exportVerificationData, filterStableUrls };
