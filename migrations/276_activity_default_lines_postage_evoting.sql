-- ============================================================================
-- 276_activity_default_lines_postage_evoting.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- Adjust which rate rows PREPOPULATE a fresh activity invoice (default_on_invoice,
-- mig 271):
--   - Electronic Voting OUT: it's an occasional election-cycle charge, not a
--     monthly line. It stays on the rate card and is addable via Add Line Item /
--     the generate preview, just not prepopulated.
--   - Postage IN: postage is billed every activity cycle, so it should always be
--     on the prepopulated template. Matches any postage-type rate row (some
--     contracts use 'postage', others 'postage_drv_notices').
--
-- Rate-card config only (contract_reimbursables); no schema change.
-- ============================================================================
BEGIN;

UPDATE contract_reimbursables
   SET default_on_invoice = false
 WHERE category = 'electronic_voting';

UPDATE contract_reimbursables
   SET default_on_invoice = true
 WHERE category ILIKE '%postage%'
    OR description ILIKE '%postage%';

COMMIT;
