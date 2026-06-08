-- ============================================================================
-- 208_portal_manager_scope_drop_not_null.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Follow-up to 207. The BEGIN/COMMIT in 207 rolled back
-- entirely because the backfill INSERT failed with:
--   "null value in column community_id of relation portal_manager_scope
--    violates not-null constraint"
--
-- ROOT CAUSE: In PostgreSQL, dropping a PRIMARY KEY constraint does NOT
-- automatically drop the implicit NOT NULL on the columns that were part
-- of it. The PK we dropped in 207 had set community_id NOT NULL; dropping
-- the PK left that NOT NULL in place.
--
-- THIS MIGRATION redoes the work in 207 idempotently AND adds the
-- explicit `ALTER COLUMN ... DROP NOT NULL` step. After this runs,
-- portal_manager_scope can hold NULL community_id (= portfolio-wide).
--
-- Mark 207 as acknowledged in the runner — this migration supersedes it.
-- ============================================================================

BEGIN;

-- 1. Drop the original PK (may or may not still exist depending on whether
-- 207 partially succeeded — defensive)
ALTER TABLE portal_manager_scope
  DROP CONSTRAINT IF EXISTS portal_manager_scope_pkey;

-- 2. Drop the implicit NOT NULL that came from the original PK
ALTER TABLE portal_manager_scope
  ALTER COLUMN community_id DROP NOT NULL;

-- 3. Add surrogate id PK so the table has one
ALTER TABLE portal_manager_scope
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

UPDATE portal_manager_scope SET id = gen_random_uuid() WHERE id IS NULL;

ALTER TABLE portal_manager_scope
  ALTER COLUMN id SET NOT NULL;

-- Only add the PK if it doesn't already exist (207 may have added it)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'portal_manager_scope_pkey'
      AND conrelid = 'portal_manager_scope'::regclass
  ) THEN
    ALTER TABLE portal_manager_scope
      ADD CONSTRAINT portal_manager_scope_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- 4. Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_specific_grant
  ON portal_manager_scope(portal_user_id, community_id)
  WHERE community_id IS NOT NULL AND revoked_at IS NULL;

-- (uniq_portal_manager_portfolio_grant exists from 201 — partial unique on
-- portal_user_id WHERE community_id IS NULL AND revoked_at IS NULL)

-- 5. Backfill — every active manager portal_user gets portfolio-wide scope
INSERT INTO portal_manager_scope (portal_user_id, community_id, granted_by, notes)
SELECT
  pu.id,
  NULL,
  'migration_208_backfill',
  'Auto-granted portfolio-wide access — recovery from PK-implies-NOT-NULL bug.'
FROM portal_users pu
WHERE pu.role = 'manager'
  AND pu.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM portal_manager_scope pms
    WHERE pms.portal_user_id = pu.id
      AND pms.revoked_at IS NULL
  );

COMMIT;
