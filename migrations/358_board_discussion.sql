-- ============================================================================
-- 358_board_discussion.sql
-- ----------------------------------------------------------------------------
-- Board discussion (Ed 2026-08-09). A secure, in-platform place for a board to
-- talk — ask questions, deliberate, and keep the history — instead of scattering
-- it across personal email and text. Two kinds of thread:
--   - 'motion'  : anchored to a specific motion (discuss THIS vote in context)
--   - 'general' : one per community, a running board group thread
-- Visible to the community's active board members + the Bedrock manager, and to
-- admin (Ed) on any community.
--
-- Notifications are deliberately quiet: unread is tracked per reader
-- (board_thread_reads) so the portal can show unread badges with zero email
-- noise; a once-a-day digest (board_digest_sent throttle) is the only email.
--
-- Record ownership: association_record — board deliberation on association
-- business is the HOA's record (retained, handed over, minutes-adjacent).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS board_threads (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  uuid NOT NULL,
  community_id           uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kind                   text NOT NULL DEFAULT 'general'
                           CHECK (kind IN ('general', 'motion')),
  motion_id              uuid REFERENCES board_motions(id) ON DELETE CASCADE,
  title                  text,
  created_by             text,
  last_message_at        timestamptz,
  message_count          int NOT NULL DEFAULT 0,
  record_ownership       text NOT NULL DEFAULT 'association_record',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_threads_general
  ON board_threads(community_id) WHERE kind = 'general';
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_threads_motion
  ON board_threads(motion_id) WHERE kind = 'motion' AND motion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_board_threads_community
  ON board_threads(community_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS board_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         uuid NOT NULL REFERENCES board_threads(id) ON DELETE CASCADE,
  community_id      uuid NOT NULL,
  author_email      text NOT NULL,
  author_name       text,
  author_role       text NOT NULL DEFAULT 'board'
                      CHECK (author_role IN ('board', 'manager', 'admin')),
  body              text NOT NULL,
  record_ownership  text NOT NULL DEFAULT 'association_record',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_board_messages_thread
  ON board_messages(thread_id, created_at);

-- Per-reader read cursor → drives unread badges + the digest, with zero noise.
CREATE TABLE IF NOT EXISTS board_thread_reads (
  thread_id     uuid NOT NULL REFERENCES board_threads(id) ON DELETE CASCADE,
  reader_email  text NOT NULL,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, reader_email)
);

-- Throttle so a member gets at most one digest per window.
CREATE TABLE IF NOT EXISTS board_digest_sent (
  reader_email    text PRIMARY KEY,
  last_digest_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_board_threads_updated_at ON board_threads;
CREATE TRIGGER trg_board_threads_updated_at
  BEFORE UPDATE ON board_threads
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON board_threads       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON board_messages      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON board_thread_reads  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON board_digest_sent   TO service_role;
GRANT SELECT ON board_threads      TO authenticated;
GRANT SELECT ON board_messages     TO authenticated;

COMMIT;
