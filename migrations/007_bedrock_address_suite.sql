-- ============================================================================
-- 007_bedrock_address_suite.sql
-- ----------------------------------------------------------------------------
-- Update Bedrock's mailing address to include Ste 253. The original 001 seed
-- recorded the address without the suite number; the actual mailing address
-- is "12808 W Airport Blvd, Ste 253, Sugar Land, TX 77478".
--
-- Apply AFTER 001. Idempotent.
-- ============================================================================

UPDATE management_companies
SET address = '12808 W Airport Blvd, Ste 253, Sugar Land, TX 77478'
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Verify with:
--   SELECT name, address FROM management_companies
--   WHERE id = '00000000-0000-0000-0000-000000000001';
