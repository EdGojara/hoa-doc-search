-- ============================================================================
-- 240_continuous_bank_rec_register.sql
-- ----------------------------------------------------------------------------
-- The bank reconciliation is becoming the official books and records, so the
-- deposit / check / payout history must be CONTINUOUS — one community-wide
-- ledger the system reconciles every period from, not a file re-attached per
-- month. This is what lets a December deposit that clears in January match
-- across the year boundary, and removes the "attach a file, click run" step.
--
-- Uploads append here (replacing any existing rows in the same account + date
-- range, so re-uploading a report is idempotent). run-match reads the relevant
-- date range for each reconciliation.
--
-- Record ownership: association_record (the HOA's financial source data).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bank_rec_deposits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  account_last4   text,
  deposit_date    date NOT NULL,
  description     text,
  check_number    text,
  amount_cents    bigint NOT NULL,
  source_filename text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_rec_deposits_lookup ON bank_rec_deposits (community_id, account_last4, deposit_date);

CREATE TABLE IF NOT EXISTS bank_rec_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  account_last4   text,
  check_date      date,
  payee           text,
  check_number    text,
  amount_cents    bigint NOT NULL,
  source_filename text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_rec_checks_lookup ON bank_rec_checks (community_id, account_last4, check_date);

CREATE TABLE IF NOT EXISTS bank_rec_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  trxn_date       date,
  payout_date     date,
  account_ref     text,
  kind            text,
  txn_type        text,
  amount_cents    bigint NOT NULL,
  source_filename text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_rec_payouts_lookup ON bank_rec_payouts (community_id, payout_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_rec_deposits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_rec_checks   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_rec_payouts  TO service_role;
GRANT SELECT ON bank_rec_deposits TO authenticated;
GRANT SELECT ON bank_rec_checks   TO authenticated;
GRANT SELECT ON bank_rec_payouts  TO authenticated;

COMMIT;
