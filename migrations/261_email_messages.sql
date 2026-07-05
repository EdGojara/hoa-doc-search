-- ============================================================================
-- 261_email_messages.sql  (Ed 2026-07-05)
-- ----------------------------------------------------------------------------
-- Communications hub — Phase 1 (read-only ingest + AI triage).
-- Every inbound (and later outbound) email on the bedrocktx.com shared mailboxes
-- lands here raw, gets an AI classification + entity extraction, and is
-- triangulated to the homeowner (contact/property), vendor, and community it
-- concerns. Nothing is auto-sent. A human confirms the link from the triage
-- board; on confirm we spawn an `interactions` row (the canonical dual-rail
-- record) so the touch shows on the homeowner/vendor record. See memory
-- project_correspondence_dual_rail, project_functional_inbox_routing.
--
-- Record ownership (CLAUDE.md bucket rules): MIXED. The raw triage row + AI
-- classification are `workpaper` (Bedrock's production process). The email
-- content itself, once posted as an interaction on behalf of the association,
-- is `association_record`. record_ownership defaults to workpaper here; the
-- spawned interaction carries the association_record side.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS email_messages (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox                  text NOT NULL,                         -- e.g. 'info@bedrocktx.com'
  graph_id                 text,                                  -- M365 Graph message id (idempotent ingest)
  internet_message_id      text,
  conversation_id          text,                                  -- thread grouping
  direction                text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  sender_email             text,
  sender_name              text,
  recipients               jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject                  text,
  body_preview             text,
  body_full                text,
  received_at              timestamptz,
  sent_at                  timestamptz,
  has_attachments          boolean NOT NULL DEFAULT false,

  -- AI understanding
  classification           text,                                  -- homeowner_request / violation_report / acc_request / vendor_financial / vendor_general / legal_privileged / internal / spam / other
  classification_confidence text CHECK (classification_confidence IN ('high','medium','low')),
  ai_summary               text,
  extracted                jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {names, addresses, amounts, ticket, community_hint, requested_action}

  -- Triangulated resolution
  community_id             uuid REFERENCES communities(id) ON DELETE SET NULL,
  resolved_contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  resolved_property_id     uuid REFERENCES properties(id) ON DELETE SET NULL,
  resolved_vendor_id       uuid REFERENCES vendors(id) ON DELETE SET NULL,
  resolution_confidence    text CHECK (resolution_confidence IN ('high','medium','low','none')),
  resolution_candidates    jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{type, id, label, score, why}]

  -- Workflow (human stays in control)
  triage_status            text NOT NULL DEFAULT 'new' CHECK (triage_status IN ('new','needs_review','linked','dismissed','spam','handled')),
  interaction_id           uuid REFERENCES interactions(id) ON DELETE SET NULL,  -- created on confirm-link
  priority                 text CHECK (priority IN ('high','normal','low')),
  reviewed_by              text,
  reviewed_at              timestamptz,

  record_ownership         text NOT NULL DEFAULT 'workpaper',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Idempotent ingest: one row per Graph message. Partial unique so nulls (seed
-- rows without a graph id) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_messages_graph_id ON email_messages(graph_id) WHERE graph_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_email_messages_triage      ON email_messages(triage_status);
CREATE INDEX IF NOT EXISTS ix_email_messages_class       ON email_messages(classification);
CREATE INDEX IF NOT EXISTS ix_email_messages_community   ON email_messages(community_id);
CREATE INDEX IF NOT EXISTS ix_email_messages_contact     ON email_messages(resolved_contact_id);
CREATE INDEX IF NOT EXISTS ix_email_messages_property    ON email_messages(resolved_property_id);
CREATE INDEX IF NOT EXISTS ix_email_messages_vendor      ON email_messages(resolved_vendor_id);
CREATE INDEX IF NOT EXISTS ix_email_messages_received    ON email_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS ix_email_messages_conversation ON email_messages(conversation_id);

DROP TRIGGER IF EXISTS trg_email_messages_updated_at ON email_messages;
CREATE TRIGGER trg_email_messages_updated_at BEFORE UPDATE ON email_messages
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON email_messages TO service_role;
GRANT SELECT                          ON email_messages TO authenticated;

COMMIT;
