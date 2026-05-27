-- ============================================================================
-- 120_meeting_attendance_actor_attribution.sql
-- ----------------------------------------------------------------------------
-- Per-user audit attribution for annual-meeting check-ins. Until now the
-- meeting_attendance.checked_in_by_staff column was a free-text field — the
-- staff member typed their name at the check-in table. That worked when
-- everyone shared one staff password and we had no real user identity. With
-- Microsoft 365 OAuth now wired up (today's work) every check-in should be
-- FK-attributed to a specific user_profiles row, not a typed string.
--
-- Adds two FK columns:
--   acted_by_user_id           — who clicked the "check in" button on each row
--   walk_in_acted_by_user_id   — who later marked a walk-in ballot as entered
--
-- ON DELETE SET NULL so deleting a user doesn't void historical attendance.
-- The original free-text columns (checked_in_by_staff, walk_in_ballot_entered_by)
-- stay as display fallback for the quorum-evidence PDF and for legacy rows
-- written before this migration.
--
-- Record ownership: `mixed` — the check-in event is association_record
-- (attorney may need to verify quorum), the actor attribution is workpaper
-- (Bedrock IP for our audit trail).
--
-- Apply AFTER 119. Idempotent.
-- ============================================================================

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_attendance') THEN
    EXECUTE 'ALTER TABLE meeting_attendance
              ADD COLUMN IF NOT EXISTS acted_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
              ADD COLUMN IF NOT EXISTS walk_in_acted_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_meeting_attendance_acted_by
              ON meeting_attendance(acted_by_user_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_meeting_attendance_walk_in_acted_by
              ON meeting_attendance(walk_in_acted_by_user_id)
              WHERE walk_in_acted_by_user_id IS NOT NULL';
  END IF;
END $$;

COMMENT ON COLUMN meeting_attendance.acted_by_user_id IS
  'User who recorded this check-in, captured from the Supabase JWT at request time. The free-text checked_in_by_staff column is now a display fallback only — this FK is the canonical "who did it".';

COMMENT ON COLUMN meeting_attendance.walk_in_acted_by_user_id IS
  'User who marked the walk-in ballot as entered (a separate post-check-in action). Same per-user audit pattern.';

COMMIT;
