-- ============================================================================
-- 524_unidentified_receipts_account.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- Unidentified homeowner receipts (money in whose payer is not yet known) are
-- classified SEPARATELY from prepaid owner assessments. Until now Kat's bank
-- reconciliation credited them to 2400 Prepaid Owners Assessments with a
-- description marker, so the balance sheet showed suspense cash as owner prepaids.
--
-- Shared, configuration-driven (no community branch):
--   * role 'unidentified_receipts' in community_account_roles (mig 469/514): the
--     account each community holds unidentified receipts in. The engine reads the
--     role; it never hard-codes a number and never falls back to 2400.
--   * the role guard accepts a credit-normal LIABILITY for this role only (every
--     other role still needs a debit-normal asset).
--   * 2420 "Unidentified Receipts (Suspense)", a current liability in the same fund
--     as the community's 2400, for every OPERATIONAL community that has a 2400
--     (active / onboarding / terminating within its notice period; archived and
--     prospect communities are untouched), and the role pointed at it.
-- No journal entry, balance or homeowner ledger changes. Entries already posted to
-- 2400 as "Unidentified homeowner receipt" stay where they are (any reclass is a
-- separate, approved entry) and remain set aside by the receivables tie-out.
-- Record ownership: chart_of_accounts association_record; roles workpaper.
-- ============================================================================
BEGIN;

ALTER TABLE community_account_roles DROP CONSTRAINT IF EXISTS community_account_roles_role_check;
ALTER TABLE community_account_roles ADD CONSTRAINT community_account_roles_role_check
  CHECK (role IN ('operating_cash', 'stripe_clearing', 'homeowner_ar', 'undeposited_funds', 'unidentified_receipts'));

CREATE OR REPLACE FUNCTION community_account_roles_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a chart_of_accounts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM chart_of_accounts WHERE id = NEW.account_id;
  IF NOT FOUND OR a.community_id <> NEW.community_id THEN RAISE EXCEPTION 'account % is not in community %', NEW.account_id, NEW.community_id; END IF;
  IF a.is_summary OR NOT a.is_active THEN RAISE EXCEPTION 'account % must be active and postable for role %', a.account_number, NEW.role; END IF;
  IF NEW.role = 'unidentified_receipts' THEN
    IF a.account_type <> 'liability' OR a.normal_balance <> 'credit' THEN
      RAISE EXCEPTION 'role % needs a credit-normal liability account (% is %/%)', NEW.role, a.account_number, a.account_type, a.normal_balance;
    END IF;
  ELSIF a.account_type <> 'asset' OR a.normal_balance <> 'debit' THEN
    RAISE EXCEPTION 'role % needs a debit-normal asset account (% is %/%)', NEW.role, a.account_number, a.account_type, a.normal_balance;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

INSERT INTO chart_of_accounts (community_id, fund_id, account_number, account_name, account_type, account_subtype,
                               normal_balance, is_summary, is_active, description)
SELECT p.community_id, p.fund_id, '2420', 'Unidentified Receipts (Suspense)', 'liability', p.account_subtype, 'credit', false, true,
       'Homeowner money received whose payer is not yet identified. Held here, never on any homeowner''s ledger, until the payer is known; then reclassified to that owner. Each entry keeps its bank line reference. (mig 524)'
  FROM chart_of_accounts p
  JOIN communities c ON c.id = p.community_id
 WHERE p.account_number = '2400' AND p.is_active AND NOT p.is_summary
   AND coalesce(c.management_status, 'active') IN ('active', 'onboarding', 'terminating')
   AND (c.management_end_date IS NULL OR c.management_end_date >= current_date)
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.community_id = p.community_id AND x.account_number = '2420');

INSERT INTO community_account_roles (community_id, role, account_id, updated_by)
SELECT a.community_id, 'unidentified_receipts', a.id, 'migration 524'
  FROM chart_of_accounts a
 WHERE a.account_number = '2420' AND a.account_name = 'Unidentified Receipts (Suspense)' AND a.is_active
ON CONFLICT (community_id, role) DO NOTHING;

COMMIT;
