-- ============================================================================
-- 230_master_plan_extracted_plans.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-18: approving a master plan made staff RE-TYPE the plan number,
-- name, elevation, sqft, and stories that are already sitting in the submitted
-- PDF. That's the exact friction + human-error the platform exists to remove.
-- The system now reads the PDF (Claude binary) and pre-fills the approval rows.
--
-- Cache the extraction on the submission so the approval modal opens instantly
-- and the same read isn't repeated on every open. record_ownership: workpaper
-- (it's a Bedrock production-process AI extraction; the source PDF stays the
-- association/builder record).
-- ============================================================================

BEGIN;

ALTER TABLE master_plan_submissions
  ADD COLUMN IF NOT EXISTS extracted_plans     JSONB,
  ADD COLUMN IF NOT EXISTS plans_extracted_at  TIMESTAMPTZ;

COMMIT;
