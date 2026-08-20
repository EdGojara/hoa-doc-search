-- ============================================================================
-- 373_ea_inbox_body_full.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- Tessa's own inbox kept only body_preview — 2,000 characters — and had no
-- column for the rest of the message at all.
--
-- She drafts a reply during the poll, while the full text is still in memory,
-- so her first draft is fine. Everything after that is not: Ed reopening the
-- item, asking her to redraft it, or asking her what someone said, all read the
-- stored row. A forwarded thread is routinely longer than 2,000 characters, and
-- the part that gets cut is the bottom — which on a forward is the original
-- message, the actual thing being asked about.
--
-- Same defect as email_messages.body_full, which was computed and never written
-- and left 980 of 1,053 stored messages bodyless. Found by auditing the class
-- rather than waiting for the second report.
--
-- Ed is relying on Tessa more from here, so what she stores has to be what
-- arrived.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

ALTER TABLE ea_inbox ADD COLUMN IF NOT EXISTS body_full TEXT;

COMMENT ON COLUMN ea_inbox.body_full IS
  'Whole message as readable text. body_preview is the first 2,000 characters '
  'for list rendering; anything reasoning about the message reads this.';

COMMIT;
