-- ============================================================================
-- 186_renter_portal_access.sql
-- ----------------------------------------------------------------------------
-- Renter portal access (Ed 2026-06-08).
--
-- Renters get a SCOPED portal experience — pool fob, amenity reservations,
-- community calendar, rules docs, messages to Bedrock. They do NOT see
-- account balance, violations, ACC submissions, financials, meetings, or
-- the board portal — those are owner-only concerns.
--
-- ENFORCEMENT MODEL:
-- This migration provides the data model. The actual security guarantee
-- lives in api/portal.js: each endpoint declares the role classes that can
-- hit it, and renter sessions are physically refused at sensitive endpoints
-- (HTTP 403, not just hidden tiles). Defense in depth.
--
-- THREE SCHEMA CHANGES:
-- 1. Add 'renter' as a valid value on portal_users.role CHECK constraint.
-- 2. Create portal_user_residencies — parallel to portal_user_properties
--    but keyed on the residency row instead of the property. When the
--    residency ends (renter moves out → end_date set on
--    property_residencies), their portal access expires structurally.
-- 3. Capability matrix: documented as inline COMMENT for ops + future
--    iteration. Code-level enforcement is in api/portal.js, not here —
--    DB-level enforcement would require RLS rewrites we're not ready for.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Expand portal_users.role to include 'renter'
-- ----------------------------------------------------------------------------
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE portal_users
  ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('board_member', 'homeowner', 'renter', 'staff', 'admin', 'franchisee', 'builder'));

COMMENT ON COLUMN portal_users.role IS
  'Portal user role. Drives tile gating + endpoint authorization. homeowner = property owner (full access). renter = current resident only (scoped to amenity/community/messaging — NO AR / violations / ACC / financials / meetings / board portal). board_member = elected board member (full owner access + board portal switcher). staff/admin = Bedrock staff. builder = DRB Group / builder portal. franchisee = future Bedrock franchise operators.';

-- ----------------------------------------------------------------------------
-- 2) portal_user_residencies — links a renter portal user to a specific
--    residency row. When the residency ends (end_date set on the residency),
--    a daily job can revoke this row — or the API can do a live join check
--    on every /me to enforce it without a maintenance task.
--
--    Choice: live join check. Adds ~10ms per /me but ensures a renter who
--    just had their residency ended cannot continue accessing the portal
--    until a batch job runs. Aligns with the catastrophic-output discipline.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_user_residencies (
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  residency_id             UUID NOT NULL REFERENCES property_residencies(id) ON DELETE CASCADE,
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by               TEXT,
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  notes                    TEXT,
  PRIMARY KEY (portal_user_id, residency_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_residencies_active
  ON portal_user_residencies(portal_user_id, residency_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE portal_user_residencies IS
  'Renter portal access. Renter sessions reach property data ONLY through this join — and the join is restricted to current residencies (property_residencies.end_date IS NULL). When the lease ends, the residency row gets end_date set and the renter loses portal access on next /me without any maintenance action.';

-- ----------------------------------------------------------------------------
-- 3) Capability matrix — DOCUMENTATION only. The actual gating is in
--    api/portal.js. Listed here so the ops team + future maintainers can
--    see the intent without code-spelunking.
-- ----------------------------------------------------------------------------
COMMENT ON CONSTRAINT portal_users_role_check ON portal_users IS
  'Role capability matrix (enforced in api/portal.js):
   ===========================================================
                              homeowner  renter  board_member
   Property summary           full       basic   full
   Account balance / AR       yes        NO      yes
   Compliance / violations    yes        NO      yes (all)
   ACC submissions            yes        NO      yes (all)
   Pool / gate fob request    yes        yes     yes
   Clubhouse reservation      yes        yes     yes
   Community calendar         yes        yes     yes
   Trash schedule             yes        yes     yes
   Local contacts             yes        yes     yes
   Messages to Bedrock        yes        yes     yes
   Documents (homeowner-safe) yes        SCOPED  yes
   Financials                 yes        NO      yes
   Meetings / agendas         yes        NO      yes
   Board portal               if board   NO      yes
   Annual meeting voting      yes (members) NO   yes
   ===========================================================
   Renter document scope: rules_and_regulations, design_document
   (architectural guidelines), forms_and_applications, welcome_package.
   Excludes governing docs (CCRs, bylaws — owners-only by statute in
   many states), financials, meeting minutes, reserve studies.';

COMMIT;
