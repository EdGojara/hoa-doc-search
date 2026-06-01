-- ============================================================================
-- 142_nomination_voting_cutoff.sql
-- ----------------------------------------------------------------------------
-- Adds voting_cutoff_at + voting_cutoff_time to nomination_cycles. The
-- nomination cycle previously conflated three different deadlines:
--
--   1. nominations_close_at   — when the public form stops accepting nominations
--   2. annual_meeting_date    — when the meeting itself happens
--   3. voting cutoff          — when mail/email/drop-off/online ballots must
--                               be received by (typically meeting_date − 5 days)
--
-- Without column #3, the renderer was auto-deriving the voting cutoff from
-- nominations_close_at, which is wrong — those deadlines serve different
-- purposes and live in different parts of the cycle. Canyon Gate's 2026
-- packet (Ed's reference) explicitly cites "Friday, May 22, 2026 at 4:00 PM"
-- as the voting deadline for a May 27 meeting — a 5-day buffer, not the
-- nominations close date which was weeks earlier.
--
-- Ed's UX framing: "meeting and nominations are different — need separate
-- dates for meeting completely separate from call for nominations." This
-- migration enables that separation at the data layer.
--
-- Apply after 141. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS voting_cutoff_at    DATE,
  ADD COLUMN IF NOT EXISTS voting_cutoff_time  TEXT;

COMMENT ON COLUMN nomination_cycles.voting_cutoff_at IS
  'Deadline (DATE) for mail/email/drop-off/online ballots to be received. Distinct from nominations_close_at (which is when the nomination form closes). Typically meeting_date - 5 days.';

COMMENT ON COLUMN nomination_cycles.voting_cutoff_time IS
  'Time-of-day for the voting cutoff (e.g., "4:00 PM"). Free-text so renderers can preserve the operator''s phrasing.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT id, community_name, annual_meeting_date, nominations_close_at,
--        voting_cutoff_at, voting_cutoff_time
-- FROM nomination_cycles
-- WHERE status IN ('open', 'closed', 'finalized')
-- ORDER BY annual_meeting_date DESC;
