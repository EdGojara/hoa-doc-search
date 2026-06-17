-- ============================================================================
-- PASTE THIS WHOLE FILE INTO SUPABASE SQL EDITOR AND RUN ONCE.
-- ----------------------------------------------------------------------------
-- Migration 227 (builder portal manager-view) was acknowledged-as-failed in
-- the runner, which prevents the runner from re-attempting it. This file is
-- the contents of the corrected migration 227 wrapped for manual paste-and-run.
--
-- Idempotent — safe to re-run. After this runs:
--   ✓ portal_manager_builder_scope + portal_manager_builder_view_log exist
--   ✓ Every staff portal_user who has portfolio-wide HOMEOWNER scope ALSO
--     gets portfolio-wide BUILDER scope (so Ed sees DRB + Lennar + all
--     builders on the picker)
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS portal_manager_builder_scope (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id      UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  builder_company_id  UUID REFERENCES builder_companies(id) ON DELETE CASCADE,
  granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by          TEXT,
  revoked_at          TIMESTAMPTZ,
  revoked_by          TEXT,
  notes               TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_builder_specific_grant
  ON portal_manager_builder_scope(portal_user_id, builder_company_id)
  WHERE builder_company_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_builder_portfolio_grant
  ON portal_manager_builder_scope(portal_user_id)
  WHERE builder_company_id IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_portal_manager_builder_user_active
  ON portal_manager_builder_scope(portal_user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE portal_manager_builder_scope IS
  'Per-manager builder access. NULL builder_company_id = portfolio-wide (all builders under the management_company). Specific builder_company_id = scoped to that one builder (for future franchise operators or CSMs).';

CREATE TABLE IF NOT EXISTS portal_manager_builder_view_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id),
  staff_email              TEXT,
  viewed_builder_id        UUID REFERENCES builder_companies(id) ON DELETE SET NULL,
  viewed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address               TEXT,
  user_agent               TEXT,
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_manager_builder_view_log_user_time
  ON portal_manager_builder_view_log(portal_user_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_manager_builder_view_log_builder_time
  ON portal_manager_builder_view_log(viewed_builder_id, viewed_at DESC)
  WHERE viewed_builder_id IS NOT NULL;

COMMENT ON TABLE portal_manager_builder_view_log IS
  'Audit trail: every time a manager session loads a builder dashboard view, log it. Lets us answer "who at Bedrock viewed builder X on date Y."';

-- Seed: anyone with portfolio-wide HOMEOWNER scope gets portfolio-wide
-- BUILDER scope. Idempotent via the partial unique index.
INSERT INTO portal_manager_builder_scope (portal_user_id, builder_company_id, granted_by, notes)
SELECT
  s.portal_user_id,
  NULL,
  'run_now_227_seed',
  'Auto-granted portfolio-wide builder scope alongside existing portfolio-wide homeowner scope.'
FROM portal_manager_scope s
WHERE s.community_id IS NULL
  AND s.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM portal_manager_builder_scope b
    WHERE b.portal_user_id = s.portal_user_id
      AND b.builder_company_id IS NULL
      AND b.revoked_at IS NULL
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON portal_manager_builder_scope    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_manager_builder_view_log TO service_role;
GRANT SELECT ON portal_manager_builder_scope    TO authenticated;
GRANT SELECT ON portal_manager_builder_view_log TO authenticated;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification queries (run separately AFTER the commit above):
-- ----------------------------------------------------------------------------
-- 1. Table exists + Ed has portfolio-wide scope:
--    SELECT p.email, s.builder_company_id, s.granted_at
--    FROM portal_manager_builder_scope s
--    JOIN portal_users p ON p.id = s.portal_user_id
--    WHERE p.email = 'egojara@bedrocktx.com';
--    Expect: 1 row, builder_company_id IS NULL.
--
-- 2. All Bedrock builders are visible:
--    SELECT id, company_name FROM builder_companies
--    WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--    ORDER BY company_name;
--    Expect: DRB Group, Lennar, and any others.
