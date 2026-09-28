-- verify_user_profiles_privileges.sql  (2026-09-28)
-- READ-ONLY. Paste into the Supabase SQL editor and run. Changes nothing.
--
-- Why: migrations/039_user_profiles.sql:33 grants SELECT/INSERT/UPDATE/DELETE on
-- user_profiles to `authenticated`, and no migration in the repo enables RLS on
-- it. requireAdmin/requireOwner (api/_require_admin.js) trust user_profiles.role.
-- If production matches the repo, any signed-in Supabase user could PATCH their
-- own role through PostgREST. This script reports the ACTUAL production state so
-- nobody claims (or dismisses) that without evidence.
--
-- Expected SAFE state: rls_enabled = true AND authenticated/anon have no
-- INSERT/UPDATE/DELETE (and ideally no SELECT) on user_profiles.

-- 1) Row-level security on the table
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'user_profiles';

-- 2) Policies (only matter if RLS is enabled)
SELECT policyname, cmd, roles, permissive, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'user_profiles'
 ORDER BY policyname;

-- 3) Table grants by role (the heart of it)
SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name = 'user_profiles'
 GROUP BY grantee
 ORDER BY grantee;

-- 4) Column-level grants on role/is_active (a column grant could also allow the write)
SELECT grantee, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND table_name = 'user_profiles'
   AND column_name IN ('role', 'is_active', 'management_company_id')
   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY grantee, column_name, privilege_type;

-- 5) Effective privilege check, as each client-facing role would see it
SELECT r AS role,
       has_table_privilege(r, 'public.user_profiles', 'SELECT') AS can_select,
       has_table_privilege(r, 'public.user_profiles', 'INSERT') AS can_insert,
       has_table_privilege(r, 'public.user_profiles', 'UPDATE') AS can_update,
       has_table_privilege(r, 'public.user_profiles', 'DELETE') AS can_delete
  FROM unnest(ARRAY['anon', 'authenticated']) AS r;

-- 6) Is the table exposed through PostgREST at all? (schemas the API serves)
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'authenticator';

-- 7) Triggers on the table (role-protection triggers would mitigate)
SELECT tgname, pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.user_profiles'::regclass AND NOT t.tgisinternal
 ORDER BY tgname;

-- 8) The signup trigger on auth.users (who becomes a profile, with which role)
SELECT tgname, pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
 WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
 ORDER BY tgname;

-- 9) Role counts (no names or emails)
SELECT role, is_active, count(*) FROM public.user_profiles GROUP BY role, is_active ORDER BY role, is_active;

-- Interpreting:
--   * rls_enabled = false AND authenticated can_update = true  -> EXPOSED: a signed-in
--     user can likely change their own role/is_active via PostgREST. Fix before any
--     role-based approval feature (proposed fix below; needs Ed's approval).
--   * rls_enabled = true with no permissive UPDATE policy for authenticated -> writes
--     blocked by RLS even though the grant exists (still tidy up the grant).
--   * authenticated can_update = false -> not exposed via grants.
--
-- PROPOSED FIX (NOT APPLIED; would be a numbered migration via the owner panel after
-- Ed reviews, and only after confirming no browser code reads user_profiles with the
-- user's token; the repo's public/ has no direct from('user_profiles') calls):
--   ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
--   REVOKE ALL ON user_profiles FROM PUBLIC, anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO service_role;
-- (handle_new_user is SECURITY DEFINER (039:57), so it runs as the function owner;
--  still re-check in rehearsal that signup creates the profile.)
