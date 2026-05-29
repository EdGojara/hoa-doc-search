-- ============================================================================
-- 128_builder_arc_ed_test_account.sql
-- ----------------------------------------------------------------------------
-- Adds Ed's personal Comcast email as a test/demo "builder" account so he
-- can sign in via magic link and see the DRB-facing portal exactly as
-- Karla will see it during this morning's call. Same access scope (linked
-- to DRB Group), no special-case bypass — verifies the whole flow end-to-
-- end including the magic-link delivery + cookie + portal_user_builders
-- gate.
--
-- Why a separate row (not just an alias for egojara@bedrocktx.com):
--   - Ed's bedrocktx.com email already exists in portal_users with role
--     'staff' or 'admin'. Re-using it would either need a role flip (and
--     risk losing staff access) or a multi-role design we haven't built.
--   - A standalone Comcast email = standalone portal_user row = clean
--     test surface, no contamination of his staff identity.
--
-- Idempotent via the same UNIQUE (management_company_id, email) constraint
-- used by migration 127.
-- ============================================================================

BEGIN;

-- 1) Insert Ed's test portal_user (role=builder) ---------------------------
INSERT INTO portal_users (
  management_company_id,
  email,
  full_name,
  role,
  status,
  invited_by,
  notes
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'edgetrading@comcast.net',
  'Ed Gojara (test — DRB portal)',
  'builder',
  'active',
  'egojara@bedrocktx.com',
  'TEST/DEMO ACCOUNT. Used by Ed to dry-run the DRB-facing builder portal before showing it to Karla Rutan on the 2026-05-29 call. Linked to DRB Group via portal_user_builders so the access scope matches what Karla will see. Revoke after demos no longer need it.'
)
ON CONFLICT (management_company_id, email) DO NOTHING;


-- 2) Link Ed's test account → DRB Group ------------------------------------
INSERT INTO portal_user_builders (
  portal_user_id,
  builder_company_id,
  granted_at,
  granted_by,
  notes
)
SELECT
  pu.id,
  bc.id,
  NOW(),
  'egojara@bedrocktx.com',
  'Test access for the DRB portal walkthrough. Mirrors Karla''s grant; revoke when no longer needed.'
FROM portal_users pu
CROSS JOIN builder_companies bc
WHERE pu.management_company_id = '00000000-0000-0000-0000-000000000001'
  AND pu.email = 'edgetrading@comcast.net'
  AND bc.management_company_id = '00000000-0000-0000-0000-000000000001'
  AND LOWER(bc.company_name) = LOWER('DRB Group')
ON CONFLICT (portal_user_id, builder_company_id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION (run in SQL editor)
-- ============================================================================
-- SELECT pu.email, pu.role, pu.status, bc.company_name, pub.granted_at, pub.revoked_at
-- FROM portal_users pu
-- JOIN portal_user_builders pub ON pub.portal_user_id = pu.id
-- JOIN builder_companies bc ON bc.id = pub.builder_company_id
-- WHERE pu.email = 'edgetrading@comcast.net';
--
-- ============================================================================
-- REVOKE LATER (when test access no longer needed) — paste into SQL editor
-- ============================================================================
-- UPDATE portal_user_builders
-- SET revoked_at = NOW(), revoked_by = 'egojara@bedrocktx.com'
-- WHERE portal_user_id = (SELECT id FROM portal_users WHERE email = 'edgetrading@comcast.net')
--   AND revoked_at IS NULL;
-- UPDATE portal_users
-- SET status = 'revoked', revoked_at = NOW(), revoked_by = 'egojara@bedrocktx.com'
-- WHERE email = 'edgetrading@comcast.net';
