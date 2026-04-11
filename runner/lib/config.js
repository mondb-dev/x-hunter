'use strict';

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const RUNNER_DIR = path.join(PROJECT_ROOT, 'runner');

module.exports = {
  // ── Timing ────────────────────────────────────────────────────────────────
  BROWSE_INTERVAL: 1800,       // 30 min default \u2014 cadence can override [900-3600]
  TWEET_EVERY: 6,              // tweet on cycles 6, 12, 18, ... (default, cadence can override)
  QUOTE_OFFSET: 3,             // quote-tweet on cycles 3, 9, 15, ... (default)
  CURIOSITY_EVERY: 12,         // refresh curiosity directive every ~4h

  // ── Hours (UTC) ───────────────────────────────────────────────────────────
  TWEET_START: 7,              // earliest hour to post original tweets
  TWEET_END: 23,               // latest hour (exclusive)

  // ── Ports ─────────────────────────────────────────────────────────────────
  CDP_PORT: 18801,             // Chrome DevTools Protocol port

  // ── Dates ─────────────────────────────────────────────────────────────────
  AGENT_START_DATE: '2026-02-23',

  // ── Paths ─────────────────────────────────────────────────────────────────
  PROJECT_ROOT,
  STATE_DIR,
  RUNNER_DIR,
  JOURNALS_DIR: path.join(PROJECT_ROOT, 'journals'),
  SCRAPER_DIR: path.join(PROJECT_ROOT, 'scraper'),
  STREAM_DIR: path.join(PROJECT_ROOT, 'stream'),

  // State files
  ONTOLOGY_PATH: path.join(STATE_DIR, 'ontology.json'),
  POSTS_LOG_PATH: path.join(STATE_DIR, 'posts_log.json'),
  BELIEF_STATE_PATH: path.join(STATE_DIR, 'belief_state.json'),
  BROWSE_NOTES_PATH: path.join(STATE_DIR, 'browse_notes.md'),
  FEED_DIGEST_PATH: path.join(STATE_DIR, 'feed_digest.txt'),
  TOPIC_SUMMARY_PATH: path.join(STATE_DIR, 'topic_summary.txt'),
  TWEET_DRAFT_PATH: path.join(STATE_DIR, 'tweet_draft.txt'),
  QUOTE_DRAFT_PATH: path.join(STATE_DIR, 'quote_draft.txt'),
  CURIOSITY_DIRECTIVE_PATH: path.join(STATE_DIR, 'curiosity_directive.txt'),
  SPRINT_CONTEXT_PATH: path.join(STATE_DIR, 'sprint_context.txt'),
  DISCOURSE_DIGEST_PATH: path.join(STATE_DIR, 'discourse_digest.txt'),
  READING_URL_PATH: path.join(STATE_DIR, 'reading_url.txt'),
  CLAIM_TRACKER_PATH: path.join(STATE_DIR, 'claim_tracker.json'),
  CLAIM_TRACKER_DELTA_PATH: path.join(STATE_DIR, 'claim_tracker_delta.json'),
  EXTERNAL_SOURCES_PATH: path.join(STATE_DIR, 'external_sources.json'),
  RESEARCH_BRIEFS_PATH: path.join(STATE_DIR, 'research_briefs.json'),
  MEMORY_RECALL_PATH: path.join(STATE_DIR, 'memory_recall.txt'),
  CRITIQUE_PATH: path.join(STATE_DIR, 'critique.md'),
  PREFETCH_SOURCE_PATH: path.join(STATE_DIR, 'prefetch_source.txt'),
  SOURCE_PLAN_PATH: path.join(STATE_DIR, 'source_plan.json'),
  SIGNAL_DRAFT_PATH: path.join(STATE_DIR, 'signal_draft.txt'),
  SIGNAL_LOG_PATH: path.join(STATE_DIR, 'signal_log.jsonl'),
  VERIFICATION_EXPORT_PATH: path.join(STATE_DIR, 'verification_export.json'),
  VERIFICATION_DRAFT_PATH: path.join(STATE_DIR, 'verification_draft.txt'),
  PREDICTION_DRAFT_PATH: path.join(STATE_DIR, 'prediction_draft.txt'),
  PREDICTION_LOG_PATH: path.join(STATE_DIR, 'prediction_log.jsonl'),
  CADENCE_PATH: path.join(STATE_DIR, 'cadence.json'),
  X_CONTROL_PATH: path.join(STATE_DIR, 'x_control.json'),
  CAPTURE_STATE_PATH: path.join(STATE_DIR, 'capture_state.json'),
  POSTING_DIRECTIVE_PATH: path.join(STATE_DIR, 'posting_directive.txt'),
  COMMENT_CANDIDATES_PATH: path.join(STATE_DIR, 'comment_candidates.txt'),
  BROWSE_ARCHIVE_PATH: path.join(STATE_DIR, 'browse_archive.md'),
  ACTIVE_PLAN_PATH: path.join(STATE_DIR, 'active_plan.json'),
  ENGAGEMENT_SUMMARY_PATH: path.join(STATE_DIR, 'engagement_summary.json'),
  LAST_DAILY_PATH: path.join(STATE_DIR, 'last_daily_at.txt'),
  HEARTBEAT_PATH: path.join(PROJECT_ROOT, 'HEARTBEAT.md'),
  INDEX_DB_PATH: path.join(STATE_DIR, 'index.db'),

  // META cycle state
  PROCESS_PROPOSAL_PATH: path.join(STATE_DIR, 'process_proposal.json'),
  PROPOSAL_HISTORY_PATH: path.join(STATE_DIR, 'proposal_history.json'),
  PROCESS_REFLECTION_STATE_PATH: path.join(STATE_DIR, 'process_reflection_state.json'),
  META_LAST_RUN_PATH: path.join(STATE_DIR, 'meta_last_run.txt'),
  META_FAILURE_STATE_PATH: path.join(STATE_DIR, 'meta_failure_count.json'),
  STAGING_DIR: path.join(PROJECT_ROOT, 'staging'),

  // Tool system
  TOOLS_DIR: path.join(PROJECT_ROOT, 'tools'),
  TOOL_REQUEST_PATH: path.join(STATE_DIR, 'tool_request.json'),
  TOOL_RESULT_PATH: path.join(STATE_DIR, 'tool_result.json'),
  TOOL_TIMEOUT_MS: 30_000,
  WORKFLOW_TIMEOUT_MS: 120_000,
  SANDBOXES_DIR: path.join(STATE_DIR, 'sandboxes'),
  SANDBOX_REAP_MAX_AGE_MS: 6 * 60 * 60 * 1000,
  SANDBOX_STDIO_MAX_BYTES: 64 * 1024,
  SANDBOX_MAX_OLD_SPACE_MB: 96,

  // Runner files
  RUNNER_LOG_PATH: path.join(RUNNER_DIR, 'runner.log'),
  ORCHESTRATOR_LOG_PATH: path.join(RUNNER_DIR, 'orchestrator.log'),
  LOCKDIR: path.join(RUNNER_DIR, 'run.lock'),
  PIDFILE: path.join(RUNNER_DIR, 'run.pid'),
  PAUSE_FILE: path.join(RUNNER_DIR, 'PAUSE'),

  // ── Log rotation limits ───────────────────────────────────────────────────
  RUNNER_LOG_MAX_LINES: 5000,
  SCRAPER_LOG_MAX_LINES: 3000,
  DIGEST_MAX_LINES: 3000,
  BROWSE_ARCHIVE_MAX_LINES: 6000,
};
