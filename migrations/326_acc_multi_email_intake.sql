-- ===========================================================================
-- 326_acc_multi_email_intake.sql   (Ed 2026-07-22)
-- ---------------------------------------------------------------------------
-- ACC applications come in across MULTIPLE emails: a homeowner sends some
-- documents, we ask for more, they send the rest. Today each email would create
-- a separate application (or strand). This lets one application ACCUMULATE
-- documents from several emails and stay OPEN while it waits for the missing
-- pieces.
--   - status 'awaiting_info' — started but waiting on the homeowner for more.
--   - supporting_docs_storage_paths — additional PDFs/docs beyond the main form,
--     appended as follow-up emails arrive (photos already append to
--     photo_storage_paths).
--   - source_email_refs — every email (intake ref) that contributed to the
--     package, so the trail is auditable.
-- Record ownership: mixed (the sent decision is the association's; the intake
-- workpapers are Bedrock's) — matches the rest of acc_decisions.
-- ===========================================================================
BEGIN;

-- Add 'awaiting_info' to the status set. The column has a CHECK constraint; find
-- and replace it so the new value is accepted.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'acc_decisions'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE acc_decisions DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE acc_decisions
  ADD CONSTRAINT acc_decisions_status_check
  CHECK (status IN ('pending_review', 'awaiting_info', 'decided', 'withdrawn', 'archived'));

ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS supporting_docs_storage_paths text[] NOT NULL DEFAULT '{}';
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS source_email_refs           text[] NOT NULL DEFAULT '{}';
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS last_document_added_at       timestamptz;

-- Seed source_email_refs from the single ref already recorded, so history is intact.
UPDATE acc_decisions
   SET source_email_refs = ARRAY[intake_source_ref]
 WHERE intake_source_ref IS NOT NULL
   AND (source_email_refs IS NULL OR source_email_refs = '{}');

-- Find the open applications by property/homeowner fast (the attach lookup).
CREATE INDEX IF NOT EXISTS idx_acc_decisions_open
  ON acc_decisions (community_id, status)
  WHERE status IN ('pending_review', 'awaiting_info');
CREATE INDEX IF NOT EXISTS idx_acc_decisions_submitter
  ON acc_decisions (lower(submitter_email))
  WHERE status IN ('pending_review', 'awaiting_info');

COMMIT;
