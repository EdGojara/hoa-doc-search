-- ============================================================================
-- 532_compose_drafts_agent_tasks.sql  (Ed 2026-10-16)
-- ----------------------------------------------------------------------------
-- The New Email compose window saves its work as a DRAFT on the existing draft
-- store (outbound_email_drafts, migration 327) with draft_kind = 'compose', and
-- every such draft is a task on the creating agent's Mission Control list
-- (work_items, migrations 256 + 513). Ed's rule: work an AI agent started that
-- still needs a person stays visible in that agent's queue until it is resolved
-- (sent, discarded, or marked complete). No new table.
--
-- Adds:
--   outbound_email_drafts.compose_state          jsonb  recipient chips (name, email,
--                                                       role, community), the "write it"
--                                                       instruction, forward source id.
--                                                       to_email / cc stay the send truth.
--   outbound_email_drafts.work_item_id           uuid   the agent task for this draft
--   outbound_email_drafts.sent_email_message_id  uuid   the logged sent email
--   email_messages.outbound_draft_id             uuid   the sent email links back to the
--                                                       draft (and through it, the task)
--   community FK on outbound_email_drafts.community_id (was missing since 327). Added
--   NOT VALID so historical rows are not re-checked; every new or updated row is.
--
-- Attachment BYTES are not stored here. They live in the 'documents' storage
-- bucket at email_outbound_attachments/compose/<draft_id>/<timestamp>_<name>;
-- outbound_email_drafts.attachments keeps [{ name, storage_path, mime, size }],
-- the same descriptor shape the Draft Queue send path already attaches.
--
-- Record ownership: MIXED, unchanged from 327. A draft is Bedrock workpaper; at
-- send it is stamped record_ownership = 'association_record' and the sent email
-- (email_messages, association_record) carries outbound_draft_id. The work_items
-- task is workpaper (256). community_id is the termination-export key.
-- Additive only: no existing row changes. Nothing is sent by this migration.
-- ============================================================================
BEGIN;

ALTER TABLE outbound_email_drafts
  ADD COLUMN IF NOT EXISTS compose_state         JSONB NULL,
  ADD COLUMN IF NOT EXISTS work_item_id          UUID NULL,
  ADD COLUMN IF NOT EXISTS sent_email_message_id UUID NULL;

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS outbound_draft_id UUID NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_email_drafts_community_fkey') THEN
    ALTER TABLE outbound_email_drafts ADD CONSTRAINT outbound_email_drafts_community_fkey
      FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_email_drafts_work_item_fkey') THEN
    ALTER TABLE outbound_email_drafts ADD CONSTRAINT outbound_email_drafts_work_item_fkey
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_email_drafts_sent_email_fkey') THEN
    ALTER TABLE outbound_email_drafts ADD CONSTRAINT outbound_email_drafts_sent_email_fkey
      FOREIGN KEY (sent_email_message_id) REFERENCES email_messages(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_messages_outbound_draft_fkey') THEN
    ALTER TABLE email_messages ADD CONSTRAINT email_messages_outbound_draft_fkey
      FOREIGN KEY (outbound_draft_id) REFERENCES outbound_email_drafts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- The compose window's "Unsent drafts" list, per agent.
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_compose_open
  ON outbound_email_drafts (persona, updated_at DESC)
  WHERE draft_kind = 'compose' AND status = 'draft';
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_work_item
  ON outbound_email_drafts (work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_outbound_draft
  ON email_messages (outbound_draft_id) WHERE outbound_draft_id IS NOT NULL;

-- Grants restated (CLAUDE.md: never assume Postgres picks the right privileges).
GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_email_drafts TO service_role;
GRANT SELECT                          ON outbound_email_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_messages TO service_role;

COMMIT;

-- Verify:
--   SELECT id, persona, to_email, subject, status, work_item_id, sent_email_message_id
--     FROM outbound_email_drafts WHERE draft_kind = 'compose' ORDER BY updated_at DESC LIMIT 20;
--   SELECT id, title, assigned_to, status FROM work_items WHERE source_ref LIKE 'compose_draft:%' ORDER BY created_at DESC LIMIT 20;
