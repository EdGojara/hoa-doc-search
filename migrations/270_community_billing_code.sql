-- ============================================================================
-- 270_community_billing_code.sql
-- ----------------------------------------------------------------------------
-- Per-community BILLING CODE for invoice numbering (Ed 2026-07-09). Invoice
-- numbers are YYMM + code + suffix (e.g. 2601WV2). The code used to be the
-- Vantaca code, but most communities have no Vantaca code and Bedrock is moving
-- off Vantaca — so numbering was effectively broken. billing_code decouples
-- invoice numbering from Vantaca; Ed sets/edits it per community in
-- Proposals & Contracts.
--
-- Backfill: carry over the existing Vantaca code where present (preserves the
-- current invoice-number style), and seed sensible short codes for the rest so
-- every community can be numbered immediately. All are editable.
--
-- communities is association config; no new table, existing grants apply.
-- ============================================================================

BEGIN;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS billing_code text;

COMMENT ON COLUMN communities.billing_code IS
  'Short community code used in invoice numbers (YYMM + billing_code + suffix). '
  'Seeded from vantaca_code where present; editable in Proposals & Contracts. '
  'Replaces the Vantaca code as the invoice-number community identifier.';

-- Carry over the Vantaca code where it exists (Waterview WV, Drama Creek DCE).
UPDATE communities
   SET billing_code = vantaca_code
 WHERE (billing_code IS NULL OR billing_code = '')
   AND vantaca_code IS NOT NULL AND vantaca_code <> '';

-- Seed the rest with sensible short codes (Ed can edit any of these).
UPDATE communities SET billing_code = 'AM'  WHERE (billing_code IS NULL OR billing_code = '') AND name = 'August Meadows';
UPDATE communities SET billing_code = 'CG'  WHERE (billing_code IS NULL OR billing_code = '') AND name = 'Canyon Gate at Cinco Ranch';
UPDATE communities SET billing_code = 'EAG' WHERE (billing_code IS NULL OR billing_code = '') AND name = 'Eaglewood';
UPDATE communities SET billing_code = 'LPF' WHERE (billing_code IS NULL OR billing_code = '') AND name = 'Lakes of Pine Forest';
UPDATE communities SET billing_code = 'QR'  WHERE (billing_code IS NULL OR billing_code = '') AND name = 'Quail Ridge';
UPDATE communities SET billing_code = 'SCR' WHERE (billing_code IS NULL OR billing_code = '') AND name = 'Still Creek Ranch';

COMMIT;
