-- ============================================================================
-- 043_nominator_phone.sql
-- ----------------------------------------------------------------------------
-- Add nominator_phone to nominations so Bedrock has a callback number for
-- every submitter — required for confirming receipt of the nomination
-- ("we got your nomination for X, anything we should know?"). Phone is the
-- highest-conversion confirmation channel and the one boards expect.
--
-- nominator_email already exists; nominator_phone fills the gap. On the
-- public form, the submitter contact section (name, address, email, phone)
-- is always captured. For self-nominations, the submitter info is mirrored
-- into the nominee_* columns server-side so the data model stays consistent.
--
-- Apply AFTER 042. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nominations
  ADD COLUMN IF NOT EXISTS nominator_phone TEXT NULL;

COMMIT;

-- Verify:
--   SELECT id, nominator_name, nominator_email, nominator_phone,
--          is_self_nomination, nominee_name
--     FROM nominations ORDER BY created_at DESC LIMIT 5;
