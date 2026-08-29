-- ============================================================================
-- 397_shadow_grading_columns.sql  (Ed 2026-08-29)
-- ----------------------------------------------------------------------------
-- Follow-up to 396. The benchmark for shadow mode is ED, not the staff: a
-- persona earns its go-live by meeting Ed's bar, never by matching what a
-- staffer happened to send. This adds the grading signal Ed applies by hand in
-- /admin/shadow, and replaces the placeholder human_action/agreement columns
-- (staff-agreement framing, never used) with the real ones.
--
-- Split from 396 on purpose: 396 was already applied, and applied migrations are
-- immutable. Every statement here is idempotent, so it is safe whether or not
-- 396 shipped with these columns.
-- ============================================================================
BEGIN;

-- The grading signal (Ed's judgment). ed_rewrite is the highest-fidelity
-- encode-Ed data: Ed's own version of the reply on real mail, the DNA a persona
-- should learn from.
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS ed_rating   text;
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS ed_note     text;
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS ed_rewrite  text;
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS ed_rated_at timestamptz;
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS ed_rated_by text;

-- Constrain ed_rating to the two verdicts (guard against a re-run adding it twice).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'shadow_drafts' AND constraint_name = 'shadow_drafts_ed_rating_check'
  ) THEN
    ALTER TABLE shadow_drafts
      ADD CONSTRAINT shadow_drafts_ed_rating_check CHECK (ed_rating IN ('meets_bar','needs_work'));
  END IF;
END $$;

-- Contrast only, never the benchmark: what the staff actually sent on the thread,
-- snapshotted at grade time so the graded record is self-contained.
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS staff_reply_text text;
ALTER TABLE shadow_drafts ADD COLUMN IF NOT EXISTS staff_reply_at   timestamptz;

-- Retire the unused staff-agreement placeholders from 396 (no data written).
ALTER TABLE shadow_drafts DROP COLUMN IF EXISTS human_action;
ALTER TABLE shadow_drafts DROP COLUMN IF EXISTS agreement;

-- Grading-queue indexes.
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_ungraded ON shadow_drafts (created_at DESC) WHERE ed_rating IS NULL;
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_rating   ON shadow_drafts (persona, ed_rating);

COMMIT;
