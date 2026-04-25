'use strict';

const fs = require('fs');
const path = require('path');

const NARRATIVES_PATH = path.join(process.cwd(), 'state', 'narratives.json');

/**
 * Loads the narrative state from state/narratives.json
 * @returns {object} The narrative state object.
 */
function load() {
  try {
    if (fs.existsSync(NARRATIVES_PATH)) {
      const content = fs.readFileSync(NARRATIVES_PATH, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Error loading narrative state:', error);
    // On error, return a default state to prevent crashes downstream.
  }
  // Return default state if file doesn't exist or there was an error.
  return { contested_topics: {}, last_processed_cluster: null };
}

/**
 * Saves the narrative state to state/narratives.json
 * @param {object} state The narrative state object to save.
 */
function save(state) {
  try {
    const data = JSON.stringify(state, null, 2);
    // Ensure the state directory exists
    const stateDir = path.dirname(NARRATIVES_PATH);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    fs.writeFileSync(NARRATIVES_PATH, data, 'utf8');
  } catch (error) {
    console.error('Error saving narrative state:', error);
  }
}

module.exports = {
  load,
  save,
};
