-- ============================================================================
-- 045_nomination_channel_tracking.sql
-- ----------------------------------------------------------------------------
-- Nomination submission audit trail. Captures the "when" and "how" of every
-- nomination — including those that come in OFFLINE (mail, email, drop-off,
-- phone, in-person at a board meeting). Combined with the existing
-- signed_at / created_at / signature_name / nominator_* fields, this gives
-- a complete record of who submitted what, when, and through which channel.
--
-- Why this matters:
--   - Bedrock can audit how nominations are arriving (channel mix)
--   - Boards can confirm receipt with the submitter (call/email)
--   - A paper-mail nomination can be entered into trustEd by staff and
--     flow through the same on_slate → ballot pipeline as online ones
--
-- Apply AFTER 044. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nominations
  -- How the nomination arrived. 'online_form' for public-form submissions
  -- (the default). 'email' / 'mail' / 'drop_off' / 'in_person' / 'phone' /
  -- 'other' for staff-entered records of offline submissions.
  ADD COLUMN IF NOT EXISTS submission_channel  TEXT NOT NULL DEFAULT 'online_form'
    CHECK (submission_channel IN ('online_form','email','mail','drop_off','in_person','phone','other')),
  -- When the nomination was received. For online submissions this equals
  -- signed_at. For staff-entered offline submissions, this is when the
  -- physical/email/drop-off submission actually arrived at Bedrock, which
  -- may pre-date the row's created_at (the date staff keyed it in).
  ADD COLUMN IF NOT EXISTS received_at         TIMESTAMPTZ NULL,
  -- Staff member who entered an offline submission. NULL for online
  -- submissions (the homeowner self-submitted via the public form).
  ADD COLUMN IF NOT EXISTS created_by_staff    TEXT NULL,
  -- Free-form note for staff to capture context about an offline submission
  -- (e.g., "Received hand-written form at the gate, transcribed by EG").
  ADD COLUMN IF NOT EXISTS intake_notes        TEXT NULL;

-- Backfill received_at for existing rows so the column is meaningful for
-- historical data. Online form submissions get signed_at; that's accurate.
UPDATE nominations
   SET received_at = signed_at
 WHERE received_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_nominations_channel
  ON nominations (cycle_id, submission_channel, received_at DESC);

COMMIT;

-- Verify:
--   SELECT submission_channel, COUNT(*) AS n
--     FROM nominations GROUP BY submission_channel ORDER BY n DESC;
--   SELECT id, nominee_name, submission_channel, received_at,
--          created_by_staff, intake_notes
--     FROM nominations ORDER BY received_at DESC NULLS LAST LIMIT 10;
