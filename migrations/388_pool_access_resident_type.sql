-- ============================================================================
-- 388 — Pool access: owner vs renter.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-25: "we should have owner vs renter in our records."
--
-- A pool registration files onto the property's owner of record, but the person
-- who actually holds the fob may be a TENANT. Communities care about that
-- distinction (renter access is often capped or conditioned on the owner being
-- current), so capture it on the registration rather than inferring it.
--
-- 'unknown' is the default so existing rows are honest about not knowing yet,
-- and a form that does not state it does not force a guess.
--
-- Record ownership: association_record (same as the pool_access row it lives on).
-- ============================================================================
BEGIN;

ALTER TABLE pool_access
  ADD COLUMN IF NOT EXISTS resident_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (resident_type IN ('owner', 'tenant', 'unknown'));

COMMENT ON COLUMN pool_access.resident_type IS
  'Whether the fob/access holder is the property owner or a tenant (renter). unknown = not stated on the form / not yet set.';

COMMIT;

NOTIFY pgrst, 'reload schema';
