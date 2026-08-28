-- ============================================================================
-- 395_outbound_draft_disposition.sql  (Ed 2026-08-28)
-- ----------------------------------------------------------------------------
-- The exception router's verdict, persisted on the draft. This is what turns
-- the Draft Queue from "review every draft" into "review the exceptions": the
-- queue can split routine (auto_ok) from exceptions (needs_review), and a future
-- auto-send gate checks exactly this column (auto_ok + high confidence only).
--
-- Existing rows default to 'needs_review' — the honest state today, where a
-- human reviews everything. As producers pass a real verdict, the Handled bucket
-- fills. Adding a column with a constant default is a metadata-only change in
-- Postgres 11+, no table rewrite.
-- ============================================================================
BEGIN;

ALTER TABLE outbound_email_drafts
  ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'needs_review'
    CHECK (disposition IN ('auto_ok', 'needs_review')),
  ADD COLUMN IF NOT EXISTS confidence text
    CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS disposition_reason text;

CREATE INDEX IF NOT EXISTS idx_outbound_drafts_disposition
  ON outbound_email_drafts (status, disposition);

COMMIT;
