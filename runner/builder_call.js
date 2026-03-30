#!/usr/bin/env node
/**
 * runner/builder_call.js — Subprocess wrapper for calling builder Vertex AI
 *
 * Called by orchestrator.js via execSync to keep the main loop synchronous.
 * Reads prompt from file path passed as argv[2], calls builder, writes response to stdout.
 */
"use strict";

const fs = require("fs");
const { callBuilder } = require("./builder_vertex");

const promptPath = process.argv[2];
if (!promptPath) {
  process.stderr.write("Usage: node builder_call.js <prompt_file_path>\n");
  process.exit(1);
}

const prompt = fs.readFileSync(promptPath, "utf-8");

(async () => {
  const result = await callBuilder(prompt, 16384, { thinkingBudget: 8192 });
  process.stdout.write(result);
})().catch(e => {
  process.stderr.write(e.message);
  process.exit(1);
});
