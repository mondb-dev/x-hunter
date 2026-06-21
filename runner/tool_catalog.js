#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./lib/config');

function main() {
  const rows = [];
  if (!fs.existsSync(config.TOOLS_DIR)) {
    process.stdout.write('[]');
    return;
  }

  const files = fs.readdirSync(config.TOOLS_DIR)
    .filter(file => file.endsWith('.js'))
    .sort();

  for (const file of files) {
    const fullPath = path.join(config.TOOLS_DIR, file);
    try {
      delete require.cache[require.resolve(fullPath)];
    } catch {}

    try {
      const mod = require(fullPath);
      rows.push({
        file,
        name: mod.name,
        description: mod.description,
        parameters: mod.parameters || null,
        version: mod.version || '0.1.0',
        tags: mod.tags || [],
        capabilities: mod.capabilities || null,
        hasExecute: typeof mod.execute === 'function',
      });
    } catch (e) {
      rows.push({
        file,
        error: e.message,
      });
    }
  }

  process.stdout.write(JSON.stringify(rows));
}

main();
