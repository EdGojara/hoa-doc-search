-- ============================================================================
-- 587_payment_receipts_and_stripe_payouts.sql  (Ed 2026-11-27)
-- ----------------------------------------------------------------------------
-- Post-payment experience and Stripe payout reconciliation for homeowner
-- assessment payments (portal Pay, autopay, Checkout). Two parts, no new table.
--
-- 1. payments: the Bedrock confirmation number and the once-only notice record.
--    confirmation_number  'BP-XXXX-XXXX' (Crockford base32, no I/L/O/U). Set by the
--                         server when the payment group is created, on every row of
--                         the group; unique on the assessment row. Never a Stripe id.
--                         Shown on the portal success screen, the emailed receipt,
--                         the homeowner ledger line and the staff payment record.
--    receipt_*            the receipt emailed when the payment settles.
--    submitted_notice_*   the "bank payment submitted" email when an ACH payment
--                         starts processing.
--    *_claimed_at         compare-and-set claim taken BEFORE sending, so a webhook
--                         replay, a retry or two deliveries at once send at most one
--                         email (lib/payments/payment_receipts.js). A claim older than
--                         15 minutes with no sent_at is treated as abandoned.
--    Record ownership: association_record (correspondence sent on the
--    association's behalf; the sent receipt is also logged in interactions).
--
-- 2. bank_rec_payouts (migration 240): Stripe payout components staged from the
--    connected account's payout.paid / payout.failed webhook (kind = 'stripe',
--    source_filename = 'stripe:webhook'). One row per balance transaction in the
--    payout, so the monthly bank reconciliation can match one bank deposit to one
--    payout and propose Dr operating cash / Cr Stripe clearing (stripe:payout:<po>)
--    through Kat's run and the owner's approval. Nothing here posts.
--    Record ownership: association_record (settlement evidence for the books).
--
-- Existing Vantaca Pay rows keep NULL in every new column. balance_txn_id is a
-- plain UNIQUE constraint (NULLs are distinct), so the webhook's upsert can use
-- ON CONFLICT (balance_txn_id) and a replayed event stages nothing twice.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------- 1. payments
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS confirmation_number          text,
  ADD COLUMN IF NOT EXISTS receipt_email                text,
  ADD COLUMN IF NOT EXISTS receipt_claimed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_sent_at              timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_message_id           text,
  ADD COLUMN IF NOT EXISTS submitted_notice_claimed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_notice_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_notice_message_id  text,
  ADD COLUMN IF NOT EXISTS notice_error                 text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_confirmation_number_format') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_confirmation_number_format
      CHECK (confirmation_number IS NULL OR confirmation_number ~ '^BP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_confirmation_number
  ON payments (confirmation_number) WHERE confirmation_number IS NOT NULL AND fee_type = 'assessment';

-- Same alphabet and shape as lib/payments/confirmation_number.js.
CREATE OR REPLACE FUNCTION payment_new_confirmation_number() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  s text := '';
  i int;
BEGIN
  FOR i IN 1..8 LOOP
    s := s || substr(alphabet, 1 + floor(random() * 32)::int, 1);
  END LOOP;
  RETURN 'BP-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
END $$;

-- Backfill: one number per existing assessment payment group, on every row of the group.
DO $$
DECLARE g record; n text; tries int;
BEGIN
  FOR g IN SELECT DISTINCT payment_group_id FROM payments
            WHERE product_type = 'assessment_payment' AND payment_group_id IS NOT NULL AND confirmation_number IS NULL
  LOOP
    tries := 0;
    LOOP
      n := payment_new_confirmation_number();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM payments WHERE confirmation_number = n);
      tries := tries + 1;
      IF tries > 20 THEN RAISE EXCEPTION 'could not generate a unique confirmation number'; END IF;
    END LOOP;
    UPDATE payments SET confirmation_number = n WHERE payment_group_id = g.payment_group_id AND confirmation_number IS NULL;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_notice_error ON payments (community_id) WHERE notice_error IS NOT NULL;

-- ---------------------------------------------------------------- 2. bank_rec_payouts
ALTER TABLE bank_rec_payouts
  ADD COLUMN IF NOT EXISTS processor_payout_id  text,
  ADD COLUMN IF NOT EXISTS balance_txn_id       text,
  ADD COLUMN IF NOT EXISTS charge_id            text,
  ADD COLUMN IF NOT EXISTS payment_intent_id    text,
  ADD COLUMN IF NOT EXISTS payment_id           uuid REFERENCES payments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payout_status        text,
  ADD COLUMN IF NOT EXISTS arrival_date         date,
  ADD COLUMN IF NOT EXISTS payout_amount_cents  bigint,
  ADD COLUMN IF NOT EXISTS resolution           text,
  ADD COLUMN IF NOT EXISTS resolution_note      text,
  ADD COLUMN IF NOT EXISTS updated_at           timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_rec_payouts_payout_status_check') THEN
    ALTER TABLE bank_rec_payouts ADD CONSTRAINT bank_rec_payouts_payout_status_check
      CHECK (payout_status IS NULL OR payout_status IN ('paid', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_rec_payouts_resolution_check') THEN
    ALTER TABLE bank_rec_payouts ADD CONSTRAINT bank_rec_payouts_resolution_check
      CHECK (resolution IS NULL OR resolution IN ('tied', 'unresolved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_bank_rec_payouts_balance_txn') THEN
    ALTER TABLE bank_rec_payouts ADD CONSTRAINT uq_bank_rec_payouts_balance_txn UNIQUE (balance_txn_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_rec_payouts_processor_payout ON bank_rec_payouts (community_id, processor_payout_id) WHERE processor_payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_rec_payouts_payment ON bank_rec_payouts (payment_id) WHERE payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bank_rec_payouts_updated_at ON bank_rec_payouts;
CREATE TRIGGER trg_bank_rec_payouts_updated_at BEFORE UPDATE ON bank_rec_payouts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Grants already exist (migration 240); restated so this migration stands alone.
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_rec_payouts TO service_role;
GRANT SELECT ON bank_rec_payouts TO authenticated;

COMMIT;
