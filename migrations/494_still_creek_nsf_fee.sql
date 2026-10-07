-- ============================================================================
-- 494_still_creek_nsf_fee.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- Bedrock Office Billing: add an "NSF / Insufficient Funds Fee" billable
-- category to Still Creek Ranch's rate card. This is Bedrock-to-community
-- billing (the invoice Bedrock sends the association), not HOA accounting or AP.
--
-- Billable categories are DATA: each community's active contract carries its
-- own rate card (contract_reimbursables), and the Activity worksheet lists the
-- rate-card rows marked default_on_invoice. So the category belongs on Still
-- Creek's contract, not in page logic, and it is NOT added to the reusable
-- Contract Defaults (new communities do not inherit it).
--
-- Same category slug and method the other communities already use for this fee
-- (nsf_charge, per_unit at $35.00: Lakes of Pine Forest, Canyon Gate,
-- Eaglewood), but on the invoice by default for Still Creek. Per occurrence:
-- the worksheet line starts at qty 0 = $0.00 and amount = qty x $35.00, so the
-- operator enters only the number of NSF occurrences (rate and amount stay
-- editable). No activity source: NSF/returned checks are not in the activity
-- report yet (vantaca_source stays NULL; the worksheet never auto-fills it).
-- Idempotent: inserts only when the active contract has no nsf_charge row.
-- ============================================================================
BEGIN;

INSERT INTO contract_reimbursables
  (contract_id, category, description, billing_method, unit_price, notes, sort_order, default_on_invoice)
SELECT c.id, 'nsf_charge', 'NSF / Insufficient Funds Fee', 'per_unit', 35.00,
       'Per NSF occurrence. Enter the number of NSF / returned payments for the month; amount = quantity x $35.00.', 60, true
  FROM contracts c
 WHERE c.community_id = 'a0000000-0000-4000-8000-000000000006'   -- Still Creek Ranch
   AND c.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM contract_reimbursables r WHERE r.contract_id = c.id AND r.category = 'nsf_charge');

COMMIT;
