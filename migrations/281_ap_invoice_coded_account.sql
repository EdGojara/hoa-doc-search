-- ============================================================================
-- 281_ap_invoice_coded_account.sql  (Ed 2026-07-11)
-- ----------------------------------------------------------------------------
-- Phase 2 wiring into AP intake: store the GL account the classifier coded the
-- invoice to (+ the plain "why" and a needs_review flag), so a vendor bill
-- arrives pre-coded like a CPA did it. Staff confirm/correct at review; the
-- posting to the GL then uses coded_gl_account_id for the expense leg (cash leg
-- defaults to 1000 Operating Cash).
-- ============================================================================
BEGIN;

ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS coded_gl_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS classification_reason TEXT;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ap_invoices_needs_review ON ap_invoices (community_id) WHERE needs_review;

COMMIT;
