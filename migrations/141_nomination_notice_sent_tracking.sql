-- ============================================================================
-- 141_nomination_notice_sent_tracking.sql
-- ----------------------------------------------------------------------------
-- Adds notice-sent tracking to nomination_cycles so the workflow breadcrumb
-- can advance from the "Notice generated" step to the "Voting in progress"
-- step. Without this, the breadcrumb can't distinguish "PDF rendered" from
-- "ballot actually mailed and emailed to members."
--
-- Columns:
--   notice_sent_at         when the operator confirmed the notice was sent
--   notice_sent_by         operator email (for the audit trail)
--   notice_sent_channels   JSONB array of channels used: ['mail', 'email']
--                          — captures HOW the notice went out so the audit
--                          log can answer "did we email it AND mail it?"
--
-- Texas Property Code §209.0056 requires written notice 10–60 days before
-- the meeting. Tracking notice_sent_at gives Bedrock a defensible record
-- that the notice DID go out and WHEN, which is the kind of question a
-- board attorney will ask after a contested election.
--
-- Record ownership (CLAUDE.md): association_record — the proof-of-notice is
-- part of the election file the HOA owns.
--
-- Apply after 140. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS notice_sent_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notice_sent_by        TEXT,
  ADD COLUMN IF NOT EXISTS notice_sent_channels  JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN nomination_cycles.notice_sent_at IS
  'When the operator confirmed the Annual Meeting Notice was actually mailed/emailed to members. Distinct from notice_generated_at (PDF was rendered). Drives the workflow breadcrumb advance from "Notice" → "Voting".';

COMMENT ON COLUMN nomination_cycles.notice_sent_by IS
  'Operator email of whoever marked the notice as sent. Audit trail.';

COMMENT ON COLUMN nomination_cycles.notice_sent_channels IS
  'JSONB array of channels: e.g., ["mail","email"]. Captures HOW the notice went out so the audit log can answer "did we email AND mail it?"';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT id, community_name, annual_meeting_date,
--        notice_generated_at, notice_sent_at, notice_sent_by, notice_sent_channels
-- FROM nomination_cycles
-- WHERE notice_sent_at IS NOT NULL
-- ORDER BY notice_sent_at DESC;
