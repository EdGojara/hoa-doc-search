-- ============================================================================
-- Migration 055 — interactions.printed_at for Mail Queue tracking
-- ----------------------------------------------------------------------------
-- Adds a printed_at timestamp on interactions so the Mail Queue can find
-- letter_* rows that have been approved but not yet exported for printing.
--
-- Mail Queue workflow:
--   - Operator approves drafts in Drafts queue (Phase 6d) → '[DRAFT]' prefix
--     stripped, occurred_at = NOW.
--   - Operator visits Mail Queue → sees pending letters split by delivery
--     method (first_class_mail / certified_mail).
--   - Operator clicks "Download Batch" → server merges all pending PDFs into
--     one big multi-page PDF (each letter on its own page) → printed_at set.
--   - Operator prints the batch, stuffs envelopes, mails or hands certified
--     ones to the post office.
-- ============================================================================

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ NULL;

-- Index for the Mail Queue's "find pending letter_* interactions" query
CREATE INDEX IF NOT EXISTS idx_interactions_mail_queue
  ON interactions (delivery_method, printed_at, occurred_at)
  WHERE type IN ('letter_courtesy_1','letter_courtesy_2','letter_209');
