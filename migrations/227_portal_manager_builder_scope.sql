-- ============================================================================
-- 227_portal_manager_builder_scope.sql
-- ----------------------------------------------------------------------------
-- Staff impersonation for the BUILDER portal. Mirrors the homeowner-side
-- portal_manager_scope + portal_manager_view_log from migration 201 so the
-- two staff-preview flows behave identically:
--   - Bedrock staff signs in via Microsoft 365
--   - Picks a builder (DRB Group, Lennar, ...) from a portfolio-wide picker
--   - Sees the builder dashboard exactly as that builder would, banner up top
--   - Every view audit-logged
--
-- Ed 2026-06-16: "we can put management company view... it's important we
-- can troubleshoot and see what they see."
-- ============================================================================

BEGIN;

-- Builder access scope for managers. Mirrors portal_manager_scope exactly.
-- NULL builder_company_id = all builders under the management_company (the
-- typical Bedrock admin case). Specific builder_company_id = scoped grant
-- (for future franchise operators or per-builder Bedrock CSMs).
--
-- IMPORTANT scar (Ed 2026-06-16): the original draft of this migration put
-- (portal_user_id, builder_company_id) as the PRIMARY KEY, which Postgres
-- implicitly enforces NOT NULL on -- silently blocking the portfolio-wide
-- (NULL builder_company_id) INSERT. This is the SAME scar migration 207
-- carries about portal_manager_scope. Synthetic id PK + partial unique
-- indexes is the right pattern.
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

-- One row per (manager, specific-builder) when active.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_builder_specific_grant
  ON portal_manager_builder_scope(portal_user_id, builder_company_id)
  WHERE builder_company_id IS NOT NULL AND revoked_at IS NULL;

-- One portfolio-wide grant per manager.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_builder_portfolio_grant
  ON portal_manager_builder_scope(portal_user_id)
  WHERE builder_company_id IS NULL AND revoked_at IS NULL;

-- Lookup index used by /api/builder-applications/manager/builders and the
-- /portal/my-submissions scope check.
CREATE INDEX IF NOT EXISTS idx_portal_manager_builder_user_active
  ON portal_manager_builder_scope(portal_user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE portal_manager_builder_scope IS
  'Per-manager builder access. NULL builder_company_id = portfolio-wide (all builders under the management_company). Specific builder_company_id = scoped to that one builder (for future franchise operators or CSMs).';

-- Audit log. Every staff-as-builder dashboard load lands here so we can
-- answer "who looked at DRB Group's submissions on date X."
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

-- Seed: any existing portal_users row that ALREADY has portfolio-wide
-- homeowner scope (NULL community_id in portal_manager_scope) gets the
-- same portfolio-wide builder scope. Ed + admin staff don't have to be
-- re-granted -- they get both at once.
INSERT INTO portal_manager_builder_scope (portal_user_id, builder_company_id, granted_by, notes)
SELECT
  portal_user_id,
  NULL,
  COALESCE(granted_by, 'migration_227_auto'),
  'Auto-granted portfolio-wide builder scope alongside existing portfolio-wide homeowner scope.'
FROM portal_manager_scope
WHERE community_id IS NULL
  AND revoked_at IS NULL
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON portal_manager_builder_scope    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_manager_builder_view_log TO service_role;
GRANT SELECT ON portal_manager_builder_scope    TO authenticated;
GRANT SELECT ON portal_manager_builder_view_log TO authenticated;

COMMIT;
