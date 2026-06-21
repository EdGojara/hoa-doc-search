-- ============================================================================
-- 238_budget_tables_grants.sql
-- ----------------------------------------------------------------------------
-- Migration 171 created community_budgets + budget_line_items but never granted
-- them to service_role (only the v_current_budgets view got a grant). The
-- Node.js API uses the service role for all writes/reads, so every budget query
-- failed with "permission denied for table community_budgets" — the budget
-- list, upload, and save have silently never worked. Surfaced 2026-06-20 when
-- the Budget view was consolidated into the Accounting page.
--
-- This is the recurring "new tables without service_role GRANTs are silently
-- unwritable" scar (see CLAUDE.md). Grant both budget tables explicitly.
--
-- Record ownership: association_record (the HOA's approved budget is theirs).
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON community_budgets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_line_items TO service_role;
GRANT SELECT ON community_budgets TO authenticated;
GRANT SELECT ON budget_line_items TO authenticated;

COMMIT;
