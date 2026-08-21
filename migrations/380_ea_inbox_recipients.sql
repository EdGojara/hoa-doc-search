-- ============================================================================
-- 380 — ea_inbox: keep the thread's other recipients, so a reply can reach them.
-- ----------------------------------------------------------------------------
-- Record ownership: workpaper. Tessa's queue is Ed's own correspondence
-- workspace, owner-only, and never surfaces in staff-visible Communications.
--
-- Ed 2026-08-21: "how do i know tessa is replying to all or just sender?"
--
-- He could not know, and the honest answer was worse than the question. In
-- api/tessa.js the reply handler reads:
--
--     const to = parseAddrs(b.to || item.from_email);
--     const cc = parseAddrs(b.cc);
--
-- So the reply goes to the SENDER ONLY. The screen shows a single unlabelled
-- address box, offers no CC field at all, and says nothing about who is left
-- out. Reply-all was not merely switched off — it was impossible, because the
-- thread's other recipients were never stored.
--
-- lib/ea/tessa_inbox.js already asks Graph for toRecipients and ccRecipients
-- (line 57) and builds both lists (118-119) to work out whether Ed was on the
-- To line or the Cc line. It then kept the one-word conclusion and discarded
-- the lists.
--
-- Why this matters beyond convenience: the Canyon Gate thread went to five
-- board aliases plus Martha plus Ed. Answering only director@ means four
-- directors and the manager never see the answer, and the board's own record of
-- the exchange (the whole reason that community uses role aliases — see
-- project_canyon_gate_role_aliases) has a hole in it. On a board matter that is
-- a governance problem, not a UX one.
--
-- Backfill is deliberately NOT attempted. The lists are only available from
-- Graph at poll time, and re-fetching every historical message to reconstruct
-- them would be a large read for messages already handled. Existing rows keep
-- NULL, and the UI treats NULL as "unknown — reply to sender only, and say so".
-- ============================================================================
BEGIN;

ALTER TABLE ea_inbox
  ADD COLUMN IF NOT EXISTS to_recipients TEXT[],
  ADD COLUMN IF NOT EXISTS cc_recipients TEXT[];

COMMENT ON COLUMN ea_inbox.to_recipients IS
  'Everyone on the original To line, lowercased. NULL for rows polled before migration 380 — treat NULL as unknown, not as empty.';
COMMENT ON COLUMN ea_inbox.cc_recipients IS
  'Everyone on the original Cc line, lowercased. NULL for rows polled before migration 380.';

GRANT SELECT, INSERT, UPDATE, DELETE ON ea_inbox TO service_role;

COMMIT;
