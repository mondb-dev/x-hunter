'use strict';

/**
 * First-run prompt — profile setup + intro tweet + first browse pass.
 * Used only when JOURNAL_COUNT === 0 (no journals exist yet).
 */
module.exports = function buildFirstRunPrompt(ctx) {
  return 'Today is ' + ctx.today + ' ' + ctx.now +
    '. This is the very first run -- total_posts is 0.\n' +
    '\n' +
    'Follow BOOTSTRAP.md section 6 (profile setup) and 6b (seed tweet) and 6c (intro tweet) first.\n' +
    '\n' +
    'After the intro tweet, do a first browse pass:\n' +
    '1. Read state/browse_notes.md (empty on first run).\n' +
    '2. Navigate to https://x.com -- scroll the feed, read at least 15 posts end to end.\n' +
    '3. Click into at least 3 threads that catch your attention and read the replies.\n' +
    '4. Navigate to https://x.com/search?q=... on 2 topics that interested you and read 10 more posts each.\n' +
    '5. Append everything notable to state/browse_notes.md (quotes, tensions, source URLs).\n' +
    '6. Update state/ontology.json if anything is axis-worthy.\n' +
    '7. Done -- do not tweet again this cycle.\n';
};

// CLI mode
if (require.main === module) {
  const loadContext = require('./context');
  const ctx = loadContext({
    type: 'first_run',
    cycle: 1,
    dayNumber: parseInt(process.env.DAY_NUMBER || '1', 10),
    today: process.env.TODAY || new Date().toISOString().slice(0, 10),
    now:   process.env.NOW   || new Date().toTimeString().slice(0, 5),
    hour:  process.env.HOUR  || String(new Date().getHours()).padStart(2, '0'),
  });
  process.stdout.write(module.exports(ctx));
}
