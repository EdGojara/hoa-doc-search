-- ============================================================================
-- 355_board_vote_source.sql
-- ----------------------------------------------------------------------------
-- Email voting (Ed 2026-08-09). Board members can now vote either by logging
-- into the portal OR by clicking a signed ballot link in the "vote needed"
-- email (no login). This column records HOW each vote arrived so the ballot's
-- provenance is on the record:
--   portal          — cast in the board portal while signed in
--   email           — cast from the signed email ballot link
--   staff_recorded  — a manager recorded it on the member's behalf
-- ============================================================================
BEGIN;

ALTER TABLE board_motion_votes
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'portal'
    CHECK (source IN ('portal', 'email', 'staff_recorded'));

COMMIT;
