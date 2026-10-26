-- ============================================================================
-- 548_user_profiles_lockdown.sql  (Ed 2026-10-26) — security fix
-- ----------------------------------------------------------------------------
-- THE HOLE. Migration 039 granted the `authenticated` role (every signed-in
-- user, using the public anon key plus their own token) SELECT, INSERT, UPDATE
-- and DELETE on user_profiles, and never enabled row level security. So any
-- staffer could call the database API directly and:
--   - set their own role to 'admin' and email to the owner's address (which
--     passes requireAdmin / requireOwner in api/_require_admin.js);
--   - demote, deactivate or delete the owner's profile (locking Ed out);
--   - read every staff profile.
-- The application never needed any of it: every read and write of
-- user_profiles goes through the server's service-role key (verified: no
-- browser code queries the table).
--
-- THE FIX (smallest safe change; no row is touched):
--   1) Enable row level security on user_profiles.
--   2) Revoke every write privilege from authenticated and anon (and PUBLIC).
--      Writes stay where they already are: the server (service_role, which
--      bypasses RLS) and the two SECURITY DEFINER sign-in triggers from 039
--      (handle_new_user, handle_user_sign_in), which run as the table owner.
--   3) authenticated keeps SELECT, limited by policy to its own row.
--
-- Unchanged: every row (protected byte-for-byte by the checks file), the
-- table's columns and constraints, the sign-in triggers, service_role's
-- privileges. Ed remains the only admin.
--
-- Record ownership: n/a (privileges only).
-- Rollback (restores the hole; only if something legitimate breaks):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO authenticated;
--   ALTER TABLE user_profiles DISABLE ROW LEVEL SECURITY;
-- ============================================================================
BEGIN;

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON user_profiles FROM authenticated, anon, PUBLIC;
REVOKE SELECT ON user_profiles FROM anon, PUBLIC;
GRANT SELECT ON user_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO service_role;

DROP POLICY IF EXISTS user_profiles_read_own ON user_profiles;
CREATE POLICY user_profiles_read_own ON user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

COMMIT;
