-- ============================================================================
-- 371_kat_financial_reviews.sql  (Ed 2026-08-19)
-- ----------------------------------------------------------------------------
-- Kat Reed reviews financials the way Amanda reviews minutes: same table, same
-- memory, so "this is the second month the interfund transfer was coded to the
-- cash account" is computable rather than remembered.
--
-- Ed: "the accounting manager reviews the financials and accounting and
-- provides feedback to accounting."
--
-- Only widens the document_type CHECK. The reviewer_persona column already
-- holds 'amanda' and takes 'kat' without change.
--
-- Adding the values BEFORE any code writes them, because a literal the CHECK
-- forbids is the single most repeated scar in this codebase — it fails silently
-- deep in a side-effect chain while the caller reports success.
-- (scripts/check_constraint_values.js fails the build on a mismatch.)
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

ALTER TABLE staff_document_reviews DROP CONSTRAINT IF EXISTS staff_document_reviews_document_type_check;

ALTER TABLE staff_document_reviews
  ADD CONSTRAINT staff_document_reviews_document_type_check
  CHECK (document_type IN (
    'minutes',
    'nominations',
    'agenda',
    'notice',
    'general',
    -- Kat's surfaces:
    'financials',      -- balance sheet, income statement, budget vs actual
    'reconciliation',  -- bank rec and its supporting reports
    'ap_coding',       -- how a bill was coded to the chart of accounts
    'journal_entry'    -- a manual or adjusting entry put up for review
  ));

-- Kat reviews a PERIOD, not just a file. Amanda's reviews key on a filename;
-- a financial review keys on the community and the month, which is what makes
-- "you fixed this last month" answerable.
ALTER TABLE staff_document_reviews ADD COLUMN IF NOT EXISTS period_label TEXT;

CREATE INDEX IF NOT EXISTS idx_sdr_period
  ON staff_document_reviews (community_id, document_type, period_label)
  WHERE period_label IS NOT NULL;

COMMIT;
