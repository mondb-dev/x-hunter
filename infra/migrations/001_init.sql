-- 001_init.sql — Full Postgres schema for Sebastian Hunter
-- Migrates 3 SQLite databases (intelligence.db, index.db, sprints.db) into one Postgres DB.
-- Run once: psql $DATABASE_URL -f 001_init.sql

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FROM: intelligence.db
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sources (
  handle                    TEXT PRIMARY KEY,
  credibility_tier          INTEGER,
  tier_label                TEXT,
  tier_confidence           TEXT,
  tier_notes                TEXT,
  political_lean            TEXT,
  domain                    TEXT,
  ng_no_false_content       INTEGER,
  ng_responsible_info       INTEGER,
  ng_corrects_errors        INTEGER,
  ng_news_vs_opinion        INTEGER,
  ng_no_deceptive_framing   INTEGER,
  ng_score                  REAL,
  ng_assessed_by            TEXT,
  ng_assessed_at            TEXT,
  ng_criteria_notes         TEXT,
  behavior_entry_count      INTEGER,
  behavior_citation_rate    REAL,
  behavior_stance_diversity REAL,
  behavior_novelty_avg      REAL,
  behavior_axis_spread      INTEGER,
  behavior_computed_at      TEXT,
  first_seen                TEXT,
  last_seen                 TEXT,
  created_at                TEXT,
  updated_at                TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id                    TEXT PRIMARY KEY,
  topic                 TEXT,
  category              TEXT,
  claim_text            TEXT,
  stance                TEXT,
  axis_id               TEXT,
  source_handle         TEXT,
  source_url            TEXT,
  source_tier           INTEGER,
  source_tier_label     TEXT,
  source_ng_score       REAL,
  source_lean           TEXT,
  has_supporting_url    INTEGER DEFAULT 0,
  corroborating_count   INTEGER DEFAULT 0,
  contradicting_count   INTEGER DEFAULT 0,
  status                TEXT DEFAULT 'unverified',
  status_updated_at     TEXT,
  status_notes          TEXT,
  observed_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS claim_groups (
  group_id        TEXT PRIMARY KEY,
  topic           TEXT,
  category        TEXT,
  canonical_text  TEXT,
  min_tier        INTEGER,
  claim_ids       TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS source_registry_log (
  id            SERIAL PRIMARY KEY,
  handle        TEXT,
  field_changed TEXT,
  old_value     TEXT,
  new_value     TEXT,
  changed_by    TEXT,
  changed_at    TEXT
);

CREATE TABLE IF NOT EXISTS claim_verifications (
  claim_id            TEXT PRIMARY KEY,
  claim_source        TEXT NOT NULL,
  claim_text          TEXT NOT NULL,
  confidence_score    REAL NOT NULL,
  scoring_breakdown   TEXT,
  status              TEXT NOT NULL DEFAULT 'unverified',
  verification_count  INTEGER DEFAULT 0,
  last_verified_at    TEXT,
  web_search_summary  TEXT,
  evidence_urls       TEXT,
  tweet_posted        INTEGER DEFAULT 0,
  tweet_url           TEXT,
  source_handle       TEXT,
  source_tier         INTEGER,
  related_axis_id     TEXT,
  category            TEXT,
  original_source     TEXT,
  claim_date          TEXT,
  supporting_sources  TEXT,
  dissenting_sources  TEXT,
  framing_analysis    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_cv_status ON claim_verifications(status);
CREATE INDEX IF NOT EXISTS idx_cv_score  ON claim_verifications(confidence_score);

CREATE TABLE IF NOT EXISTS claim_audit_log (
  id                  SERIAL PRIMARY KEY,
  claim_id            TEXT NOT NULL,
  claim_source        TEXT NOT NULL,
  old_status          TEXT,
  new_status          TEXT NOT NULL,
  confidence_score    REAL,
  scoring_breakdown   TEXT,
  verification_method TEXT,
  evidence_urls       TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_claim ON claim_audit_log(claim_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- FROM: index.db
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,
  ts                BIGINT NOT NULL,
  ts_iso            TEXT NOT NULL,
  username          TEXT NOT NULL,
  display_name      TEXT,
  text              TEXT NOT NULL,
  likes             INTEGER DEFAULT 0,
  rts               INTEGER DEFAULT 0,
  replies           INTEGER DEFAULT 0,
  velocity          REAL DEFAULT 0,
  trust             INTEGER DEFAULT 0,
  score             REAL DEFAULT 0,
  novelty           REAL DEFAULT 0,
  keywords          TEXT DEFAULT '',
  external_urls     TEXT DEFAULT '[]',
  external_domains  TEXT DEFAULT '[]',
  parent_id         TEXT DEFAULT NULL,
  scraped_at        BIGINT NOT NULL,
  media_type        TEXT DEFAULT 'none',
  media_description TEXT DEFAULT '',
  -- Postgres full-text search vector (replaces FTS5)
  tsv               TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_posts_ts       ON posts(ts DESC);
CREATE INDEX IF NOT EXISTS idx_posts_username  ON posts(username);
CREATE INDEX IF NOT EXISTS idx_posts_score     ON posts(score DESC);
CREATE INDEX IF NOT EXISTS idx_posts_parent    ON posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_novelty   ON posts(novelty DESC);
CREATE INDEX IF NOT EXISTS idx_posts_tsv       ON posts USING GIN(tsv);

-- Auto-update tsvector on insert/update
CREATE OR REPLACE FUNCTION posts_tsv_trigger() RETURNS TRIGGER AS $$
BEGIN
  NEW.tsv := to_tsvector('english',
    COALESCE(NEW.username, '') || ' ' ||
    COALESCE(NEW.text, '') || ' ' ||
    COALESCE(NEW.keywords, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_posts_tsv ON posts;
CREATE TRIGGER trg_posts_tsv
  BEFORE INSERT OR UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_tsv_trigger();

CREATE TABLE IF NOT EXISTS keywords (
  keyword   TEXT NOT NULL,
  post_id   TEXT NOT NULL,
  score     REAL DEFAULT 0,
  ts        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  PRIMARY KEY (keyword, post_id)
);

CREATE INDEX IF NOT EXISTS idx_kw_keyword ON keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_kw_ts      ON keywords(ts DESC);

CREATE TABLE IF NOT EXISTS accounts (
  username      TEXT PRIMARY KEY,
  post_count    INTEGER DEFAULT 0,
  avg_score     REAL DEFAULT 0,
  avg_velocity  REAL DEFAULT 0,
  top_keywords  TEXT DEFAULT '',
  first_seen    BIGINT NOT NULL,
  last_seen     BIGINT NOT NULL,
  follow_score  REAL DEFAULT 0,
  followed      INTEGER DEFAULT 0,
  followed_at   BIGINT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_follow_score ON accounts(follow_score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_last_seen    ON accounts(last_seen DESC);

CREATE TABLE IF NOT EXISTS memory (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  date         TEXT NOT NULL,
  hour         INTEGER DEFAULT NULL,
  title        TEXT NOT NULL,
  text_content TEXT NOT NULL,
  keywords     TEXT DEFAULT '',
  tx_id        TEXT DEFAULT NULL,
  file_path    TEXT NOT NULL UNIQUE,
  indexed_at   BIGINT NOT NULL,
  -- Postgres full-text search vector (replaces FTS5)
  tsv          TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_date ON memory(date DESC);
CREATE INDEX IF NOT EXISTS idx_memory_tsv  ON memory USING GIN(tsv);

-- Auto-update tsvector on insert/update
CREATE OR REPLACE FUNCTION memory_tsv_trigger() RETURNS TRIGGER AS $$
BEGIN
  NEW.tsv := to_tsvector('english',
    COALESCE(NEW.type, '') || ' ' ||
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.text_content, '') || ' ' ||
    COALESCE(NEW.keywords, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_tsv ON memory;
CREATE TRIGGER trg_memory_tsv
  BEFORE INSERT OR UPDATE ON memory
  FOR EACH ROW EXECUTE FUNCTION memory_tsv_trigger();

CREATE TABLE IF NOT EXISTS embeddings (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  vector       TEXT NOT NULL,
  embedded_at  BIGINT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(entity_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- FROM: sprints.db
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS plans (
  id              SERIAL PRIMARY KEY,
  plan_id         TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  compulsion      TEXT,
  brief           TEXT,
  success_30d     TEXT,
  belief_axes     TEXT,
  activated_date  TEXT NOT NULL,
  target_end_date TEXT,
  completed_date  TEXT,
  created_at      TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE TABLE IF NOT EXISTS sprints (
  id          SERIAL PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(plan_id),
  week        INTEGER NOT NULL,
  goal        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'not_started',
  start_date  TEXT,
  end_date    TEXT,
  retro       TEXT,
  created_at  TEXT NOT NULL DEFAULT NOW()::TEXT,
  UNIQUE(plan_id, week)
);

CREATE TABLE IF NOT EXISTS tasks (
  id              SERIAL PRIMARY KEY,
  sprint_id       INTEGER NOT NULL REFERENCES sprints(id),
  title           TEXT NOT NULL,
  description     TEXT,
  task_type       TEXT NOT NULL DEFAULT 'action',
  status          TEXT NOT NULL DEFAULT 'todo',
  priority        INTEGER NOT NULL DEFAULT 2,
  estimated_hours REAL,
  actual_hours    REAL,
  output_ref      TEXT,
  completed_date  TEXT,
  created_at      TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS accomplishments (
  id          SERIAL PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(plan_id),
  task_id     INTEGER REFERENCES tasks(id),
  date        TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence    TEXT,
  impact      TEXT,
  created_at  TEXT NOT NULL DEFAULT NOW()::TEXT
);

CREATE INDEX IF NOT EXISTS idx_acc_plan ON accomplishments(plan_id);
CREATE INDEX IF NOT EXISTS idx_acc_date ON accomplishments(date DESC);

CREATE TABLE IF NOT EXISTS daily_logs (
  id           SERIAL PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(plan_id),
  date         TEXT NOT NULL,
  focus        TEXT,
  active_tasks TEXT,
  blockers     TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT NOW()::TEXT,
  UNIQUE(plan_id, date)
);

COMMIT;
