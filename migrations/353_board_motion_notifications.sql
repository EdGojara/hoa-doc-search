-- ============================================================================
-- 353_board_motion_notifications.sql
-- ----------------------------------------------------------------------------
-- Notification log for board motions (Ed 2026-08-09). Records every notice the
-- platform generates for a motion — "a vote is needed" when it opens, reminders
-- to members who haven't voted, and the result when it closes — so board
-- members are pulled to the portal instead of chasing email threads, and a
-- manager can see at a glance who was notified and who still owes a vote.
--
-- Sending is KILL-SWITCHED (env BOARD_NOTIFY_ENABLED). While off, rows are
-- logged with status='suppressed' so Ed can SEE exactly what would go out
-- before a single email reaches a real board member. Flip the switch to send.
--
-- Record ownership: workpaper — this is the platform's delivery log, internal
-- to how we run the board. The DECISION itself (board_motions) is the
-- association_record.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS board_motion_notifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  motion_id          uuid NOT NULL REFERENCES board_motions(id) ON DELETE CASCADE,
  community_id       uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  recipient_email    text NOT NULL,
  recipient_name     text,
  kind               text NOT NULL
                       CHECK (kind IN ('opened', 'reminder', 'result')),
  channel            text NOT NULL DEFAULT 'email'
                       CHECK (channel IN ('email', 'in_app')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'suppressed', 'failed')),
  subject            text,
  detail             text,                         -- error text or suppression reason
  vendor_message_id  text,
  sent_at            timestamptz,
  record_ownership   text NOT NULL DEFAULT 'workpaper',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_board_motion_notifs_motion
  ON board_motion_notifications(motion_id);
CREATE INDEX IF NOT EXISTS idx_board_motion_notifs_community
  ON board_motion_notifications(community_id, created_at DESC);
-- Dedup guard: at most one 'opened' / 'result' notice per member per motion
-- (reminders may repeat, so they are excluded from the unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_motion_notifs_once
  ON board_motion_notifications(motion_id, recipient_email, kind)
  WHERE kind IN ('opened', 'result');

GRANT SELECT, INSERT, UPDATE, DELETE ON board_motion_notifications TO service_role;
GRANT SELECT                          ON board_motion_notifications TO authenticated;

COMMIT;
