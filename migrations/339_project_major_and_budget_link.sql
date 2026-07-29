-- ============================================================================
-- 339_project_major_and_budget_link.sql  (Ed 2026-07-29)
-- ----------------------------------------------------------------------------
-- Operations board = how we monitor the year's projects against reserves and
-- the operating budget, and make sure every MAJOR project is on the books.
-- Two additive columns on the existing vendor_projects spine (no new silo):
--
--   is_major          — flags the projects the board cares about at a glance;
--                       the annual view highlights these and staff can audit
--                       "is every major project for the year tracked here?"
--   budget_account_id — for operating-funded projects, the operating budget
--                       line (chart_of_accounts) this project draws against.
--                       Reserve-funded projects already link via
--                       reserve_component_id. This closes the operating side so
--                       the rollup can show budget-vs-committed-vs-actual per
--                       line. ON DELETE SET NULL: losing an account never
--                       deletes the project record (association_record).
--
-- vendor_projects already carries table-level GRANTs (migration 321); new
-- columns inherit them, so no GRANT needed here.
-- ============================================================================
BEGIN;

ALTER TABLE vendor_projects
  ADD COLUMN IF NOT EXISTS is_major boolean NOT NULL DEFAULT false;

ALTER TABLE vendor_projects
  ADD COLUMN IF NOT EXISTS budget_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_projects_budget_account
  ON vendor_projects(budget_account_id) WHERE budget_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_projects_major
  ON vendor_projects(community_id) WHERE is_major = true;

COMMIT;
