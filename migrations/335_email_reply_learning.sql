-- ============================================================================
-- 335_email_reply_learning.sql  (Ed 2026-07-25)
-- ----------------------------------------------------------------------------
-- Encode-Ed for Claire's email replies. Today every draft is generated fresh
-- from docs + account data, and when Ed edits a draft before sending, the edit
-- is THROWN AWAY — the platform never sees "Claire drafted X, Ed sent Y." That
-- edit is the single most valuable training signal we have (the single-teacher
-- thesis: only Ed's edits encode), and we were discarding all of it.
--
-- This table captures, on every send, Claire's ORIGINAL draft alongside the
-- FINAL sent text + an edit distance. The drafter then feeds a few of the most
-- relevant past Ed-edits back in as few-shot examples, so Claire's drafts drift
-- toward how Ed actually answers. Edit-rate over time is also the automation-
-- readiness signal (when Ed stops editing a class of reply, Claire can run it).
--
-- RECORD OWNERSHIP: workpaper — this is Bedrock's encode-Ed IP (how the operator
-- writes), never an association record. Not transferable on termination.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS email_reply_edits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What was answered (nullable so a delete of the mail never drops the lesson).
  inbound_message_id    UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  outbound_message_id   UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  community_id          UUID REFERENCES communities(id) ON DELETE SET NULL,
  persona               TEXT,          -- claire | emma | kat | ... (mirrors email_messages.persona)
  classification        TEXT,          -- homeowner_request | acc_request | ... (mirrors email_messages.classification)
  subject               TEXT,

  -- The lesson: Claire's autonomous attempt vs. what the human actually sent.
  original_draft        TEXT NOT NULL,
  final_sent            TEXT NOT NULL,
  was_edited            BOOLEAN NOT NULL DEFAULT FALSE,
  -- 0.0000 = sent Claire's draft verbatim, 1.0000 = rewritten from scratch.
  edit_ratio            NUMERIC(6,4) NOT NULL DEFAULT 0,

  -- Single-teacher: only the OWNER's edits should encode. Store who edited so
  -- retrieval can filter to Ed even after staff get send access.
  edited_by             TEXT,

  -- How often this pair has been fed back as a few-shot example (light telemetry).
  used_as_example_count INTEGER NOT NULL DEFAULT 0
);

-- Retrieval hot path: substantive edits for a persona+class, newest first.
CREATE INDEX IF NOT EXISTS idx_reply_edits_lookup
  ON email_reply_edits (persona, classification, was_edited, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_edits_community
  ON email_reply_edits (community_id);

-- New table the Node API writes to -> explicit grants (scar: new tables are
-- silently unwritable by service_role without them).
GRANT SELECT, INSERT, UPDATE, DELETE ON email_reply_edits TO service_role;
GRANT SELECT                          ON email_reply_edits TO authenticated;

COMMIT;
