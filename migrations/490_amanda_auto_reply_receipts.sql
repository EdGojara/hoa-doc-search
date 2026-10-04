-- ============================================================================
-- 490_amanda_auto_reply_receipts.sql  (Issue #29, 2026-10-04)
-- ----------------------------------------------------------------------------
-- Amanda controlled send: the durable SEND RECEIPT for an automatic reply to an
-- authorized internal staff email. Reuses outbound_email_drafts (migration 327),
-- the existing outbound-draft store, with draft_kind = 'amanda_auto_reply' and
-- source_email_ref = 'email:<inbound internet_message_id>'. No new table.
--
-- 1. One inbound message can produce at most ONE automatic reply, ever: a unique
--    index on (source_email_ref, draft_kind) for this kind across EVERY status.
--    (327's unique index only covers status = 'draft'.) The INSERT is the claim.
-- 2. Send states for the crash-safe state machine (lib/amanda/auto_reply.js):
--      claimed -> draft_created -> draft_ready -> send_requested -> sent
--      (or unverified / failed for human review). send_requested is written
--      BEFORE Graph /send, so recovery knows /send may have been accepted and
--      never resends. Existing statuses (draft, sent, discarded) are unchanged.
-- 3. Lease columns so a live worker is never stolen (compare-and-set on
--    lease_token), plus the Graph handles and audit evidence.
--
-- Record ownership: workpaper (the receipt is Bedrock's production record; the
-- sent email itself is logged on email_messages as before). Additive only: no
-- existing row changes. GRANTs from 327 still apply (same table).
-- Applied by Ed. The feature stays off until AMANDA_AUTO_REPLY=on.
-- ============================================================================
BEGIN;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'outbound_email_drafts'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%draft%sent%discarded%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outbound_email_drafts DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE outbound_email_drafts
  ADD CONSTRAINT outbound_email_drafts_status_check
  CHECK (status IN ('draft', 'sent', 'discarded',
                    'claimed', 'draft_created', 'draft_ready', 'send_requested', 'unverified', 'failed'));

ALTER TABLE outbound_email_drafts
  ADD COLUMN IF NOT EXISTS lease_token              UUID NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at         TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claimed_at               TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS graph_draft_id           TEXT NULL,      -- immutable Graph id of the reply draft / sent item
  ADD COLUMN IF NOT EXISTS sent_internet_message_id TEXT NULL,      -- read from the Sent Items copy at verification
  ADD COLUMN IF NOT EXISTS conversation_id          TEXT NULL,
  ADD COLUMN IF NOT EXISTS objective_id             UUID NULL,
  ADD COLUMN IF NOT EXISTS inbound_email_id         UUID NULL,      -- email_messages.id at claim time (may be re-ingested)
  ADD COLUMN IF NOT EXISTS attempts                 INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verify_checks            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_requested_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS verified_at              TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS escalated_at             TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_error               TEXT NULL,
  ADD COLUMN IF NOT EXISTS policy                   JSONB NULL;     -- the authority decision and its reasons

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_drafts_amanda_auto_reply
  ON outbound_email_drafts (source_email_ref, draft_kind)
  WHERE draft_kind = 'amanda_auto_reply';

-- Recovery sweep: open receipts of this kind.
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_auto_reply_open
  ON outbound_email_drafts (status, lease_expires_at)
  WHERE draft_kind = 'amanda_auto_reply' AND escalated_at IS NULL;

-- Rate cap: automatic replies per recipient per hour.
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_auto_reply_rate
  ON outbound_email_drafts (to_email, created_at DESC)
  WHERE draft_kind = 'amanda_auto_reply';

COMMIT;
