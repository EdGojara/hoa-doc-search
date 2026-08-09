-- ============================================================================
-- 357_board_vote_inbox_seen.sql
-- ----------------------------------------------------------------------------
-- Dedup log for the reply-to-vote inbox reader (Ed 2026-08-09). Lets the poller
-- work with ONLY Mail.Read on vote@ — it tracks which Graph messages it has
-- already processed here instead of marking them read (which would need the
-- broader Mail.ReadWrite). Same approach as tessa_inbox dedups on ea_inbox.
--
-- Record ownership: workpaper — internal delivery/processing log.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS board_vote_inbox_seen (
  graph_id      text PRIMARY KEY,
  from_email    text,
  outcome       text,                 -- recorded | unclear | ambiguous | ignored | error
  processed_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON board_vote_inbox_seen TO service_role;

COMMIT;
