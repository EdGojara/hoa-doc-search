-- ============================================================================
-- 546_inspection_closeout_stages.sql  (Ed 2026-10-24)
-- ----------------------------------------------------------------------------
-- Three inspection stages, mapped onto the EXISTING inspections.status values
-- (no new status, no parallel state machine):
--
--   1. In Progress           status in_progress / paused (unchanged). Also any
--                            tracked drive whose completed_at is still empty,
--                            e.g. one the stale-drive job auto-ended to
--                            'captured' because the tablet closed.
--   2. Inspection Completed  the inspector explicitly closes the drive:
--                            completed_at + completed_by_user_id are recorded
--                            with the counts below; status becomes 'captured'.
--   3. Review Completed      staff finished approving or dismissing every
--                            observation: review_completed_at +
--                            review_completed_by_user_id; status becomes
--                            'closed' (the existing "Completed" state).
--
-- Completing either stage changes NO violation, letter or observation. Letters
-- keep moving through the existing Drafts -> Mail Queue flow.
--
-- closeout_tracked: existing rows get FALSE (they predate stage tracking, so
-- reminders and the staff queue never pick up 165 historical drives); the API
-- sets TRUE on every drive started or resumed from now on. No UPDATE runs.
--
-- inspection_closeout_notices: one row per drive, per kind, per Central day.
-- The UNIQUE key is the idempotency guard for the 5 PM inspector reminder and
-- the 8 AM Amanda flag (a second scheduler fire the same day inserts nothing).
-- Every row records who it went to, the channel and the outcome.
--
-- Record ownership: inspections columns follow the inspection (association
-- record of the walkthrough). inspection_closeout_notices is a workpaper
-- (internal staff reminders, never sent to homeowners).
-- ============================================================================
BEGIN;

ALTER TABLE inspections ADD COLUMN IF NOT EXISTS closeout_tracked boolean NOT NULL DEFAULT false;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS started_by_user_id uuid;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS completed_by_user_id uuid;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS completed_by_name text;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS inspected_property_count integer;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS violations_identified integer;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS skipped_property_count integer;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS skipped_properties jsonb;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS closeout_summary jsonb;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_completed_at timestamptz;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_completed_by_user_id uuid;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_completed_by_name text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspections_closeout_counts_check') THEN
    ALTER TABLE inspections ADD CONSTRAINT inspections_closeout_counts_check CHECK (
      (inspected_property_count IS NULL OR inspected_property_count >= 0)
      AND (violations_identified IS NULL OR violations_identified >= 0)
      AND (skipped_property_count IS NULL OR skipped_property_count >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspections_completed_actor_check') THEN
    ALTER TABLE inspections ADD CONSTRAINT inspections_completed_actor_check CHECK (
      (completed_at IS NULL) = (completed_by_user_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspections_review_actor_check') THEN
    ALTER TABLE inspections ADD CONSTRAINT inspections_review_actor_check CHECK (
      (review_completed_at IS NULL) = (review_completed_by_user_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspections_skipped_array_check') THEN
    ALTER TABLE inspections ADD CONSTRAINT inspections_skipped_array_check CHECK (
      skipped_properties IS NULL OR jsonb_typeof(skipped_properties) = 'array');
  END IF;
END $$;

-- Hot path for the reminders and the staff queue: tracked drives not yet
-- review-complete.
CREATE INDEX IF NOT EXISTS idx_inspections_closeout_open
  ON inspections (started_at)
  WHERE closeout_tracked AND status NOT IN ('closed', 'voided');

CREATE TABLE IF NOT EXISTS inspection_closeout_notices (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  inspection_id  uuid NOT NULL,
  community_id   uuid,
  kind           text NOT NULL,
  notice_date    date NOT NULL,
  recipient      text,
  channel        text NOT NULL,
  outcome        text NOT NULL DEFAULT 'pending',
  detail         jsonb,
  work_item_id   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  CONSTRAINT inspection_closeout_notices_pkey PRIMARY KEY (id),
  CONSTRAINT inspection_closeout_notices_inspection_fkey FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE,
  CONSTRAINT inspection_closeout_notices_community_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL,
  CONSTRAINT inspection_closeout_notices_kind_check CHECK (kind IN ('inspector_reminder', 'management_flag')),
  CONSTRAINT inspection_closeout_notices_channel_check CHECK (channel IN ('staff_email', 'work_item')),
  CONSTRAINT inspection_closeout_notices_outcome_check CHECK (outcome IN ('pending', 'sent', 'skipped', 'failed')),
  CONSTRAINT inspection_closeout_notices_once_per_day UNIQUE (inspection_id, kind, notice_date)
);

CREATE INDEX IF NOT EXISTS idx_closeout_notices_date
  ON inspection_closeout_notices (notice_date, kind);

GRANT SELECT, INSERT, UPDATE ON inspection_closeout_notices TO service_role;

COMMENT ON TABLE inspection_closeout_notices IS
  'workpaper: one internal reminder/flag per inspection, per kind, per Central day (migration 546). Staff only, never homeowners.';
COMMENT ON COLUMN inspections.closeout_tracked IS
  'TRUE for drives started or resumed after migration 546; only these get closeout reminders and appear in the staff closeout queue.';

COMMIT;
