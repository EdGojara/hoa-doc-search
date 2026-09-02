-- ============================================================================
-- 403_staff_reviews_add_contract_type.sql
-- ----------------------------------------------------------------------------
-- Amanda's document classifier returns 'contract' (and can return 'insurance')
-- for a vendor agreement, but staff_document_reviews.document_type only allowed
-- minutes/nominations/agenda/notice/general (+ Kat's financial types). So every
-- CONTRACT review silently failed the CHECK constraint at recordReview time and
-- was never persisted, which meant the redline-comparison capability had no
-- prior-review baseline to compare a revised contract against (Ed 2026-09-01,
-- the Canyon Gate / UPS contract). Widen the constraint. Idempotent.
--
-- record_ownership: workpaper (Amanda's internal review of a draft). Unchanged.
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
    'contract',         -- vendor / third-party agreement Amanda reviews for the board
    'insurance',        -- insurance proposal / dec page review
    -- Kat's surfaces:
    'financials',
    'reconciliation',
    'ap_coding',
    'journal_entry'
  ));

COMMIT;
