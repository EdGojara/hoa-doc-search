-- ============================================================================
-- 284_ea_followups.sql  (Ed 2026-07-11)
-- ----------------------------------------------------------------------------
-- Tessa McCall — Ed's private executive-assistant AI. This is her follow-up
-- ledger: the personal admin / banking / vendor to-dos she tracks and chases
-- for Ed (NOT staff work-items). Ed-only surface; workpaper (internal), never
-- an association record.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ea_followups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  detail         TEXT,
  category       TEXT NOT NULL DEFAULT 'other'
                 CHECK (category IN ('admin', 'banking', 'vendor', 'personal', 'other')),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'waiting', 'done', 'dropped')),
  waiting_on     TEXT,                         -- who/what we're waiting on
  due_date       DATE,
  related_email_id UUID,                        -- email_messages row this came from (forward/BCC), if any
  last_nudged_at TIMESTAMPTZ,                   -- when Tessa last chased it
  created_by     TEXT,                          -- who added it (Ed, or 'tessa' auto)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ea_followups_open ON ea_followups (status, due_date) WHERE status IN ('open', 'waiting');

GRANT SELECT, INSERT, UPDATE, DELETE ON ea_followups TO service_role;
GRANT SELECT                          ON ea_followups TO authenticated;

COMMIT;
