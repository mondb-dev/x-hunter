#!/usr/bin/env node
'use strict';

const { runProcessReflection } = require('./lib/process_reflection');

(async function main() {
  try {
    const result = await runProcessReflection({
      source: 'daily',
      reportsLimit: 3,
    });

    if (result.status === 'completed' && result.proposalTitle) {
      console.log(`[process_reflection] proposal written: ${result.proposalTitle}`);
      return;
    }

    if (result.status === 'completed') {
      console.log(`[process_reflection] completed: ${result.reason}`);
      return;
    }

    if (result.status === 'skipped') {
      console.log(`[process_reflection] skipped: ${result.reason}`);
      return;
    }

    console.log(`[process_reflection] failed: ${result.reason}`);
  } catch (err) {
    console.error(`[process_reflection] failed: ${err.message}`);
  }
})();
