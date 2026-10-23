-- ============================================================================
-- 543_delivery_receipts_grants.sql  (Ed 2026-10-23)
-- ----------------------------------------------------------------------------
-- delivery_receipts (migration 065) was created without a GRANT to
-- service_role, the role the API writes with. Every receipt write (mail, email,
-- SMS and portal-notify evidence) has failed with "permission denied for table
-- delivery_receipts", and the property Evidence panel's read fails the same way.
-- The CLAUDE.md "new tables without service_role GRANTs are silently
-- unwritable" scar.
--
-- Grants the API what it uses: read, write and the status updates delivery
-- webhooks make. No DELETE: receipts are an evidence trail. Nothing to anon or
-- authenticated: the browser reads receipts only through the API. Changes no
-- row and no table structure.
-- Record ownership: association_record (delivery evidence for notices sent on
-- behalf of the association). No schema change here.
-- ============================================================================
BEGIN;

GRANT SELECT, INSERT, UPDATE ON public.delivery_receipts TO service_role;

COMMIT;
