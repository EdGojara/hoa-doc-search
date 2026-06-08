-- ============================================================================
-- 201_portal_manager_role.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Manager portal role. Lets Bedrock staff log into the
-- homeowner portal and pick ANY property in their managed portfolio to
-- view as that homeowner. Eliminates per-homeowner portal_user
-- provisioning for support, QA, training, prospect demos.
--
-- HOW IT'S DIFFERENT FROM MIMIC:
-- - Mimic = pick one specific portal_user, impersonate them (1:1)
-- - Manager = pick ANY property in portfolio, render its homeowner view
--   (1:N, no per-homeowner setup)
--
-- SECURITY MODEL:
-- - Manager role can only see communities under their management_company
-- - Every property switch is logged with staff_email + property_id
-- - No write actions while in manager view (read-only)
-- - The "I'm a manager" check happens at the API layer, not the UI
-- ============================================================================

BEGIN;

-- Expand portal_users.role to include 'manager'
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE portal_users
  ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('board_member', 'homeowner', 'renter', 'staff', 'admin', 'manager', 'franchisee', 'builder'));

COMMENT ON COLUMN portal_users.role IS
  'Portal user role. Drives tile gating + endpoint authorization. homeowner = property owner. renter = current resident only. board_member = elected board member. manager = Bedrock staff with read-only access to any property in portfolio for support/QA/training. staff/admin = Bedrock staff (full admin). builder = DRB/builder portal. franchisee = future franchise operators.';

-- Manager access scope — which communities a given manager can browse.
-- NULL community_id = all communities under the management_company
-- (the typical Bedrock staff case).
CREATE TABLE IF NOT EXISTS portal_manager_scope (
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  community_id             UUID REFERENCES communities(id) ON DELETE CASCADE,  -- NULL = all communities
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by               TEXT,
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  notes                    TEXT,
  -- One row per (manager, community) OR one row with NULL community for
  -- portfolio-wide access. The partial unique index enforces "one
  -- portfolio-wide grant per manager."
  PRIMARY KEY (portal_user_id, community_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_manager_portfolio_grant
  ON portal_manager_scope(portal_user_id)
  WHERE community_id IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE portal_manager_scope IS
  'Per-manager community access. NULL community_id = portfolio-wide (all communities under the management_company). Specific community_id = scoped to that one community (for future franchise operators).';

-- Audit log for property-view switches in manager mode. Lets us trace
-- "who looked at what" — required if a homeowner ever asks "why did
-- staff X view my account on date Y."
CREATE TABLE IF NOT EXISTS portal_manager_view_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id),
  staff_email              TEXT,
  viewed_property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,
  viewed_community_id      UUID REFERENCES communities(id) ON DELETE SET NULL,
  viewed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address               TEXT,
  user_agent               TEXT,
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_manager_view_log_user_time
  ON portal_manager_view_log(portal_user_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_manager_view_log_property_time
  ON portal_manager_view_log(viewed_property_id, viewed_at DESC)
  WHERE viewed_property_id IS NOT NULL;

COMMENT ON TABLE portal_manager_view_log IS
  'Audit trail: every time a manager session loads a property view, log it. Lets us answer "who at Bedrock viewed property X on date Y."';

-- Service-role grants (CLAUDE.md rule from earlier today — never forget)
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_manager_scope    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_manager_view_log TO service_role;
GRANT SELECT ON portal_manager_scope    TO authenticated;
GRANT SELECT ON portal_manager_view_log TO authenticated;

COMMIT;
