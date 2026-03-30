#!/usr/bin/env node
"use strict";

const db = require("../scraper/db");

try {
  const result = db.checkAndHealFts();
  if (result.rebuilt) {
    const failed = result.errors.map((err) => `${err.table}: ${err.message}`).join(" | ");
    if (!result.healthy) {
      console.error(`[fts] rebuild attempted but indexes remain unhealthy (${failed})`);
      process.exit(1);
    }
    console.log(`[fts] rebuilt indexes after integrity failure (${failed})`);
  }
} catch (error) {
  console.error(`[fts] maintenance failed: ${error.message}`);
  process.exit(1);
}
