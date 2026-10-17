-- ============================================================================
-- 534_stripe_payment_hardening.sql  (Ed 2026-10-16)
-- ----------------------------------------------------------------------------
-- Hardens the Stripe homeowner assessment pipeline before the first live
-- payment. WRITTEN, NOT APPLIED: Ed applies it.
--
-- Record ownership:
--   * stripe_payouts   association_record: cash moving from the association's
--                      Stripe balance to its operating bank account, with the GL
--                      entry that relieved Cash in Transit (1090) into 1000.
--   * payment_receipts association_record: the receipt for a homeowner payment to
--                      the association (whether or not it was emailed).
--   * the communities columns below are workpaper (Bedrock's payment
--     configuration for the association).
-- Every new table carries community_id (FK, RESTRICT) for termination export.
--
-- 1) communities: the per-community switch and the cached Stripe account state.
--    online_payments_enabled is OFF for every community. Checkout refuses unless
--    it is on AND the connected account can take charges and pay out in the
--    server's Stripe mode AND financials are active (lib/payments/payment_readiness.js).
--    payment_receipt_emails_enabled (OFF): receipts are recorded, never emailed,
--    until staff turn this on. stripe_dispute_auto_reversal (OFF): a lost dispute
--    is flagged for staff with the exact transfer reversal instead of reversing it.
-- 2) payments: at most ONE in-flight assessment checkout (awaiting payment or
--    ACH processing) per lot and owner tenure, so a second Pay click can never
--    open a second checkout for the same balance.
-- 3) stripe_payouts: one row per connected-account payout; the payout's GL entry
--    is 'stripe:payout:<po id>' (unique under uq_journal_entries_stripe_ref).
-- 4) payment_receipts: one receipt per settled payment.
-- No existing payment, ledger or journal row is changed.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1) communities: payment switches + cached connected-account state
-- ---------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS online_payments_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS online_payments_changed_by     text,
  ADD COLUMN IF NOT EXISTS online_payments_changed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS payment_receipt_emails_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_dispute_auto_reversal   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled         boolean,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled         boolean,
  ADD COLUMN IF NOT EXISTS stripe_account_livemode        boolean,
  ADD COLUMN IF NOT EXISTS stripe_account_checked_at      timestamptz;

COMMENT ON COLUMN communities.online_payments_enabled IS 'workpaper: per-community switch for homeowner online payment. OFF by default; checkout refuses unless ON and the connected account is ready in the server''s Stripe mode (lib/payments/payment_readiness.js).';
COMMENT ON COLUMN communities.payment_receipt_emails_enabled IS 'workpaper: when ON, a settled payment''s receipt is emailed to the payer. OFF by default: receipts are recorded in payment_receipts and never sent.';
COMMENT ON COLUMN communities.stripe_dispute_auto_reversal IS 'workpaper: when ON, a LOST dispute reverses the association transfer automatically. OFF by default: staff get the exact reversal to perform. Who bears disputes is an open policy decision (lib/payments/payment_policy.js).';
COMMENT ON COLUMN communities.stripe_account_livemode IS 'workpaper: livemode of the last account.updated event (or verified retrieval) for stripe_connected_account_id.';

-- ---------------------------------------------------------------------------
-- 2) one in-flight assessment checkout per lot + owner tenure
-- ---------------------------------------------------------------------------
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(property_id::text || '/' || tenure_id::text || ' x' || n, ', ') INTO dup
    FROM (SELECT property_id, tenure_id, count(*) AS n FROM payments
           WHERE product_type = 'assessment_payment' AND fee_type = 'assessment' AND payment_group_id IS NOT NULL
             AND settlement_state IN ('awaiting_payment', 'processing')
           GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'migration 534: more than one in-flight assessment checkout for lot/tenure %. Expire the stale ones (payment_mark_failed(group, NULL, NULL, ''expired'', ''stale checkout'')) and re-run.', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_assessment_in_flight
  ON payments (property_id, tenure_id)
  WHERE product_type = 'assessment_payment' AND fee_type = 'assessment' AND payment_group_id IS NOT NULL
    AND settlement_state IN ('awaiting_payment', 'processing');

-- ---------------------------------------------------------------------------
-- 3) stripe_payouts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_payouts (
  payout_id                 text PRIMARY KEY,
  community_id              uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  connected_account_id      text NOT NULL,
  livemode                  boolean NOT NULL,
  amount_cents              bigint NOT NULL CHECK (amount_cents >= 0),
  currency                  text NOT NULL DEFAULT 'usd',
  arrival_date              date NOT NULL,
  payout_status             text NOT NULL CHECK (payout_status IN ('paid', 'failed', 'canceled')),
  posting_state             text NOT NULL DEFAULT 'not_posted'
                            CHECK (posting_state IN ('not_posted', 'posted', 'blocked', 'not_applicable', 'reversed', 'review')),
  posting_note              text,
  journal_entry_id          uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  failure_journal_entry_id  uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  failure_code              text,
  failure_message           text,
  paid_event_id             text,
  failed_event_id           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE stripe_payouts IS 'association_record: each Stripe payout from an association''s connected account to its bank. posting_state says whether the GL entry Dr operating cash / Cr Stripe clearing (stripe:payout:<payout_id>) posted; bank reconciliation matches that entry to the bank deposit by amount and date.';
CREATE INDEX IF NOT EXISTS idx_stripe_payouts_community ON stripe_payouts (community_id, arrival_date DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_payouts_open ON stripe_payouts (community_id) WHERE posting_state IN ('blocked', 'review');
DROP TRIGGER IF EXISTS trg_stripe_payouts_updated_at ON stripe_payouts;
CREATE TRIGGER trg_stripe_payouts_updated_at BEFORE UPDATE ON stripe_payouts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
ALTER TABLE stripe_payouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_payouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON stripe_payouts TO service_role;

-- ---------------------------------------------------------------------------
-- 4) payment_receipts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         uuid NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  community_id       uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id        uuid REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id          uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  receipt_number     text NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  paid_on            date NOT NULL,
  payment_method     text,
  to_email           text,
  subject            text NOT NULL,
  body_text          text NOT NULL,
  status             text NOT NULL DEFAULT 'recorded'
                     CHECK (status IN ('recorded', 'sending_disabled', 'no_recipient', 'sent', 'send_failed')),
  status_note        text,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE payment_receipts IS 'association_record: the receipt for a settled homeowner payment. Always recorded; emailed only when communities.payment_receipt_emails_enabled is ON.';
CREATE INDEX IF NOT EXISTS idx_payment_receipts_community ON payment_receipts (community_id, paid_on DESC);
DROP TRIGGER IF EXISTS trg_payment_receipts_updated_at ON payment_receipts;
CREATE TRIGGER trg_payment_receipts_updated_at BEFORE UPDATE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
ALTER TABLE payment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON payment_receipts TO service_role;

COMMIT;
