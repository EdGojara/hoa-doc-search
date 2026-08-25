-- ============================================================================
-- 387 — Billing package reviews (Ed approves by email → post to AP).
-- ----------------------------------------------------------------------------
-- Ed 2026-08-25: "i want to have it where i email tessa back and say approved
-- and she sends it to AP."
--
-- Tessa emails Ed the monthly billing package for review. When Ed replies
-- "approved", her inbox poll (lib/ea/tessa_inbox.js) matches the reply to the
-- pending review recorded here and posts the invoice(s) into the ASSOCIATION's
-- AP for payment — the other side of Bedrock's own bill. This table is the
-- bridge: what was sent, and whether it has been approved and posted.
--
-- Hard cutoff at 2026-08-01 (Ed): invoices for periods before the cutoff, and
-- communities whose books stayed in Vantaca (books_of_record <> 'trusted', e.g.
-- Eaglewood), do NOT post to trustEd AP — they are handled in Vantaca. The gate
-- lives in lib/billing/post_fee_to_ap.js; this table only tracks the approval.
--
-- Record ownership: association_record (the association's payable + Bedrock's
-- correspondence about it).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS billing_package_reviews (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  month                 TEXT NOT NULL,                 -- 'YYYY-MM' the package is for
  invoice_ids           UUID[] NOT NULL DEFAULT '{}',  -- the Bedrock invoices in the package
  subject               TEXT,                          -- the exact email subject, for reply matching
  sent_to               TEXT,
  sent_at               TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'posted', 'ignored')),
  approved_at           TIMESTAMPTZ,
  approved_by           TEXT,                          -- the address that replied "approved"
  posted_ap_invoice_ids UUID[] NOT NULL DEFAULT '{}',
  post_note             TEXT,                          -- what happened per invoice (posted / skipped + reason)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One pending review per community+month; a re-send updates it.
  UNIQUE (community_id, month)
);

CREATE INDEX IF NOT EXISTS billing_package_reviews_pending_idx
  ON billing_package_reviews (status) WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_billing_package_reviews_updated ON billing_package_reviews;
CREATE TRIGGER trg_billing_package_reviews_updated
  BEFORE UPDATE ON billing_package_reviews
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE billing_package_reviews IS
  'Tracks the monthly billing package Tessa emails Ed for review. On Ed''s "approved" reply, the pending row is matched by subject and its invoices post to the association''s AP (subject to the 2026-08-01 cutoff + trustEd books).';

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_package_reviews TO service_role;
GRANT SELECT ON billing_package_reviews TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
