-- ============================================================================
-- 525_bank_positive_pay_settings.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- Positive Pay exception notices are Kat's accounting work (lib/banking/
-- positive_pay_notice.js): each presented item is matched to the issued-check
-- register, the bank's deadline is tracked, and an unexpected recipient of our
-- account data is escalated to Ed. What differs by BANK lives here, as data:
--
--   banks.positive_pay_settings jsonb:
--     exception_cutoff        'HH:MM' Central: the bank's daily decision cutoff
--     notice_sender_domain    the domain the bank's notices come from
--     expected_recipients     the addresses the bank was asked to notify; any
--                             other recipient is reported as unexpected
--     source                  where each value came from
--
-- NewFirst National Bank: cutoff 10:00 (Melody Hess, VP, email to Kat 2026-09-08:
-- "Our daily cutoff time for handling exceptions is 10:00 am"; the automated
-- notice says 11:00 and the earlier time governs); notices from newfirst.com; the
-- four recipients on every notice from go-live (2026-09-10) through 2026-10-09.
-- accounting@graywoodpropertiesllc.com first appeared 2026-10-13 and is NOT
-- expected: it is under investigation with the bank.
-- Configuration only. Record ownership: workpaper.
-- ============================================================================
BEGIN;

ALTER TABLE banks ADD COLUMN IF NOT EXISTS positive_pay_settings jsonb;
COMMENT ON COLUMN banks.positive_pay_settings IS 'Positive Pay exception handling for this bank: exception_cutoff (HH:MM Central), notice_sender_domain, expected_recipients[], source. Read by lib/banking/positive_pay_notice.js.';

UPDATE banks
   SET positive_pay_settings = jsonb_build_object(
         'exception_cutoff', '10:00',
         'notice_sender_domain', 'newfirst.com',
         'expected_recipients', jsonb_build_array('cdeleon@bedrocktx.com', 'egojara@bedrocktx.com', 'kat@bedrocktx.com', 'treasurymanagement@newfirst.com'),
         'source', 'Cutoff: Melody Hess (NewFirst VP) to Kat, 2026-09-08. Recipients: every NewFirst Positive Pay notice 2026-09-10 to 2026-10-09.')
 WHERE id = '16e07b6a-8902-4d1a-980e-db78938b98b3' AND name = 'NewFirst National Bank' AND positive_pay_settings IS NULL;

COMMIT;
