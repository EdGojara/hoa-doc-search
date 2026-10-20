-- ============================================================================
-- 539_reply_send_claims.sql  (Ed 2026-10-20)
-- ----------------------------------------------------------------------------
-- One atomic send claim per reply, shared by BOTH send paths (Communications
-- POST /api/email-triage/:id/send and the Draft Queue POST
-- /api/email-drafts/:id/send). Before calling Microsoft Graph a send inserts its
-- claim; the PRIMARY KEY makes a second simultaneous or repeated send for the same
-- inbound email fail with a unique violation instead of sending twice.
--
--   reply_key      'email:<email_messages.id>' for a reply to an inbound email;
--                  'draft:<outbound_email_drafts.id>' for a draft with no inbound.
--   status         sending -> sent | failed. A failed claim records whether the
--                  failure happened before anything could have gone out
--                  (uncertain = false, safe to retry) or during the send itself
--                  (uncertain = true: a person must check Sent Items first).
--
-- Scar (Ed 2026-10-20): Hugh Durlam's Oct 20 email had an obsolete AI draft in
-- Communications AND the approved reply in the Draft Queue; either Send button
-- would have gone out, and both could have.
--
-- Record ownership: workpaper (send-control audit). Community scope via the
-- inbound email / draft it references. New table only; changes no existing row.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS reply_send_claims (
  reply_key          text PRIMARY KEY CHECK (reply_key ~ '^(email|draft):[0-9a-f-]{36}$'),
  inbound_email_id   uuid REFERENCES email_messages(id) ON DELETE RESTRICT,
  outbound_draft_id  uuid REFERENCES outbound_email_drafts(id) ON DELETE RESTRICT,
  send_path          text NOT NULL CHECK (send_path IN ('communications', 'draft_queue')),
  status             text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  claim_token        uuid NOT NULL,
  package_sha256     text,
  claimed_by         text,
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  uncertain          boolean NOT NULL DEFAULT false,
  error              text,
  attempts           integer NOT NULL DEFAULT 1 CHECK (attempts >= 1)
);

CREATE INDEX IF NOT EXISTS idx_reply_send_claims_draft ON reply_send_claims (outbound_draft_id) WHERE outbound_draft_id IS NOT NULL;

ALTER TABLE reply_send_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reply_send_claims FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON reply_send_claims TO service_role;

COMMIT;
