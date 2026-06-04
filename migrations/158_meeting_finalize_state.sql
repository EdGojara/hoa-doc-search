-- 158_meeting_finalize_state.sql
--
-- Adds finalize-state tracking to meeting_election_settings so the
-- portfolio meetings view (Ed 2026-06-04) can render per-election status
-- badges (SCHEDULED / LIVE / OVERDUE / FINALIZED) and the End Meeting
-- action can mark an election as done.
--
-- Columns:
--   status              — explicit lifecycle state. Defaults to 'scheduled'.
--                         Set to 'finalized' by the generate-pdf endpoint
--                         after the quorum-evidence PDF is successfully
--                         archived to the community library.
--   finalized_at        — timestamptz captured at the same moment.
--   finalize_quorum_met — boolean snapshot of whether quorum was met at
--                         the moment of finalization (frozen value — the
--                         live attendance/quorum query can keep changing
--                         after finalize, but the certified result here
--                         is locked).
--   finalize_present_units, finalize_attended_count — snapshot values
--                         from the quorum calculation at finalize time.
--                         Lets the portfolio card show "✓ 187/451 quorum
--                         met" without having to re-query bedrock-vote
--                         for the historical totals.
--
-- Idempotent via ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE meeting_election_settings
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalize_quorum_met boolean,
  ADD COLUMN IF NOT EXISTS finalize_present_units int,
  ADD COLUMN IF NOT EXISTS finalize_attended_count int;

-- Add the CHECK constraint separately so it doesn't fail re-run when the
-- column already exists with a constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'meeting_election_settings_status_check'
  ) THEN
    ALTER TABLE meeting_election_settings
      ADD CONSTRAINT meeting_election_settings_status_check
      CHECK (status IN ('scheduled', 'live', 'finalized'));
  END IF;
END $$;

-- Backfill: any existing rows get default 'scheduled' from the column
-- default, but be explicit so the data is unambiguous post-migration.
UPDATE meeting_election_settings SET status = 'scheduled' WHERE status IS NULL;

COMMIT;
