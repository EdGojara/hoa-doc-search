-- ============================================================================
-- 257_interactions_page_count.sql
-- ----------------------------------------------------------------------------
-- Record how many PAGES each mailed letter is, so Bedrock's client-billing
-- activity report can total "pages printed" per community per period (paper /
-- print reimbursable). Populated at lock-and-batch time from the finalized
-- letter PDF; historical mailed letters are backfilled from stored PDFs by
-- scripts/backfill_letter_page_counts.js.
--
-- Record ownership: `interactions` is a mixed table; page_count is internal
-- production metadata (workpaper), not delivered content.
-- ============================================================================
BEGIN;

ALTER TABLE interactions ADD COLUMN IF NOT EXISTS page_count integer;

COMMENT ON COLUMN interactions.page_count IS
  'Pages in the finalized letter PDF (mailed violation/ARC letters). Set at lock-and-batch time; backfilled for history. Drives the Bedrock billing pages-printed total.';

COMMIT;
