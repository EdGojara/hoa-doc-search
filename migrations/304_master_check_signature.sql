-- ============================================================================
-- 304_master_check_signature.sql  (Ed 2026-07-16)
-- ----------------------------------------------------------------------------
-- Ed: "make it master signature for all communities. i am the signer on all our
-- accounts."
--
-- The authorized signature was stored per bank_account, so Ed's signature lived
-- only on the one account he'd set up (LOPF Operating Checking) and every other
-- community's check setup showed "no signature". Since Ed signs for all of them,
-- the signature is really the MANAGEMENT COMPANY's authorized-signer image — one
-- master, applied to every account.
--
-- Stored once here. The check renderer uses a per-account signature when one is
-- explicitly set (so a community that ever needs a different signer can override)
-- and otherwise falls back to this master. New accounts inherit it automatically,
-- no re-upload.
--
-- Record ownership: workpaper (Bedrock's signing asset), but it prints on
-- association checks — treat the image as sensitive.
-- ============================================================================

BEGIN;

ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS check_signature_image TEXT;

COMMENT ON COLUMN management_companies.check_signature_image IS
  'Master authorized-signature image (data URL or storage path) for check printing. Falls back to this when a bank_account has no per-account signature. Ed 2026-07-16.';

-- Seed the master from the signature already on file (Ed uploaded his to LOPF
-- Operating Checking). Copies the most-recently-updated per-account signature to
-- the company master. Idempotent: only fills a still-empty master.
UPDATE management_companies mc
SET check_signature_image = (
      SELECT ba.signature_image_path
      FROM bank_accounts ba
      WHERE ba.management_company_id = mc.id
        AND ba.signature_image_path IS NOT NULL
      ORDER BY ba.updated_at DESC
      LIMIT 1)
WHERE mc.check_signature_image IS NULL
  AND EXISTS (
      SELECT 1 FROM bank_accounts ba
      WHERE ba.management_company_id = mc.id
        AND ba.signature_image_path IS NOT NULL);

-- Clear the per-account signatures now that the master holds the image. Ed is
-- the sole signer, so nothing should override the master; if he later updates
-- the master, a lingering per-account copy would silently print the OLD one on
-- that community's checks. No data loss: the image is preserved on the company
-- master above before these are cleared. (A future per-community override is
-- still possible by explicitly setting a per-account signature.)
UPDATE bank_accounts ba
SET signature_image_path = NULL
WHERE ba.signature_image_path IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM management_companies mc
      WHERE mc.id = ba.management_company_id
        AND mc.check_signature_image IS NOT NULL);

COMMIT;
