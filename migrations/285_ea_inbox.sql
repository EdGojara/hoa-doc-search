-- ============================================================================
-- 285_ea_inbox.sql  (Ed 2026-07-11)
-- ----------------------------------------------------------------------------
-- Tessa's review queue: emails Ed forwards / BCCs to her shared mailbox
-- (tessa@) that she has drafted a reply for. Ed reviews the draft, edits, and
-- sends (as Ed or as Tessa). Owner-only (Ed); workpaper.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ea_inbox (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id   UUID,                      -- the incoming email_messages row, if linked
  graph_id           TEXT,                      -- Graph message id (dedup across polls)
  from_email         TEXT,
  from_name          TEXT,
  subject            TEXT,
  body_preview       TEXT,
  received_at        TIMESTAMPTZ,
  draft_subject      TEXT,
  draft_body         TEXT,
  draft_mode         TEXT NOT NULL DEFAULT 'ed' CHECK (draft_mode IN ('ed', 'tessa')),
  status             TEXT NOT NULL DEFAULT 'needs_review'
                     CHECK (status IN ('needs_review', 'replied', 'dismissed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ea_inbox_graph ON ea_inbox (graph_id) WHERE graph_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ea_inbox_status ON ea_inbox (status, received_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON ea_inbox TO service_role;
GRANT SELECT                          ON ea_inbox TO authenticated;

COMMIT;
