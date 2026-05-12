-- ============================================================================
-- 029_grant_table_permissions.sql
-- ----------------------------------------------------------------------------
-- Sibling to migration 028. Tables created via raw SQL outside of Supabase's
-- studio UI don't inherit the auto-grants that Supabase applies, so new
-- tables I introduced (arc_historical_decisions confirmed; others probably
-- too) reject reads/writes with:
--   permission denied for table <name>
--
-- This grants full CRUD to anon, authenticated, and service_role on every
-- table created in migrations 023–027. Idempotent and safe to re-run.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t TEXT;
  tables_to_grant TEXT[] := ARRAY[
    -- Migration 023
    'community_facts',
    -- Migration 024
    'events',
    'event_vendors',
    'event_signatures',
    -- Migration 025
    'email_intake',
    'community_decisions',
    'community_recaps',
    -- Migration 026
    'community_homeowners',
    -- Migration 027
    'arc_historical_decisions'
  ];
BEGIN
  FOREACH t IN ARRAY tables_to_grant
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = t AND schemaname = 'public') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO anon, authenticated, service_role', t);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role');
    END IF;
  END LOOP;
END $$;

-- Belt-and-suspenders: also grant on all RPCs we created in those migrations
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'match_arc_decisions') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_arc_decisions(vector, uuid, int, float) TO anon, authenticated, service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'match_community_facts') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_community_facts(vector, uuid, int, float) TO anon, authenticated, service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'match_email_intakes') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION match_email_intakes(vector, uuid, int, float) TO anon, authenticated, service_role';
  END IF;
END $$;

COMMIT;

-- Verify (run after this migration):
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_name IN (
--     'community_facts','events','event_vendors','event_signatures',
--     'email_intake','community_decisions','community_recaps',
--     'community_homeowners','arc_historical_decisions'
--   )
--   AND grantee IN ('anon','authenticated','service_role')
--   ORDER BY table_name, grantee, privilege_type;
