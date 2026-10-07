-- ============================================================================
-- 494_still_creek_bank_fees.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- Bedrock Office Billing: add a "Bank Fees" billable category to Still Creek
-- Ranch's rate card. This is Bedrock-to-community billing (the invoice Bedrock
-- sends the association), not HOA accounting or AP.
--
-- Billable categories are DATA: each community's active contract carries its
-- own rate card (contract_reimbursables), and the invoice worksheet lists the
-- rate-card rows marked default_on_invoice. So the category belongs on Still
-- Creek's contract, not in page logic. Only Still Creek bills bank fees today,
-- so it is NOT added to the reusable Contract Defaults (a new community would
-- not inherit it); add it there later if more communities need it.
--
-- at_cost, no unit price, no vantaca_source: there is no bank-fee activity
-- source in the billing system, so the line starts at qty 0 / $0 and the
-- operator enters the rate, quantity or amount each month (all editable).
-- Idempotent: inserts only when the active contract has no bank_fees row.
-- ============================================================================
BEGIN;

INSERT INTO contract_reimbursables
  (contract_id, category, description, billing_method, unit_price, notes, sort_order, default_on_invoice)
SELECT c.id, 'bank_fees', 'Bank Fees', 'at_cost', NULL,
       'Bank fees billed to the association at cost. No activity source: enter the amount each month.', 60, true
  FROM contracts c
 WHERE c.community_id = 'a0000000-0000-4000-8000-000000000006'   -- Still Creek Ranch
   AND c.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM contract_reimbursables r WHERE r.contract_id = c.id AND r.category = 'bank_fees');

COMMIT;
