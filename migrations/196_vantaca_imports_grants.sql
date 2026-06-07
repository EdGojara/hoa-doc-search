-- ============================================================================
-- 196_vantaca_imports_grants.sql
-- ----------------------------------------------------------------------------
-- Migration 168 created the vantaca_imports table but forgot to GRANT
-- access to service_role. The Node.js API uses the service_role key,
-- so upload attempts fail with:
--   "permission denied for table vantaca_imports"
--
-- Caught by Ed 2026-06-08 in the Vantaca import drop-zone UI. Same family
-- as the existing CLAUDE.md scar ("DROP VIEW loses GRANTs — must re-issue").
-- Idempotent — safe to re-run.
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON vantaca_imports TO service_role;

-- Also grant authenticated for any future client-side reads we may want to
-- enable (matches the pattern other tables in the codebase use).
GRANT SELECT ON vantaca_imports TO authenticated;

COMMIT;
