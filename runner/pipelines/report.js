'use strict';

const fs = require('fs');
const path = require('path');
const narratives = require('../lib/narratives.js');

const getReportPath = () => {
  const today = new Date().toISOString().split('T')[0];
  const reportDir = path.join(process.cwd(), 'daily');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  return path.join(reportDir, `belief_report_${today}.md`);
};

function generateNarrativeReport(contestedTopics) {
  if (!contestedTopics || Object.keys(contestedTopics).length === 0) {
    return '';
  }

  let markdown = '## Narrative Contestation Map\n\n';
  markdown += 'This section tracks competing narratives around contentious topics.\n\n';

  for (const topic of Object.values(contestedTopics)) {
    markdown += `### Topic: ${topic.keywords.join(', ')}\n\n`;

    const narratives = Object.values(topic.narratives);
    if (narratives.length < 2) {
      markdown += '_Waiting for competing narratives to emerge._\n\n';
      continue;
    }

    for (const narrative of narratives) {
      const summary = narrative.id.replace(/_/g, ' ');
      markdown += `*   **Narrative (${summary})**: Promoted by ${narrative.sources.length} source(s), e.g., ${narrative.sources.slice(0, 3).join(', ')}.\n`;
      const samplePost = narrative.posts[0];
      if (samplePost && samplePost.text) {
        markdown += `    > Example claim: "${samplePost.text.substring(0, 80)}..."\n`;
      }
    }
    markdown += '\n';
  }

  return markdown;
}

function main() {
  console.log('Generating narrative section for daily report...');

  const reportPath = getReportPath();
  const state = narratives.load();

  if (!state || !state.contested_topics) {
    console.error('Contested topics state is missing or invalid. Aborting report generation.');
    return;
  }

  const reportContent = generateNarrativeReport(state.contested_topics);

  if (!reportContent) {
    console.log('No contested topics with sufficient data to report. Skipping.');
    return;
  }

  const marker = '<!-- NARRATIVE_CONTESTATION_MAP -->';
  let existingReport = '';
  if (fs.existsSync(reportPath)) {
    existingReport = fs.readFileSync(reportPath, 'utf8');
  }

  if (existingReport.includes(marker)) {
    console.log('Narrative report section already exists. Skipping update.');
    return;
  }

  const finalReportContent = `\n${marker}\n${reportContent}${marker}\n`;

  fs.appendFileSync(reportPath, finalReportContent, 'utf8');
  console.log(`Appended narrative contestation map to ${reportPath}`);
}

if (require.main === module) {
  main();
}
