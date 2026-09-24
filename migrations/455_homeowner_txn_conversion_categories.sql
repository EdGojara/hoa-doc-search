-- ============================================================================
-- 455_homeowner_txn_conversion_categories.sql   -- DRAFT, NOT APPLIED
-- ----------------------------------------------------------------------------
-- The LOPF 7/31 conversion loads Vantaca opening balances into the homeowner
-- ledger with their SOURCE charge category. Three Vantaca categories are not in
-- the homeowner_transactions.charge_category CHECK (migration 203):
--   certified_letter, attorney_fee_other, nsf_fee
-- Mapping them onto existing values would lose meaning §209.0063 payment order
-- depends on (e.g. assessment-related vs other attorney fees), so the list is
-- extended instead. Additive: every existing value stays valid; no row changes.
-- Intended to run inside the conversion posting transaction.
-- ============================================================================
BEGIN;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'homeowner_transactions'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%charge_category%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE homeowner_transactions DROP CONSTRAINT %I', c); END IF;
END $$;

ALTER TABLE homeowner_transactions ADD CONSTRAINT homeowner_transactions_charge_category_check
  CHECK (charge_category IS NULL OR charge_category IN (
    'assessment', 'late_fee', 'interest',
    'fine', 'attorney_fee', 'admin_fee',
    'payment', 'credit', 'refund',
    'adjustment', 'prior_balance', 'other',
    'certified_letter', 'attorney_fee_other', 'nsf_fee'
  ));

COMMIT;
