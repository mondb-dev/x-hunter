'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const TACTIC_DEFINITIONS = require('../lib/tactic_definitions');

const STATE_FILE = path.join(config.STATE_DIR, 'tactic_tracker.json');

function generateReport() {
    if (!fs.existsSync(STATE_FILE)) {
        return "<!-- Tactic tracker state file not found. -->\n";
    }

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const tactics = state.by_tactic || {};

    if (Object.keys(tactics).length === 0) {
        return "### Politicization Tactic Tracking\n\nNo specific rhetorical tactics related to the politicization of justice were detected in the last 24 hours.\n";
    }

    // Create a map of definitions for easy lookup
    const definitions = TACTIC_DEFINITIONS.reduce((acc, tactic) => {
        acc[tactic.id] = tactic.description;
        return acc;
    }, {});

    const sortedTactics = Object.entries(tactics).sort(([, a], [, b]) => b.count - a.count);

    let markdown = "### Politicization Tactic Tracking\n\n";
    markdown += "Analysis of discourse for rhetorical tactics used to undermine or politicize accountability processes. The following patterns were observed:\n\n";
    markdown += "| Tactic | Total Detections | Description |\n";
    markdown += "|:---|:---:|:---|\n";

    for (const [id, data] of sortedTactics) {
        const description = definitions[id] || 'No description available.';
        markdown += `| **${data.label}** | ${data.count} | *${description}* |\n`;
    }

    markdown += "\nThis data helps track evolving patterns in narrative control strategies related to institutional integrity.\n";

    return markdown;
}

function main() {
    const report = generateReport();
    // This script will just print the markdown to stdout.
    // The calling process (e.g., daily.js) is expected to capture this output
    // and append it to the main daily report file.
    process.stdout.write(report);
}

if (require.main === module) {
    main();
}

module.exports = { generateReport };
