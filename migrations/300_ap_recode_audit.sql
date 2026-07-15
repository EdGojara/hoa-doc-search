-- ============================================================================
-- 300_ap_recode_audit.sql  (Ed 2026-07-15)
-- ----------------------------------------------------------------------------
-- Changing the expense account on a bill whose accrual is ALREADY POSTED is a
-- real accounting event, not an edit. It reverses a journal entry that is on
-- the community's books and posts a replacement. Ed's rule:
--
--   "add GL account and make it so it can be changed and then the JE is
--    adjusted, but I want to go ahead and make that the exception"
--
-- The exception path needs somewhere to land. Today ap_invoice_approvals is
-- the invoice's audit trail, but its action enum has no value for a re-code,
-- so the one action that reverses a posted JE is the only one that leaves no
-- trace on the invoice. That's backwards. Add 'recoded'.
--
-- Record ownership: association_record — this is the community's own books.
-- ============================================================================

BEGIN;

ALTER TABLE ap_invoice_approvals DROP CONSTRAINT IF EXISTS ap_invoice_approvals_action_check;

ALTER TABLE ap_invoice_approvals ADD CONSTRAINT ap_invoice_approvals_action_check
  CHECK (action IN (
    'submitted',
    'approved',
    'rejected',
    'requested_more_info',
    'reassigned',
    'released_for_payment',
    'voided',
    'recoded'              -- expense account changed on a posted accrual (exception)
  ));

COMMIT;
