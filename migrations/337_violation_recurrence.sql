-- ============================================================================
-- 337_violation_recurrence.sql  (Ed 2026-07-25)
-- ----------------------------------------------------------------------------
-- Track when a violation was opened as a RECURRENCE of a recently-cured one.
--
-- Pairs with migration 336 (enforcement_categories.recurrence_escalates) and the
-- 6-month detection in lib/enforcement/find_or_continue_violation.js. When a
-- movable/concealable violation (trailer, RV, stored items) reappears within the
-- Tex. Prop. Code §209.006(d) 6-month window after being cured, we open the new
-- case straight at certified §209 (skipping the courtesy — every community sends
-- certifieds; only Lakes of Pine Forest fines, so the recurrence path never
-- auto-fines). These columns record that lineage for the audit trail + the
-- repeat notice, which must reference the prior violation to be defensible.
--
-- Operators can always move a violation up or down in severity manually
-- (PATCH /api/enforcement/violations/:id/restage) — recurrence just sets the
-- starting point.
-- Record ownership: association_record (enforcement record).
-- ============================================================================
BEGIN;

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS is_recurrence            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recurrence_of_violation_id UUID REFERENCES violations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_violations_recurrence_of
  ON violations (recurrence_of_violation_id) WHERE recurrence_of_violation_id IS NOT NULL;

COMMENT ON COLUMN violations.is_recurrence IS
  'Opened as a within-6-month repeat of a cured movable violation (Tex. Prop. Code 209.006(d)); started at certified §209 rather than courtesy.';

COMMIT;
