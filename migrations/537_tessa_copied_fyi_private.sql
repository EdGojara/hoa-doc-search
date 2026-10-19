-- ============================================================================
-- 537_tessa_copied_fyi_private.sql  (Ed 2026-10-19)
-- ----------------------------------------------------------------------------
-- 1) "Copied (FYI)" is its own inbox status. Mail where Tessa is only Cc'd (or
--    Bcc'd) is still filed without an automatic draft (Ed 2026-08-20), but it was
--    stored as 'dismissed', which reads as "Ed threw this away" and left no way
--    to act on it (Paul Grover, "RE: Tax return", 2026-10-19). New Cc/Bcc mail is
--    stored as 'fyi'. Existing rows are NOT rewritten: the app shows a legacy
--    auto-filed Cc row (dismissed, never touched since it was filed) as FYI too.
-- 2) Tessa's correspondence is owner-only. Every route reads it with the server's
--    secret key behind requireOwner, and no page reads these tables directly, yet
--    four of them granted SELECT to every signed-in user (authenticated). Revoke
--    that and turn on row level security with no policies on all seven Tessa
--    tables, so the database itself refuses anyone but the server. The secret key
--    bypasses RLS, so the app is unaffected.
-- 3) Delegated follow-through. Ed turns a copied email into a delegation ("track
--    Paul's signed 1120-H, file it, have it mailed"). It lives in Tessa's own
--    owner-only ledger (ea_followups, kind 'signed_return') with the association
--    it belongs to and a step checklist, plus an append-only audit of every step
--    (ea_followup_events): who checked, verified, filed, assigned, confirmed.
--    ea_inbox keeps the thread id and attachment NAMES (never bytes) so a returned
--    document can be recognised. Staff see only the print-and-mail task
--    (work_items). Existing follow-ups are kind 'task' and are unchanged.
-- Workpaper (Bedrock / owner-private). Changes no existing value.
-- ============================================================================
BEGIN;

ALTER TABLE ea_inbox DROP CONSTRAINT IF EXISTS ea_inbox_status_check;
ALTER TABLE ea_inbox ADD CONSTRAINT ea_inbox_status_check
  CHECK (status IN ('needs_review', 'replied', 'dismissed', 'fyi'));
COMMENT ON COLUMN ea_inbox.status IS
  'needs_review (Tessa drafted, or Ed asked her to) / replied / dismissed (Ed set it aside) / fyi (Tessa was only copied; filed without a draft until Ed gives her an instruction).';

ALTER TABLE ea_inbox ADD COLUMN IF NOT EXISTS conversation_id  TEXT;
ALTER TABLE ea_inbox ADD COLUMN IF NOT EXISTS attachment_names JSONB;
COMMENT ON COLUMN ea_inbox.attachment_names IS 'File names of the message''s non-inline attachments (metadata only; the bytes stay in the mailbox).';

ALTER TABLE ea_followups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE ea_followups DROP CONSTRAINT IF EXISTS ea_followups_kind_check;
ALTER TABLE ea_followups ADD CONSTRAINT ea_followups_kind_check CHECK (kind IN ('task', 'signed_return'));
ALTER TABLE ea_followups ADD COLUMN IF NOT EXISTS community_id    UUID REFERENCES communities(id) ON DELETE RESTRICT;
ALTER TABLE ea_followups ADD COLUMN IF NOT EXISTS source_inbox_id UUID REFERENCES ea_inbox(id) ON DELETE SET NULL;
ALTER TABLE ea_followups ADD COLUMN IF NOT EXISTS steps           JSONB;
CREATE INDEX IF NOT EXISTS idx_ea_followups_kind_status ON ea_followups (kind, status);

CREATE TABLE IF NOT EXISTS ea_followup_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_id  UUID NOT NULL REFERENCES ea_followups(id) ON DELETE RESTRICT,
  event        TEXT NOT NULL CHECK (event IN ('delegated', 'document_received', 'document_checked', 'signature_verified', 'signature_rejected',
                                              'filed', 'mailing_assigned', 'document_opened', 'mailing_confirmed', 'alert_sent', 'note')),
  actor        TEXT NOT NULL,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ea_followup_events_followup ON ea_followup_events (followup_id, created_at);

REVOKE ALL ON ea_followup_events FROM anon, authenticated;
ALTER TABLE ea_followup_events ENABLE ROW LEVEL SECURITY;
-- Append-only: even the server cannot rewrite or remove an audit entry.
REVOKE UPDATE, DELETE, TRUNCATE ON ea_followup_events FROM service_role;
GRANT SELECT, INSERT ON ea_followup_events TO service_role;

REVOKE ALL ON ea_inbox, ea_followups, ea_contacts, ea_standing_tasks, tessa_outbox, ea_email_events, ea_contact_email_history FROM anon, authenticated;
ALTER TABLE ea_inbox                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_followups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_contacts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_standing_tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tessa_outbox             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_email_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_contact_email_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON ea_inbox, ea_followups, ea_contacts, ea_standing_tasks, tessa_outbox, ea_email_events, ea_contact_email_history TO service_role;

COMMIT;
