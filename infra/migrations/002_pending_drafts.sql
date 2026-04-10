-- 002_pending_drafts.sql — Pending tweet drafts table
-- Used by Cloud Run publish worker to queue drafts for VM pickup.
-- Run: psql $DATABASE_URL -f 002_pending_drafts.sql

BEGIN;

CREATE TABLE IF NOT EXISTS pending_drafts (
  id            SERIAL PRIMARY KEY,
  draft_type    TEXT NOT NULL,           -- 'verification', 'signal', 'prediction'
  claim_id      TEXT,                    -- nullable; set for verification drafts
  content       TEXT NOT NULL,           -- full tweet text
  picked_up     BOOLEAN DEFAULT FALSE,   -- VM sets true after posting
  picked_up_at  TIMESTAMPTZ,
  tweet_url     TEXT,                    -- VM writes back after posting
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(draft_type, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_drafts_pickup
  ON pending_drafts (picked_up, created_at)
  WHERE NOT picked_up;

COMMIT;
