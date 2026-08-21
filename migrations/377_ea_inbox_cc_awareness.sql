-- ============================================================================
-- 377_ea_inbox_cc_awareness.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- Being copied is not being asked.
--
-- Ed: "im going to copy tessa on these because i want my EA to be involved in
-- what i do" — the emails in question being a personnel matter with a staff
-- member.
--
-- Tessa's poll drafts a reply to every new message in her mailbox, and until
-- now she could not tell she had been CC'd rather than written to: the Graph
-- query did not even fetch the recipient list. So copying her on a performance
-- conversation would have produced a drafted reply to that employee sitting in
-- the queue. Backwards from what being copied means.
--
--   addressed TO her   she is being asked to do something  -> draft a reply
--   CC'd or BCC'd      she is being kept in the loop       -> file it, no draft
--
-- This is the whole point of copying an assistant: they know what is going on
-- without acting on it. An EA who answered every email their principal copied
-- them on would be a liability.
--
-- These messages still land in ea_inbox, which is owner-gated and deliberately
-- excluded from the staff-visible Communications pipeline, so a personnel
-- thread stays as private as Ed's own mailbox.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

-- How the message reached her. 'to' = asked, 'cc' = kept informed.
ALTER TABLE ea_inbox ADD COLUMN IF NOT EXISTS addressed_as TEXT NOT NULL DEFAULT 'to';

ALTER TABLE ea_inbox DROP CONSTRAINT IF EXISTS ea_inbox_addressed_as_check;
ALTER TABLE ea_inbox ADD CONSTRAINT ea_inbox_addressed_as_check
  CHECK (addressed_as IN ('to', 'cc', 'bcc'));

COMMENT ON COLUMN ea_inbox.addressed_as IS
  'How Tessa received it. "to" means she was asked and a reply is drafted; '
  '"cc"/"bcc" means she was kept informed and nothing is drafted.';

-- The awareness queue is read as "what has Ed been doing", so it is read by
-- recency within a kind.
CREATE INDEX IF NOT EXISTS idx_ea_inbox_addressed
  ON ea_inbox (addressed_as, received_at DESC);

COMMIT;
