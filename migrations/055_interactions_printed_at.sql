-- ============================================================================
-- Migration 055 — interactions.printed_at for Mail Queue tracking
-- ----------------------------------------------------------------------------
-- Adds a printed_at timestamp on interactions so the Mail Queue can find
-- letter_* rows that have been approved (status='approved') but not yet
-- exported for printing.
--
-- Mail Queue workflow:
--   - Operator approves drafts in Drafts queue → status='draft' becomes
--     status='approved' + sent_at = NOW.
--   - Operator visits Mail Queue → sees pending letters split by delivery
--     method (first_class_mail / certified_mail). Query: status='approved'
--     AND printed_at IS NULL.
--   - Operator clicks "Download Batch" → server merges all matching PDFs
--     into one big multi-page PDF → printed_at set to NOW.
--   - Letters disappear from the next mail-queue summary.
--
-- Note: interactions table uses `sent_at` (not occurred_at) and a `status`
-- enum ('draft','approved','sent','rejected','received'). We index on
-- (delivery_method, status, printed_at) for the mail-queue lookup path.
-- ============================================================================

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ NULL;

-- Index for "find approved letter_* interactions waiting to print"
CREATE INDEX IF NOT EXISTS idx_interactions_mail_queue
  ON interactions (delivery_method, status, printed_at)
  WHERE type IN ('letter_courtesy_1','letter_courtesy_2','letter_209')
    AND printed_at IS NULL;
