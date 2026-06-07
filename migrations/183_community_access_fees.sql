-- 183: Add access_fees JSONB to communities for Claire's fee lookups
--
-- Stores per-community fee schedule for key fobs, pool keys, amenity
-- rentals, and similar access/usage fees. Drives the getKeyFobInfo and
-- related Vapi tools so Claire can quote actual fees instead of guessing.
--
-- Shape (all fields optional — community admin fills in what applies):
--   {
--     "key_fob_owner_new": 25,
--     "key_fob_owner_replacement": 50,
--     "key_fob_tenant_new": 50,
--     "key_fob_tenant_replacement": 75,
--     "pool_key_new": 0,
--     "pool_key_replacement": 25,
--     "clubhouse_rental_owner": 150,
--     "amenity_rental_party_room": 200,
--     "application_portal_url": "home.bedrocktx.com"     -- override the
--                                                            default portal
--   }
--
-- When a fee key is missing, the tool tells Claire to confirm the amount
-- rather than guess. Never default to a hard-coded number — that's how
-- you end up promising fees the board never authorized.
--
-- Record ownership: workpaper (Bedrock's operational config).

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS access_fees JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN communities.access_fees IS
  'Per-community fee schedule for key fobs, amenity rentals, and related '
  'access fees. Drives the getKeyFobInfo Vapi tool. Empty default means '
  'Claire tells callers she will confirm the exact amount rather than guess.';

COMMIT;
