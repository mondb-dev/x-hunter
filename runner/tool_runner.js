#!/usr/bin/env node
'use strict';

const { scanTools, executeSingle } = require('./lib/tools');

// Keep stdout reserved for the final JSON result.
console.log = (...args) => {
  process.stderr.write(args.join(' ') + '\n');
};

const toolName = process.argv[2];
const encodedArgs = process.argv[3] || '';

if (!toolName) {
  process.stderr.write('Usage: node runner/tool_runner.js <tool_name> <base64_args_json>\n');
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
    process.exit(0);
  }
}

const result = executeSingle(toolName, args, scanTools());
process.stdout.write(JSON.stringify(result));
