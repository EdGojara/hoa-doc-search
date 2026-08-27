-- ============================================================================
-- 394 — Certified-letter fee: auto-charge the homeowner, pass-through to Bedrock
-- ----------------------------------------------------------------------------
-- Ed 2026-08-27: when a homeowner gets a CERTIFIED letter (Waterview, Still
-- Creek Ranch, Canyon Gate, Quail Ridge) we charge their account per the fee
-- schedule. Two kinds — VIOLATION (§209) and COLLECTIONS. The charge is a
-- pass-through to Bedrock: Dr 1300 Accounts Receivable / Cr 2300 Accrued
-- Liability (owed to Bedrock, cleared at month-end via the Bedrock invoice),
-- NOT HOA income. Same model as the ACC homeowner fee (migration 331).
--
-- Amounts:
--   • Violation certified fee = existing communities.letter_fee_certified_209_cents
--     ($35.00 on all four). The auto-post reads that column (single source).
--   • Collections certified fee = communities.certified_collection_fee_cents,
--     added here, DEFAULT 0 (dormant until Ed sets the amount + we wire the
--     collections send path — collections certifieds aren't in letter_mail_pieces).
--
-- Enable gate: communities.certified_fee_autopost (true only for the four named).
-- Start date is enforced in code (certified letters mailed on/after 2026-08-01).
--
-- NOTE: this does NOT touch Quail Ridge's legacy drv_certified_letter /
-- certified_letter types (they credit 4030 income and are used by historical
-- Vantaca imports). The new auto-post uses the clean certified_violation /
-- certified_collection types below, which credit 2300 per Ed's instruction.
--
-- Record ownership: config on communities (association_record); ar_charge_types
-- (association_record — the community's own chart/charge config).
-- ============================================================================
BEGIN;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS certified_fee_autopost boolean NOT NULL DEFAULT false;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS certified_collection_fee_cents integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN communities.certified_fee_autopost IS 'When true, a certified-letter fee auto-posts to the owner (Dr 1300 / Cr 2300) as each certified letter is sent. (mig 394)';
COMMENT ON COLUMN communities.certified_collection_fee_cents IS 'Owner fee for a COLLECTIONS certified letter (cents). 0 = not set. Violation certified fee lives in letter_fee_certified_209_cents. (mig 394)';

-- The auto-post writes source_module='certified_letter_fee' on the JE and the
-- AR charge. Both columns have a CHECK constraint (mig 170/282, mig 172), so the
-- new value must be added or every post fails the constraint. Drop whatever the
-- source_module check is named (dynamic, so a non-standard auto-name can't leave
-- a stale constraint blocking the value) and re-add the full list plus the new one.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'journal_entries'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%source_module%' LOOP
    EXECUTE 'ALTER TABLE journal_entries DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
  FOR r IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'ar_charges'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%source_module%' LOOP
    EXECUTE 'ALTER TABLE ar_charges DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_module_check
  CHECK (source_module IN (
    'manual','assessment_billing','payment_intake','bank_reconciliation',
    'vantaca_import','ar_snapshot','reserve_transfer','closing_entry',
    'opening_entry','reversal','system','ap_invoice','certified_letter_fee'
  ));

ALTER TABLE ar_charges ADD CONSTRAINT ar_charges_source_module_check
  CHECK (source_module IN (
    'manual','assessment_billing','late_fee_accrual','interest_accrual',
    'fine_assessment','vantaca_migration','system','certified_letter_fee'
  ));

-- Enable for the four named communities.
UPDATE communities SET certified_fee_autopost = true
 WHERE id IN (
   'a0000000-0000-4000-8000-000000000001',  -- Waterview Estates
   'a0000000-0000-4000-8000-000000000003',  -- Canyon Gate at Cinco Ranch
   'a0000000-0000-4000-8000-000000000005',  -- Quail Ridge
   'a0000000-0000-4000-8000-000000000006'   -- Still Creek Ranch
 );

-- Charge types (idempotent). createCharge posts Dr <receivable> / Cr <revenue>;
-- here the credit side is 2300 Accrued Liability (pass-through to Bedrock).
INSERT INTO ar_charge_types
  (community_id, type_code, display_name, category, tx_priority_step,
   gl_receivable_account_id, gl_revenue_account_id, is_active, display_order, notes)
SELECT c.id, t.type_code, t.display_name, 'other', 6,
       (SELECT id FROM chart_of_accounts WHERE community_id = c.id AND account_number = '1300'),
       (SELECT id FROM chart_of_accounts WHERE community_id = c.id AND account_number = '2300'),
       true, 25,
       'Owner-paid certified-letter fee, pass-through to Bedrock. Cr Accrued Liability (2300), not income. (mig 394)'
FROM communities c
CROSS JOIN (VALUES
    ('certified_violation',  'Certified Letter Fee - Violation'),
    ('certified_collection', 'Certified Letter Fee - Collections')
  ) AS t(type_code, display_name)
WHERE c.id IN (
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000006'
  )
  AND EXISTS (SELECT 1 FROM chart_of_accounts WHERE community_id = c.id AND account_number = '1300')
  AND EXISTS (SELECT 1 FROM chart_of_accounts WHERE community_id = c.id AND account_number = '2300')
  AND NOT EXISTS (SELECT 1 FROM ar_charge_types x WHERE x.community_id = c.id AND x.type_code = t.type_code);

COMMIT;
