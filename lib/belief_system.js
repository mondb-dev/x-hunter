'use strict';

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT      = path.resolve(__dirname, '..');
const STATE_DIR         = path.join(PROJECT_ROOT, 'state');
const ONTOLOGY_PATH     = path.join(STATE_DIR, 'ontology.json');
const BELIEF_STATE_PATH = path.join(STATE_DIR, 'belief_state.json');

/**
 * Load and return the ontology object.
 * @returns {{ axes: object[], axis_creation_rules_version: number, last_updated: string }}
 */
function loadOntology() {
  if (!fs.existsSync(ONTOLOGY_PATH)) {
    throw new Error('ontology.json not found at ' + ONTOLOGY_PATH);
  }
  return JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf-8'));
}

/**
 * Load and return the belief_state object.
 * @returns {{ day: number, scores: object, phase: string }}
 */
function loadBeliefState() {
  if (!fs.existsSync(BELIEF_STATE_PATH)) return { day: 0, scores: {}, phase: 'unknown' };
  return JSON.parse(fs.readFileSync(BELIEF_STATE_PATH, 'utf-8'));
}

/**
 * Detect stagnant axes: high confidence but no score change in last N days.
 * @param {object} ontology      - Result of loadOntology()
 * @param {number} days          - Lookback window (default 3)
 * @param {number} minConfidence - Minimum confidence to flag (default 0.80)
 * @returns {object[]} Stagnant axis objects with diagnostic fields
 */
function detectStagnantAxes(ontology, days, minConfidence) {
  if (days === undefined) days = 3;
  if (minConfidence === undefined) minConfidence = 0.80;

  const cutoff  = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stagnant = [];

  for (const axis of (ontology.axes || [])) {
    if ((axis.confidence || 0) < minConfidence) continue;

    const log     = axis.evidence_log || [];
    const lastUpd = axis.last_updated ? new Date(axis.last_updated) : null;
    const daysSince = lastUpd
      ? (Date.now() - lastUpd.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    const recent       = log.filter(e => e.timestamp && new Date(e.timestamp) >= cutoff);
    const recentScores = recent.map(e => e.score_after).filter(s => typeof s === 'number');
    const scoreRange   = recentScores.length >= 2
      ? Math.max(...recentScores) - Math.min(...recentScores)
      : 0;

    const isStagnant = recent.length === 0 || scoreRange < 0.001;

    if (isStagnant) {
      stagnant.push({
        id:                 axis.id,
        label:              axis.label,
        score:              axis.score,
        confidence:         axis.confidence,
        last_updated:       axis.last_updated || null,
        days_since_update:  Math.round(daysSince * 10) / 10,
        total_evidence:     log.length,
        recent_evidence:    recent.length,
        score_range_window: Math.round(scoreRange * 10000) / 10000,
        topics:             axis.topics || [],
      });
    }
  }

  return stagnant;
}

module.exports = { loadOntology, loadBeliefState, detectStagnantAxes };
