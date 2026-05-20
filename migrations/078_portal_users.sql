-- ============================================================================
-- 078_portal_users.sql
-- ----------------------------------------------------------------------------
-- Portal user management — the admin layer for the board portal +
-- homeowner portal (project_portal_release_gates.md).
--
-- This migration adds the SCHEMA + admin surface only. Actual auth
-- enforcement on the portals (release gates 1+2+3) comes in a subsequent
-- commit. Until then, the existing STAFF_PASSWORD gate continues to protect
-- the portals; this admin layer lets Ed start managing the list of users
-- BEFORE the auth flips over.
--
-- Why now: defining who the users are + what they can access is the
-- input the auth layer needs. Building user management first means the
-- auth work just plugs into existing data; building auth first means
-- user management has to refit. Cleaner sequence.
--
-- Apply AFTER 077. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) portal_users — one row per person with portal access
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  email                    TEXT NOT NULL,
  full_name                TEXT,
  role                     TEXT NOT NULL
                             CHECK (role IN ('board_member', 'homeowner', 'staff', 'admin', 'franchisee')),
  status                   TEXT NOT NULL DEFAULT 'invited'
                             CHECK (status IN ('invited', 'active', 'revoked')),
  -- Optional link to a contact row when we know the same person.
  -- Set when the homeowner's email matches a contacts.primary_email.
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,

  invited_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by               TEXT,
  first_login_at           TIMESTAMPTZ,
  last_login_at            TIMESTAMPTZ,
  login_count              INTEGER NOT NULL DEFAULT 0,
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One portal user per email per management company. Stops accidental
  -- duplicates when the operator re-invites someone.
  UNIQUE (management_company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_portal_users_role_status
  ON portal_users(management_company_id, role, status);
CREATE INDEX IF NOT EXISTS idx_portal_users_email
  ON portal_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_portal_users_contact
  ON portal_users(contact_id)
  WHERE contact_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_portal_users_updated_at ON portal_users;
CREATE TRIGGER trg_portal_users_updated_at
  BEFORE UPDATE ON portal_users
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2) portal_user_communities — which communities this user can see (board)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_user_communities (
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by               TEXT,
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  notes                    TEXT,
  PRIMARY KEY (portal_user_id, community_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_communities_active
  ON portal_user_communities(portal_user_id, community_id)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3) portal_user_properties — which properties this user can see (homeowner)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_user_properties (
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  property_id              UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by               TEXT,
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  notes                    TEXT,
  PRIMARY KEY (portal_user_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_properties_active
  ON portal_user_properties(portal_user_id, property_id)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 4) portal_magic_links — one-time tokens for passwordless login
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_magic_links (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  token                    TEXT NOT NULL UNIQUE,           -- 32-byte hex
  purpose                  TEXT NOT NULL DEFAULT 'invite'
                             CHECK (purpose IN ('invite', 'login', 'password_reset')),
  expires_at               TIMESTAMPTZ NOT NULL,
  used_at                  TIMESTAMPTZ,
  used_ip                  TEXT,
  used_user_agent          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_user
  ON portal_magic_links(portal_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_magic_links_active
  ON portal_magic_links(token, expires_at)
  WHERE used_at IS NULL;

-- ----------------------------------------------------------------------------
-- 5) portal_audit_log — every portal-related action logged for compliance
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_audit_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id           UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  action                   TEXT NOT NULL,                  -- 'invite_sent', 'login', 'view_property', 'view_community', 'revoke', etc.
  resource_type            TEXT,                           -- 'community', 'property', 'user'
  resource_id              UUID,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address               TEXT,
  user_agent               TEXT,
  performed_by             TEXT,                           -- admin email if action was an admin operation
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_audit_user_recent
  ON portal_audit_log(portal_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_audit_action
  ON portal_audit_log(action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_audit_resource
  ON portal_audit_log(resource_type, resource_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 6) View for the admin UI: portal users with active-scope counts
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_portal_users_summary AS
SELECT
  pu.id,
  pu.management_company_id,
  pu.email,
  pu.full_name,
  pu.role,
  pu.status,
  pu.contact_id,
  pu.invited_at,
  pu.invited_by,
  pu.first_login_at,
  pu.last_login_at,
  pu.login_count,
  pu.revoked_at,
  pu.notes,
  COALESCE(comm_count.cnt, 0) AS active_communities,
  COALESCE(prop_count.cnt, 0) AS active_properties,
  COALESCE(ml.pending_invites, 0) AS pending_magic_links
FROM portal_users pu
LEFT JOIN (
  SELECT portal_user_id, COUNT(*)::int AS cnt
  FROM portal_user_communities
  WHERE revoked_at IS NULL
  GROUP BY portal_user_id
) comm_count ON comm_count.portal_user_id = pu.id
LEFT JOIN (
  SELECT portal_user_id, COUNT(*)::int AS cnt
  FROM portal_user_properties
  WHERE revoked_at IS NULL
  GROUP BY portal_user_id
) prop_count ON prop_count.portal_user_id = pu.id
LEFT JOIN (
  SELECT portal_user_id, COUNT(*)::int AS pending_invites
  FROM portal_magic_links
  WHERE used_at IS NULL AND expires_at > NOW()
  GROUP BY portal_user_id
) ml ON ml.portal_user_id = pu.id;

-- ----------------------------------------------------------------------------
-- Grants + comments
-- ----------------------------------------------------------------------------
GRANT ALL ON
  portal_users,
  portal_user_communities,
  portal_user_properties,
  portal_magic_links,
  portal_audit_log
  TO service_role;

GRANT SELECT ON v_portal_users_summary TO service_role, authenticated;

COMMENT ON TABLE portal_users IS
  'Portal user roster (board members, homeowners, staff, future franchisees). Auth enforcement on portals comes after this schema lands; admin surface uses these tables to manage who CAN access before auth flips over.';
COMMENT ON TABLE portal_magic_links IS
  'One-time tokens for passwordless login. 32-byte hex tokens. Expire after configurable window (default 1 hour for login, 7 days for invite).';
COMMENT ON TABLE portal_audit_log IS
  'Every portal-related action logged for compliance + consistent-enforcement defense. See project_portal_release_gates.md gate 3.';
