-- ============================================================================
-- 356_board_motion_ref_code.sql
-- ----------------------------------------------------------------------------
-- Deterministic reply matching (Ed 2026-08-09). Each motion gets a short human
-- reference code (e.g. "WAT-3F9A") stamped into the vote email's subject
-- "[WAT-3F9A]". A reply keeps the subject, so reply-to-vote can match to the
-- EXACT motion with zero inference, even for a director who sits on two boards
-- with two motions open at once. Same idea as the case ref on violation letters.
-- ============================================================================
BEGIN;

ALTER TABLE board_motions
  ADD COLUMN IF NOT EXISTS ref_code text;

CREATE INDEX IF NOT EXISTS idx_board_motions_ref_code
  ON board_motions(ref_code) WHERE ref_code IS NOT NULL;

COMMIT;
