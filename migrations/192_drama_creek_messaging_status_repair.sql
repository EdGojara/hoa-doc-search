-- ============================================================================
-- 192_drama_creek_messaging_status_repair.sql
-- ----------------------------------------------------------------------------
-- Migration 191 successfully inserted 5 threads + their messages, but the
-- trg_msg_thread_sync trigger (from migration 161) auto-recomputed
-- next_action_status on every message insert. As a result:
--
--   Sarah Welcome's thread was set to 'closed' in the INSERT, but the
--   4 follow-on messages walked it back to 'awaiting_homeowner' (and
--   wiped closed_at + flipped closed_reason to 'reopened').
--
--   Patricia Newpaint's thread was set to 'closure_pending', but the
--   trigger flipped it to awaiting_staff_followup → awaiting_homeowner
--   as the messages went back and forth, and wiped closure_proposed_at.
--
--   Marcus, Jennifer, Greg all landed correctly because their final
--   state matches what the trigger would compute anyway.
--
-- The fix: UPDATE the two affected threads to their intended terminal
-- state AFTER all messages are in place. The trigger only fires on
-- message INSERT — direct thread UPDATEs aren't second-guessed.
-- ============================================================================

BEGIN;

-- Sarah Welcome — restore closed state
UPDATE homeowner_threads
SET next_action_status = 'closed',
    closed_at = NOW() - INTERVAL '7 days',
    closed_reason = 'homeowner_agreed',
    closure_proposed_at = NOW() - INTERVAL '8 days' + INTERVAL '4 hours'
WHERE id = 'dc190002-0000-4000-a000-000000000000';

-- Patricia Newpaint — restore closure_pending state
UPDATE homeowner_threads
SET next_action_status = 'closure_pending',
    closure_proposed_at = NOW() - INTERVAL '12 hours'
WHERE id = 'dc190004-0000-4000-a000-000000000000';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--   SELECT next_action_status, count(*)
--   FROM homeowner_threads
--   WHERE community_id = 'dc100000-0000-4000-a000-000000000000'
--   GROUP BY next_action_status;
--   -- Expected (5 rows):
--   --   awaiting_homeowner       1 (Marcus)
--   --   awaiting_staff_followup  1 (Jennifer)
--   --   closed                   1 (Sarah)
--   --   closure_pending          1 (Patricia)
--   --   escalated_to_attorney    1 (Greg)
-- ============================================================================
