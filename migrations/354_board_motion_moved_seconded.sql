-- ============================================================================
-- 354_board_motion_moved_seconded.sql
-- ----------------------------------------------------------------------------
-- Manager-keys-it-up, board-member-moves-it (Ed 2026-08-09). Historically the
-- community manager runs the board process, but a motion is formally a
-- director's action. This adds the parliamentary step: the manager drafts a
-- motion in a 'proposed' state, a board member MOVES it (and optionally a
-- second seconds it), and only then does it open for voting. The manager can
-- record who moved/seconded on their behalf (same pattern as recording votes),
-- or a logged-in director can move it themselves.
--
-- So the minutes read correctly: "Moved by Director Geissler, seconded by
-- Director Smith, carried 4 to 1."
-- ============================================================================
BEGIN;

ALTER TABLE board_motions
  ADD COLUMN IF NOT EXISTS moved_by_email        text,
  ADD COLUMN IF NOT EXISTS moved_by_name         text,
  ADD COLUMN IF NOT EXISTS moved_at              timestamptz,
  ADD COLUMN IF NOT EXISTS moved_recorded_by     text,   -- staff email if recorded on behalf
  ADD COLUMN IF NOT EXISTS seconded_by_email     text,
  ADD COLUMN IF NOT EXISTS seconded_by_name      text,
  ADD COLUMN IF NOT EXISTS seconded_at           timestamptz,
  ADD COLUMN IF NOT EXISTS requested_mover_email text,   -- the director the manager asked to move it
  ADD COLUMN IF NOT EXISTS requested_mover_name  text;

-- Add the 'proposed' lifecycle state (keyed up, awaiting a board member to move
-- it) ahead of 'open'. DROP + re-ADD because CHECK lists are immutable in place.
ALTER TABLE board_motions DROP CONSTRAINT IF EXISTS board_motions_status_check;
ALTER TABLE board_motions ADD CONSTRAINT board_motions_status_check
  CHECK (status IN ('proposed', 'open', 'passed', 'failed', 'withdrawn', 'tabled'));

-- New notification kind: 'to_move' — asking a specific director to move a motion.
ALTER TABLE board_motion_notifications DROP CONSTRAINT IF EXISTS board_motion_notifications_kind_check;
ALTER TABLE board_motion_notifications ADD CONSTRAINT board_motion_notifications_kind_check
  CHECK (kind IN ('opened', 'reminder', 'result', 'to_move'));

COMMIT;
