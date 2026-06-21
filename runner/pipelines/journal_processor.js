'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeTextForTactics } = require('./tactic_tracker');
const config = require('../lib/config');

const STATE_FILE = path.join(config.STATE_DIR, 'tactic_tracker.json');
const JOURNALS_DIR = path.join(config.PROJECT_ROOT, 'journals');

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

function getLatestJournal() {
  if (!fs.existsSync(JOURNALS_DIR)) {
    return null;
  }
  const files = fs.readdirSync(JOURNALS_DIR).filter(f => f.endsWith('.html'));
  if (files.length === 0) {
    return null;
  }
  // Files are named YYYY-MM-DD_HH.html, so sorting alphabetically works
  files.sort().reverse();
  return files[0];
}

/**
 * Basic HTML to text conversion.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function main() {
  console.log('[journal_processor] Starting politicization tactic analysis for journals.');

  const latestJournalFile = getLatestJournal();
  if (!latestJournalFile) {
    console.log('[journal_processor] No journals found. Skipping.');
    return;
  }

  const state = loadState();

  if (state.last_processed_journal === latestJournalFile) {
    console.log(`[journal_processor] Latest journal '${latestJournalFile}' already processed. Skipping.`);
    return;
  }

  const journalPath = path.join(JOURNALS_DIR, latestJournalFile);
  const journalContent = fs.readFileSync(journalPath, 'utf8');
  const textContent = stripHtml(journalContent);

  const findings = analyzeTextForTactics(textContent);

  if (Object.keys(findings).length === 0) {
    console.log(`[journal_processor] No new tactics found in journal '${latestJournalFile}'.`);
    state.last_processed_journal = latestJournalFile;
    state.updated_at = new Date().toISOString();
    saveState(state);
    return;
  }

  console.log(`[journal_processor] Found ${Object.keys(findings).length} types of tactics in '${latestJournalFile}'.`);

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
      source: `journal:${latestJournalFile}`,
      count: newCount,
    });
    if (state.by_tactic[tacticId].history.length > 50) {
        state.by_tactic[tacticId].history.shift();
    }
  }

  state.last_processed_journal = latestJournalFile;
  state.updated_at = new Date().toISOString();
  saveState(state);

  console.log('[journal_processor] Tactic tracker state updated successfully.');
}

if (require.main === module) {
  main();
}

module.exports = main;
