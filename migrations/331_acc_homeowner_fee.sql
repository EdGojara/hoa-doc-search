-- 331_acc_homeowner_fee.sql
-- ---------------------------------------------------------------------------
-- Per-community resident ACC fee: amount + who pays. Some communities' management
-- agreements bill the ARC application fee to the HOMEOWNER (Canyon Gate: $25.00
-- per decision, "payable by owners... billed to the Association" — Exhibit A). On
-- those, finalize posts a pass-through AR charge to the owner: Dr A/R / Cr Accrued
-- Liability (owed to Bedrock, cleared at month-end via the Bedrock invoice). The
-- fee still counts on the Bedrock billing detail either way. Communities default
-- to community-pays (no owner charge). (Ed 2026-07-25.)
--
-- Record ownership: config on communities (association_record).
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS acc_fee_cents integer NOT NULL DEFAULT 0;
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS acc_fee_payer text NOT NULL DEFAULT 'community';

-- Idempotent CHECK (only add if not already present).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'communities_acc_fee_payer_chk') THEN
    ALTER TABLE communities
      ADD CONSTRAINT communities_acc_fee_payer_chk CHECK (acc_fee_payer IN ('community','homeowner'));
  END IF;
END $$;

COMMENT ON COLUMN communities.acc_fee_cents  IS 'Resident ACC application fee charged per decision (0 = none).';
COMMENT ON COLUMN communities.acc_fee_payer  IS 'community = on the HOA''s Bedrock bill; homeowner = also posted to the owner''s A/R (Dr A/R / Cr Accrued Liability).';

-- Canyon Gate: $25.00 / decision, homeowner-pays (management agreement Exhibit A).
UPDATE communities
   SET acc_fee_cents = 2500, acc_fee_payer = 'homeowner'
 WHERE id = 'a0000000-0000-4000-8000-000000000003';

-- Charge type for the Canyon Gate ACC fee. createCharge posts Dr <receivable> /
-- Cr <revenue>; here the credit side is the Accrued Liability (pass-through to
-- Bedrock), NOT HOA income. Idempotent; account ids resolved by number.
INSERT INTO ar_charge_types
  (community_id, type_code, display_name, category, tx_priority_step,
   gl_receivable_account_id, gl_revenue_account_id, is_active, display_order, notes)
SELECT
  'a0000000-0000-4000-8000-000000000003', 'acc_fee', 'ACC Application Processing Fee', 'other', 7,
  (SELECT id FROM chart_of_accounts WHERE community_id = 'a0000000-0000-4000-8000-000000000003' AND account_number = '1300'),
  (SELECT id FROM chart_of_accounts WHERE community_id = 'a0000000-0000-4000-8000-000000000003' AND account_number = '2300'),
  true, 20,
  'Owner-paid ACC fee remitted to Bedrock (mgmt agreement Exhibit A). Credit side is Accrued Liability, not income.'
WHERE NOT EXISTS (
  SELECT 1 FROM ar_charge_types
   WHERE community_id = 'a0000000-0000-4000-8000-000000000003' AND type_code = 'acc_fee'
);

COMMIT;
