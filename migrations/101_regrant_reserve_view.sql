-- ============================================================================
-- 101_regrant_reserve_view.sql
-- ----------------------------------------------------------------------------
-- Migration 100 used DROP VIEW + CREATE VIEW to update the view's column list.
-- DROP loses the GRANT SELECT permissions that were attached to the original
-- view (migration 088). Without those grants, the service_role / authenticated
-- roles get permission-denied on SELECT, and the API silently returns empty
-- components arrays.
--
-- Re-grants. Also makes the grants part of the standing setup so future
-- DROP+CREATE migrations remember to include them.
--
-- Lesson logged in CLAUDE.md: when DROP+CREATE on a view, re-issue any
-- GRANT statements that were attached to the original.
--
-- Apply after 100. Idempotent (GRANT is idempotent in Postgres).
-- ============================================================================

BEGIN;

GRANT SELECT ON v_reserve_components_with_totals
  TO anon, authenticated, service_role;

-- Defensive: re-grant on the related view too in case any DROP CASCADE
-- ripped through it (the summary view shouldn't depend on the components
-- view, but belt-and-suspenders).
GRANT SELECT ON v_reserve_community_summary
  TO anon, authenticated, service_role;

GRANT SELECT ON v_reserve_funding_actuals
  TO anon, authenticated, service_role;

COMMIT;
