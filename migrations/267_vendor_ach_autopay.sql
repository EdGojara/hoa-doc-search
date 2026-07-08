-- ============================================================================
-- 267_vendor_ach_autopay.sql  (Ed 2026-07-08)
-- ----------------------------------------------------------------------------
-- ACH auto-pay handling for Emma. Some vendors auto-draft via ACH — the money
-- moves without us cutting a check, so Emma must RECORD the invoice (and, once
-- the community is on trustEd's GL, post the journal entry Dr Expense / Cr Cash)
-- but must NOT route it to the check run.
--
--   vendors.auto_pay_ach          : this vendor auto-drafts (standing arrangement)
--   vendors.default_gl_account_id : the expense account to code their invoices to
--                                   (the engine already reads this; added here
--                                   IF NOT EXISTS so this migration is self-contained)
--   ap_invoices.is_ach_autopay    : this bill is ACH auto-pay — keep it out of the
--                                   check run; book it, don't pay it
--   ap_invoices.ach_confirmed_by_invoice : Emma also read the invoice/email and it
--                                   corroborates ACH (belt-and-suspenders vs the flag)
-- ============================================================================
BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS auto_pay_ach          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_gl_account_id UUID;

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS is_ach_autopay            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ach_confirmed_by_invoice  BOOLEAN;

-- The ACH "to be booked" holding area + keeping these out of any check-run query.
CREATE INDEX IF NOT EXISTS idx_ap_invoices_ach ON ap_invoices (community_id) WHERE is_ach_autopay = TRUE;

COMMIT;
