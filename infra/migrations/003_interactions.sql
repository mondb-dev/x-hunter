-- Migration 003: engagement interactions table
-- Stores all reply/proactive-reply exchanges so they are queryable and recallable.

CREATE TABLE IF NOT EXISTS interactions (
  id             BIGSERIAL PRIMARY KEY,
  tweet_id       TEXT,                        -- X tweet ID being replied to
  interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type           TEXT NOT NULL DEFAULT 'reply', -- 'reply' | 'proactive'
  from_username  TEXT NOT NULL,
  from_display   TEXT,
  their_text     TEXT,
  our_reply      TEXT NOT NULL,
  memory_used    JSONB NOT NULL DEFAULT '[]',  -- array of {type, title} strings
  cycle          INT,                          -- orchestrator cycle number
  tsv            TSVECTOR
    GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(their_text, '') || ' ' ||
        coalesce(our_reply,  '') || ' ' ||
        coalesce(from_username, '')
      )
    ) STORED
);

CREATE INDEX IF NOT EXISTS interactions_at_idx   ON interactions (interaction_at DESC);
CREATE INDEX IF NOT EXISTS interactions_user_idx  ON interactions (from_username);
CREATE INDEX IF NOT EXISTS interactions_tsv_idx   ON interactions USING GIN (tsv);
CREATE INDEX IF NOT EXISTS interactions_type_idx  ON interactions (type);
