-- ============================================================================
-- 283_ap_utility_dedup_fields.sql  (Ed 2026-07-11)
-- ----------------------------------------------------------------------------
-- Utility bills (MUD water, NRG electric) don't print a stable invoice number,
-- so cross-channel dedup fell back to amount+date — fuzzy for monthly bills at
-- similar amounts. Store the account number + service period the extractor
-- reads so dedup can key on (vendor + account # + overlapping service period):
-- two copies of July's MUD collapse; July vs August stay distinct.
-- ============================================================================
BEGIN;

ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS service_period_start DATE;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS service_period_end DATE;

CREATE INDEX IF NOT EXISTS idx_ap_invoices_utility_dedup
  ON ap_invoices (community_id, vendor_id, account_number)
  WHERE account_number IS NOT NULL;

COMMIT;
