-- ============================================================================
-- 271_invoice_default_lines_and_evoting.sql
-- ----------------------------------------------------------------------------
-- Slim the default activity invoice to the lines actually billed most months,
-- and add Electronic Voting to the rate card (Ed 2026-07-09).
--
-- A fresh activity invoice used to create a line for EVERY reimbursable +
-- owner charge (~22 rows, most $0). Now it creates only the ones flagged
-- default_on_invoice; the rest stay on the rate card and are addable via
-- "Add Line Item". (When a prior month's invoice exists, generation copies
-- that instead — handled in api/billing.js.)
--
-- Confirmed default set (activity-billable core + voting):
--   reimbursables:  postage_drv_notices, color_copies, electronic_voting
--   owner charges:  deed_restriction_certified_demand_letter, arc_application_fee
--
-- contract_reimbursables / contract_owner_charges are association contract
-- config; no new table, existing grants apply.
-- ============================================================================

BEGIN;

ALTER TABLE contract_reimbursables  ADD COLUMN IF NOT EXISTS default_on_invoice boolean NOT NULL DEFAULT false;
ALTER TABLE contract_owner_charges  ADD COLUMN IF NOT EXISTS default_on_invoice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN contract_reimbursables.default_on_invoice IS
  'When true, this rate row seeds a line on a fresh activity invoice; when false it stays on the rate card, addable via Add Line Item.';
COMMENT ON COLUMN contract_owner_charges.default_on_invoice IS
  'When true, this rate row seeds a line on a fresh activity invoice; when false it stays on the rate card, addable via Add Line Item.';

-- Add Electronic Voting ($750) to every contract's rate card (default line).
INSERT INTO contract_reimbursables (contract_id, category, description, billing_method, unit_price, sort_order, default_on_invoice)
SELECT c.id, 'electronic_voting', 'Electronic Voting', 'per_unit', 750, 500, true
  FROM contracts c
 WHERE NOT EXISTS (
   SELECT 1 FROM contract_reimbursables r
    WHERE r.contract_id = c.id AND r.category = 'electronic_voting'
 );

-- Flag the confirmed default set on the existing rate rows.
UPDATE contract_reimbursables
   SET default_on_invoice = true
 WHERE category IN ('postage_drv_notices', 'color_copies', 'electronic_voting');

UPDATE contract_owner_charges
   SET default_on_invoice = true
 WHERE category IN ('deed_restriction_certified_demand_letter', 'arc_application_fee');

COMMIT;
