'use strict';
// runner/network_run.js - Async runner for network-capable tools.
// Uses scanToolsDirect() so _execute functions are available (bwrap sets them null).
console.log = function() { process.stderr.write(Array.from(arguments).join(' ') + '\n'); };

var toolName = process.argv[2];
var encodedArgs = process.argv[3] || '';

if (!toolName) {
  process.stderr.write('Usage: node runner/network_run.js <tool> <args>\n');
  process.exit(1);
}

function main() {
  var args = {};
  if (encodedArgs) {
    try {
      args = JSON.parse(Buffer.from(encodedArgs, 'base64').toString('utf-8'));
    } catch (e) {
      process.stdout.write(JSON.stringify({ tool: toolName, status: 'error', error: 'Invalid args: ' + e.message, duration_ms: 0 }));
      return;
    }
  }

  var tools = require('./lib/tools');
  var registry = tools.scanToolsDirect();
  var tool = registry.find(function(t) { return t.name === toolName; });

  if (!tool || !tool._execute) {
    process.stdout.write(JSON.stringify({ tool: toolName, status: 'error', error: 'Tool "' + toolName + '" not found or no execute fn', duration_ms: 0 }));
    return;
  }

  var start = Date.now();
  var result;
  try {
    result = tool._execute(args);
  } catch (e) {
    process.stdout.write(JSON.stringify({ tool: toolName, status: 'error', error: e.message, duration_ms: Date.now() - start }));
    return;
  }

  if (result && typeof result.then === 'function') {
    result.then(function(val) {
      process.stdout.write(JSON.stringify({ tool: toolName, status: 'success', result: val, duration_ms: Date.now() - start }));
    }).catch(function(e) {
      process.stdout.write(JSON.stringify({ tool: toolName, status: 'error', error: e.message, duration_ms: Date.now() - start }));
    });
  } else {
    process.stdout.write(JSON.stringify({ tool: toolName, status: 'success', result: result, duration_ms: Date.now() - start }));
  }
}

main();
