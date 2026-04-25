'use strict';

const fs = require('fs');
const path = require('path');
const narratives = require('../lib/narratives.js');
const { trackContestation, parseFeedDigest } = require('../modules/narrative_tracker.js');

const FEED_DIGEST_PATH = path.join(process.cwd(), 'state', 'feed_digest.txt');

function main() {
  console.log('Starting narrative contestation tracking...');

  if (!fs.existsSync(FEED_DIGEST_PATH)) {
    console.log('No feed digest found. Skipping.');
    return;
  }

  const rawContent = fs.readFileSync(FEED_DIGEST_PATH, 'utf8');
  const clusters = parseFeedDigest(rawContent);

  if (clusters.length === 0) {
    console.log('Feed digest is empty or failed to parse. Skipping.');
    return;
  }

  console.log(`Processing ${clusters.length} clusters...`);

  const state = narratives.load();
  const updatedState = trackContestation(clusters, state);
  narratives.save(updatedState);

  console.log('Narrative contestation tracking complete.');
  if (updatedState && updatedState.contested_topics) {
    console.log(`Updated state for ${Object.keys(updatedState.contested_topics).length} topics.`);
  }
}

if (require.main === module) {
  main();
}
