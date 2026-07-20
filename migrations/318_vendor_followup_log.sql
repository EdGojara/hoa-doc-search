-- ===========================================================================
-- 318_vendor_followup_log.sql
-- ---------------------------------------------------------------------------
-- Record ownership: `workpaper` (Bedrock's AP operations learning data).
--
-- The learning loop for vendor payment FOLLOW-UPS (lib/ap/followup.js): every
-- time a chase is matched to a bill and acted on, we log what it resolved to.
-- Over time this teaches which vendors chase (and how aggressively), and
-- strengthens the account#/invoice -> community link — the platform gets
-- smarter each pass instead of re-deriving it every time.
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vendor_followup_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id     UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  community_id         UUID REFERENCES communities(id) ON DELETE SET NULL,
  vendor_id            UUID REFERENCES vendors(id) ON DELETE SET NULL,
  account_number       TEXT,
  matched_invoice_id   UUID REFERENCES ap_invoices(id) ON DELETE SET NULL,
  matched_status       TEXT,          -- paid | on_hold | awaiting_approval | voided | not_found
  action               TEXT,          -- what the operator did: replied_paid | escalated | recorded | dismissed
  by_user_id           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_followup_vendor ON vendor_followup_log (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_followup_account ON vendor_followup_log (account_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_followup_community ON vendor_followup_log (community_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_followup_log TO service_role;
GRANT SELECT ON vendor_followup_log TO authenticated;

COMMIT;
