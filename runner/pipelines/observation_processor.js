'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzeTextForTactics } = require('./tactic_tracker');
const config = require('../lib/config');

const STATE_FILE = path.join(config.STATE_DIR, 'tactic_tracker.json');
const DIGEST_FILE = path.join(config.STATE_DIR, 'feed_digest.txt');

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return {
    by_tactic: {},
    last_processed_journal: null,
    last_processed_digest_checksum: null,
    updated_at: null,
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getFileChecksum(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function main() {
  console.log('[observation_processor] Starting politicization tactic analysis for feed digest.');

  if (!fs.existsSync(DIGEST_FILE)) {
    console.log('[observation_processor] Digest file not found. Skipping.');
    return;
  }

  const state = loadState();
  const digestContent = fs.readFileSync(DIGEST_FILE, 'utf8');
  const currentChecksum = getFileChecksum(DIGEST_FILE);

  if (state.last_processed_digest_checksum === currentChecksum) {
      console.log('[observation_processor] Feed digest has not changed. Skipping.');
      return;
  }

  const findings = analyzeTextForTactics(digestContent);

  if (Object.keys(findings).length === 0) {
    console.log('[observation_processor] No new tactics found in feed digest.');
    state.last_processed_digest_checksum = currentChecksum;
    state.updated_at = new Date().toISOString();
    saveState(state);
    return;
  }

  console.log(`[observation_processor] Found ${Object.keys(findings).length} types of tactics.`);

  for (const tacticId in findings) {
    if (!state.by_tactic[tacticId]) {
      state.by_tactic[tacticId] = {
        label: findings[tacticId].label,
        count: 0,
        history: [],
      };
    }
    const newCount = findings[tacticId].count;
    state.by_tactic[tacticId].count += newCount;
    state.by_tactic[tacticId].history.push({
      timestamp: new Date().toISOString(),
      source: 'feed_digest',
      count: newCount,
    });
    // Keep history from getting too large
    if (state.by_tactic[tacticId].history.length > 50) {
        state.by_tactic[tacticId].history.shift();
    }
  }

  state.last_processed_digest_checksum = currentChecksum;
  state.updated_at = new Date().toISOString();
  saveState(state);

  console.log('[observation_processor] Tactic tracker state updated successfully.');
}

if (require.main === module) {
  main();
}

module.exports = main;
