-- 174: Patch Columbia Bank routing number
--
-- Per Ed's screenshot 2026-06-06: Columbia Bank ABA = 111025453 (both
-- check and deposit). Migration 173 seeded Columbia with NULL routing
-- because we didn't have the value at seed time.
--
-- Idempotent — only updates if currently NULL (so re-running won't
-- clobber a manually-set value).

BEGIN;

UPDATE banks
SET aba_check = '111025453',
    aba_deposit = '111025453'
WHERE management_company_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND name = 'Columbia Bank'
  AND aba_check IS NULL;

COMMIT;
