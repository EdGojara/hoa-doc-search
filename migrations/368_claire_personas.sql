-- ============================================================================
-- 368_claire_personas.sql  (Ed 2026-08-16)
-- ----------------------------------------------------------------------------
-- MULTIPLE FACES. A visit is no longer "talking to Claire", it is talking to
-- whichever teammate the question belongs to. Claire is the front office and the
-- default door; when the question turns out to be architectural, or a resale, or
-- an accounting action, she names the specialist and hands over, and that
-- teammate's own face and voice take the screen.
--
-- Two columns, and the reason each one is on a ROW rather than in the client:
--
--   claire_sessions.active_persona — the server decides who is on screen. If the
--     browser held that state, a reconnect would reopen the wrong face mid
--     conversation, and the metered avatar session would be minted for whoever
--     the client claimed to be.
--
--   claire_session_turns.persona — who actually said each line. Without it the
--     transcript reads as one voice, and "which of your people told my client
--     that" becomes unanswerable. On a surface where several named characters
--     speak on behalf of the association, attribution is the record.
--
-- The roster itself is code, not data (lib/team/roster.js) — one place to add a
-- teammate, so the email board, the hand-off card, the prompt roster and the
-- faces cannot drift apart again. These columns only record WHO SPOKE.
-- ============================================================================
BEGIN;

ALTER TABLE claire_sessions
  ADD COLUMN IF NOT EXISTS active_persona TEXT NOT NULL DEFAULT 'claire';

ALTER TABLE claire_session_turns
  ADD COLUMN IF NOT EXISTS persona TEXT;

-- Deliberately NO CHECK constraint on either column. The roster lives in code
-- and gains teammates as they ship; a constraint here would mean a migration
-- every time someone joins, and the failure mode is the silent-insert-rejection
-- scar (a save that fails without surfacing). The roster module is the
-- validator, and tests/test_team_roster.js is what keeps it honest.
CREATE INDEX IF NOT EXISTS idx_claire_turns_persona ON claire_session_turns(persona);

COMMIT;
