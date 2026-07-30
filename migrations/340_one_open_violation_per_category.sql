-- ============================================================================
-- 340_one_open_violation_per_category.sql  (Ed 2026-07-30)
-- ----------------------------------------------------------------------------
-- Make duplicate violations STRUCTURALLY IMPOSSIBLE. A property can have at most
-- ONE open violation of a given category at a time. The multi-finding photo AI
-- opened same-category duplicates because the inspection path inserts directly
-- and bypasses findOrContinueViolation; a prose rule ("always dedup") kept
-- failing, so this turns it into an enforced DB constraint (the "scar becomes a
-- check" rule). 201 same-category duplicates were voided before this so the
-- index builds cleanly.
--
-- "Open" = current_stage NOT IN the terminal states (cured/closed/voided) — the
-- same definition findOrContinueViolation uses. A cured/voided prior does not
-- block a fresh case, so the partial predicate excludes them.
--
-- The inspection insert now catches 23505 and continues the existing case
-- (api/inspections.js), so the constraint never crashes an inspection.
-- ============================================================================
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_violations_one_open_per_property_category
  ON violations (property_id, primary_category_id)
  WHERE current_stage NOT IN ('cured', 'closed', 'voided');

COMMIT;
