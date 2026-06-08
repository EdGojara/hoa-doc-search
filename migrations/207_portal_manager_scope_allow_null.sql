-- ============================================================================
-- 207_portal_manager_scope_allow_null.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Fix manager portal scope: NULL community_id is supposed
-- to mean "portfolio-wide" but the original PK (portal_user_id, community_id)
-- forced community_id NOT NULL, so the staff-enter portfolio-wide upsert
-- silently failed. Result: every staff member who used the Portal link
-- got zero scope rows → every property opened returned 403
-- property_outside_manager_scope.
--
-- Fix:
--   1. Drop the composite PK
--   2. Replace with TWO unique constraints that allow NULL community_id:
--      - Partial unique on (portal_user_id) WHERE community_id IS NULL
--        (one portfolio-wide grant per manager — already exists from
--        migration 201)
--      - Unique on (portal_user_id, community_id) where community_id NOT
--        NULL (one row per specific community)
--   3. Backfill: any portal_user with role='manager' but no active scope
--      gets a portfolio-wide grant. Idempotent.
-- ============================================================================

BEGIN;

-- 1. Drop the PK that's blocking NULL community_id
ALTER TABLE portal_manager_scope
  DROP CONSTRAINT IF EXISTS portal_manager_scope_pkey;

-- 2. Add explicit primary key surrogate so the table has one
ALTER TABLE portal_manager_scope
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

UPDATE portal_manager_scope SET id = gen_random_uuid() WHERE id IS NULL;

ALTER TABLE portal_manager_scope
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE portal_manager_scope
  ADD CONSTRAINT portal_manager_scope_pkey PRIMARY KEY (id);

-- 3. Specific-community uniqueness (one active row per manager per community)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_specific_grant
  ON portal_manager_scope(portal_user_id, community_id)
  WHERE community_id IS NOT NULL AND revoked_at IS NULL;

-- 4. Backfill — any manager portal_user without an active scope gets
--    portfolio-wide access. Bedrock staff using staff-enter expect this.
INSERT INTO portal_manager_scope (portal_user_id, community_id, granted_by, notes)
SELECT
  pu.id,
  NULL,
  'migration_207_backfill',
  'Auto-granted portfolio-wide access — recovery from PK bug that blocked NULL inserts.'
FROM portal_users pu
WHERE pu.role = 'manager'
  AND pu.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM portal_manager_scope pms
    WHERE pms.portal_user_id = pu.id
      AND pms.revoked_at IS NULL
  );

COMMIT;
