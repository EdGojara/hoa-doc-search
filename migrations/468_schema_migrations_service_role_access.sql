-- ============================================================================
-- 468_schema_migrations_service_role_access.sql  (Ed 2026-09-26)
-- ----------------------------------------------------------------------------
-- RECORD OWNERSHIP: workpaper (platform metadata).
--
-- WHY: migrations are applied one at a time in the Supabase SQL editor, which
-- never writes schema_migrations. The table was created by the in-app runner
-- over DATABASE_URL and never granted to service_role, so nothing but that
-- runner could read or write it. Result: every editor-applied migration looked
-- "pending" forever, and the runner's one-click apply would have re-run them
-- all (disabled 2026-09-26).
--
-- CHANGE: let service_role read and record rows, so
-- scripts/record_applied_migration.js can record a migration right after it is
-- applied, and status checks can read the tracker. No other table is touched;
-- anon/authenticated get nothing.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        TEXT NOT NULL UNIQUE,
  sha256          TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by      TEXT,
  duration_ms     INTEGER,
  error           TEXT
);

GRANT SELECT, INSERT, UPDATE ON schema_migrations TO service_role;
REVOKE ALL ON schema_migrations FROM anon, authenticated;

COMMIT;
