'use strict';

const fs = require('fs');
const path = require('path');
const { processEvidence } = require('../lib/evidence_processor');
const { clusterThemes } = require('../lib/theme_clusterer');

// Note: Assuming project root contains state/, lib/, pipelines/
const PROJECT_ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const ONTOLOGY_PATH = path.join(STATE_DIR, 'ontology.json');
// Assuming feed digest is in JSONL format for structured data processing.
const DIGEST_PATH = path.join(STATE_DIR, 'feed_digest.jsonl');
const EMERGENT_THEMES_PATH = path.join(STATE_DIR, 'emergent_themes.json');

/**
 * Reads a JSONL file.
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line));
}

/**
 * Main pipeline for processing evidence, identifying unmapped themes, and clustering them.
 */
function run() {
    console.log('Starting emergent theme pipeline...');

    // 1. Load inputs
    if (!fs.existsSync(ONTOLOGY_PATH)) {
        console.error(`Ontology file not found at ${ONTOLOGY_PATH}`);
        process.exit(1);
    }
    if (!fs.existsSync(DIGEST_PATH)) {
        console.warn(`Feed digest not found at ${DIGEST_PATH}. Nothing to process.`);
        return;
    }

    const ontology = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf-8'));
    const evidenceDigest = readJsonl(DIGEST_PATH);
    const emergentThemesState = fs.existsSync(EMERGENT_THEMES_PATH)
        ? JSON.parse(fs.readFileSync(EMERGENT_THEMES_PATH, 'utf-8'))
        : { unmapped_items: [], clusters: [] };

    const existingUnmappedIds = new Set(emergentThemesState.unmapped_items.map(item => item.id));
    const newUnmappedItems = [];

    console.log(`Processing ${evidenceDigest.length} items from feed digest...`);

    // 2. Process evidence and identify unmapped items
    for (const evidence of evidenceDigest) {
        if (!evidence.id || !evidence.keywords) continue;

        if (existingUnmappedIds.has(evidence.id)) {
            continue;
        }

        const result = processEvidence(evidence, ontology);
        if (result.is_mapped) {
            // In a full implementation, this would trigger an ontology update.
            // For now, we just log it.
        } else {
            console.log(`Evidence ${evidence.id} is unmapped. Adding to pool for clustering.`);
            newUnmappedItems.push(evidence);
        }
    }

    if (newUnmappedItems.length === 0 && emergentThemesState.clusters.length > 0) {
        console.log('No new unmapped items found. Re-clustering not required. Pipeline finished.');
        return;
    }

    // 3. Combine old and new unmapped items
    const allUnmappedItems = [...emergentThemesState.unmapped_items, ...newUnmappedItems];

    console.log(`Found ${newUnmappedItems.length} new unmapped items. Total pool is ${allUnmappedItems.length}.`);

    // 4. Run clustering on all unmapped items
    console.log('Clustering unmapped items...');
    const newClusters = clusterThemes(allUnmappedItems);
    console.log(`Generated ${newClusters.length} significant clusters.`);

    // 5. Prepare and write new state file
    const finalState = {
        unmapped_items: allUnmappedItems,
        clusters: newClusters, // We replace the old clusters entirely on each run
    };

    try {
        fs.writeFileSync(EMERGENT_THEMES_PATH, JSON.stringify(finalState, null, 2));
        console.log(`Successfully updated ${EMERGENT_THEMES_PATH}`);
    } catch (error) {
        console.error(`Failed to write to ${EMERGENT_THEMES_PATH}:`, error);
        process.exit(1);
    }

    console.log('Emergent theme pipeline finished successfully.');
}

if (require.main === module) {
    // This allows the script to be run directly from the project root.
    run();
}

module.exports = { run };
