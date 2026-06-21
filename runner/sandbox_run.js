#!/usr/bin/env node
'use strict';

const { scanTools, resolveExecutionPlan } = require('./lib/tools');
const { executeSandboxedTool } = require('./lib/sandbox');

// Keep stdout reserved for the final JSON result.
console.log = (...args) => {
  process.stderr.write(args.join(' ') + '\n');
};

async function main() {
  const toolName = process.argv[2];
  const encodedArgs = process.argv[3] || '';

  if (!toolName) {
    process.stderr.write('Usage: node runner/sandbox_run.js <tool_name> <base64_args_json>\n');
    process.exit(1);
  }

  let args = {};
  if (encodedArgs) {
    try {
      args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf-8'));
    } catch (e) {
      process.stdout.write(JSON.stringify({
        tool: toolName,
        status: 'error',
        error: `Invalid tool args: ${e.message}`,
        duration_ms: 0,
      }));
      return;
    }
  }

  try {
    const registry = scanTools();
    const plan = resolveExecutionPlan(toolName, registry);
    const result = await executeSandboxedTool({
      toolName,
      args,
      readPatterns: plan.readPatterns,
      writePatterns: plan.writePatterns,
    });
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stdout.write(JSON.stringify({
      tool: toolName,
      status: 'error',
      error: e.message,
      duration_ms: 0,
    }));
  }
}

main().catch(err => {
  process.stdout.write(JSON.stringify({
    tool: process.argv[2] || '__unknown__',
    status: 'error',
    error: err.message,
    duration_ms: 0,
  }));
});
