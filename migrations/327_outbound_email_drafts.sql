-- ===========================================================================
-- 327_outbound_email_drafts.sql   (Ed 2026-07-22)
-- ---------------------------------------------------------------------------
-- The DRAFT QUEUE for homeowner-facing outbound mail. Ed's standing rule:
-- "I don't want approval letters going out until I approve them — no, don't
-- send anything out, put them in a draft queue so I can review and confirm."
--
-- Every persona reply, ACC acknowledgment, and ACC decision letter that would
-- otherwise send now lands here as status='draft'. Ed (or staff) reviews the
-- exact to/subject/body/attachments, edits if needed, and clicks Send — which
-- is the ONLY thing that actually calls Graph. Nothing leaves the building
-- without that click.
--
-- Record ownership: MIXED. A SENT message is correspondence on behalf of the
-- association (association_record). A draft never sent / discarded is Bedrock's
-- production workpaper. `record_ownership` is stamped 'association_record' at
-- send time; drafts stay 'workpaper'. status is the export discriminator.
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS outbound_email_drafts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  community_id           UUID NULL,
  community_name         TEXT NULL,

  -- Who it's from (persona) and to (homeowner).
  persona                TEXT NULL,                 -- 'annie','claire','miranda',...
  from_mailbox           TEXT NULL,                 -- resolved at send if null
  to_email               TEXT NOT NULL,
  to_name                TEXT NULL,
  cc                     TEXT NULL,

  subject                TEXT NOT NULL,
  body_html              TEXT NULL,
  body_text              TEXT NULL,
  attachments            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name,storage_path,mime}]

  -- What this reply is about, so it links back (integration depth) and threads.
  related_type           TEXT NULL,                 -- 'acc_decision','application','email_triage','violation'
  related_id             TEXT NULL,
  source_email_ref       TEXT NULL,                 -- inbound intake/graph ref being replied to
  draft_kind             TEXT NOT NULL DEFAULT 'reply', -- 'reply','acknowledgment','acc_decision'

  ai_drafted             BOOLEAN NOT NULL DEFAULT TRUE,
  draft_reason           TEXT NULL,                 -- why it was held for review

  status                 TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','sent','discarded')),
  record_ownership       TEXT NOT NULL DEFAULT 'workpaper',

  created_by             TEXT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by            TEXT NULL,
  sent_at                TIMESTAMPTZ NULL,
  send_error             TEXT NULL,
  sent_from              TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_drafts_status
  ON outbound_email_drafts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_community
  ON outbound_email_drafts (community_id, status);
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_related
  ON outbound_email_drafts (related_type, related_id);

-- Idempotency: never queue the same auto-draft twice for the same inbound email
-- + kind (a re-pull of the same mail must not create a second draft).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_drafts_source
  ON outbound_email_drafts (source_email_ref, draft_kind)
  WHERE source_email_ref IS NOT NULL AND status = 'draft';

GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_email_drafts TO service_role;
GRANT SELECT                          ON outbound_email_drafts TO authenticated;

-- updated_at trigger (reuse the standard function).
DROP TRIGGER IF EXISTS trg_outbound_drafts_updated ON outbound_email_drafts;
CREATE TRIGGER trg_outbound_drafts_updated BEFORE UPDATE ON outbound_email_drafts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMIT;

-- Verify:
--   SELECT id, persona, to_email, subject, status, created_at
--     FROM outbound_email_drafts ORDER BY created_at DESC LIMIT 20;
