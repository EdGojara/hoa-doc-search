-- ============================================================================
-- 028_grant_view_permissions.sql
-- ----------------------------------------------------------------------------
-- Postgres views need explicit SELECT grants even when the role normally has
-- access to the underlying tables. Migrations 023, 024, 026, 027 each
-- introduced views (v_community_facts, v_event_costs, v_event_attendance,
-- v_arc_history_summary) without GRANT statements, so the app's Supabase
-- service role couldn't read them — manifesting as
--   "permission denied for view v_community_facts"
-- in the Profile tab.
--
-- This migration grants SELECT to anon, authenticated, and service_role on
-- every view we've defined so far. Safe to re-run.
-- ============================================================================

BEGIN;

-- Idempotent guard: each GRANT below is wrapped in a DO block that only
-- fires if the view actually exists. Lets you run this even on a database
-- where some of the prior migrations haven't been applied yet.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_community_facts') THEN
    EXECUTE 'GRANT SELECT ON v_community_facts TO anon, authenticated, service_role';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_event_costs') THEN
    EXECUTE 'GRANT SELECT ON v_event_costs TO anon, authenticated, service_role';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_event_attendance') THEN
    EXECUTE 'GRANT SELECT ON v_event_attendance TO anon, authenticated, service_role';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_arc_history_summary') THEN
    EXECUTE 'GRANT SELECT ON v_arc_history_summary TO anon, authenticated, service_role';
  END IF;
END $$;

-- Older view from migration 018 — if it exists and lacks grants, fix that too
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_community_document_matrix') THEN
    EXECUTE 'GRANT SELECT ON v_community_document_matrix TO anon, authenticated, service_role';
  END IF;
END $$;

COMMIT;

-- Verify (run after this migration):
--   SELECT table_name, privilege_type, grantee
--   FROM information_schema.role_table_grants
--   WHERE table_name LIKE 'v\_%' ESCAPE '\'
--     AND grantee IN ('anon','authenticated','service_role')
--   ORDER BY table_name, grantee;
