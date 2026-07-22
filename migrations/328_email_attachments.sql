-- ===========================================================================
-- 328_email_attachments.sql   (Ed 2026-07-22)
-- ---------------------------------------------------------------------------
-- Durable archive of what homeowners actually SEND us — the photos, site
-- sketches, and PDFs attached to inbound email. Today those live only in
-- Outlook: once a message is filed its Graph id rotates and the attachments
-- can't be re-fetched, so a teammate trying to figure out (say) a boundary
-- dispute has nothing to look at. This captures them to storage at ingest and
-- links them to the community / property / contact so any team member can see
-- them on the record, not just if someone forwards the email.
--
-- Bytes live in the `documents` storage bucket at
--   email_attachments/<email_message_id>/<filename>
-- Record ownership: association_record (homeowner correspondence with the HOA).
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS email_attachments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id     UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  community_id         UUID NULL,
  resolved_property_id UUID NULL,
  resolved_contact_id  UUID NULL,
  sender_email         TEXT NULL,
  filename             TEXT NOT NULL,
  mime                 TEXT NULL,
  size_bytes           INTEGER NULL,
  storage_path         TEXT NOT NULL,
  is_image             BOOLEAN NOT NULL DEFAULT FALSE,
  record_ownership     TEXT NOT NULL DEFAULT 'association_record',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (message, filename) — re-archiving the same email is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attachments_msg_file
  ON email_attachments (email_message_id, filename);
CREATE INDEX IF NOT EXISTS idx_email_attachments_property ON email_attachments (resolved_property_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_contact  ON email_attachments (resolved_contact_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_community ON email_attachments (community_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_sender   ON email_attachments (lower(sender_email));

GRANT SELECT, INSERT, UPDATE, DELETE ON email_attachments TO service_role;
GRANT SELECT                          ON email_attachments TO authenticated;

COMMIT;

-- Verify:
--   SELECT filename, mime, size_bytes, resolved_property_id
--     FROM email_attachments ORDER BY created_at DESC LIMIT 20;
