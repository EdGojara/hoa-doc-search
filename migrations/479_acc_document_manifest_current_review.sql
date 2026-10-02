-- ============================================================================
-- 479_acc_document_manifest_current_review.sql  (Issue #14, Ed 2026-10-02)
-- ----------------------------------------------------------------------------
-- ACC cases must be reviewed against the documents actually on the case.
--
-- Scar (WAT-ARC-2026-0025, 6019 Sweetspire Ridge): the homeowner emailed the
-- application AND a survey. Both were stored, but the review engine only read
-- the first PDF, so the analysis said "Survey ... Not submitted" and the case
-- recommended asking for the survey she had already sent. The second PDF was
-- also archived as "photo_2.pdf", losing its name.
--
--   document_manifest       every document on the case: storage path, original
--                           filename, kind (application / supporting / photo),
--                           the email it came from and when. Appended on intake
--                           and on every follow-up; never rewritten.
--   document_intake_errors  attachments that could not be fetched or stored,
--                           with the reason, so a dropped file is visible on the
--                           case instead of silently missing.
--   current_review_*        the review re-run against the CURRENT document set
--                           (after a follow-up adds documents, or on staff
--                           request). The original intake analysis
--                           (ai_review_text / ai_recommendation / ai_letter_body)
--                           is left untouched as history.
--
-- Record ownership: association_record (unchanged). No row is written: existing
-- cases start with an empty manifest and no current review. Nothing here sets a
-- decision, a status or a send.
-- ============================================================================
BEGIN;

ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS document_manifest jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS document_intake_errors jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS current_review_text text;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS current_ai_recommendation text;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS current_letter_body text;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS current_review_at timestamptz;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS current_review_basis jsonb;

ALTER TABLE acc_decisions DROP CONSTRAINT IF EXISTS acc_decisions_document_manifest_is_array;
ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_document_manifest_is_array CHECK (jsonb_typeof(document_manifest) = 'array');
ALTER TABLE acc_decisions DROP CONSTRAINT IF EXISTS acc_decisions_document_intake_errors_is_array;
ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_document_intake_errors_is_array CHECK (jsonb_typeof(document_intake_errors) = 'array');

COMMIT;
