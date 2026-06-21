-- ============================================================================
-- 241_bank_rec_gl_cash_and_opening.sql
-- ----------------------------------------------------------------------------
-- Reconcile the bank to the GL, not to the registers. Ed: "ACH should reconcile
-- to the GL... it is the foundation of accounting to reconcile cash." The GL
-- cash account is the COMPLETE book — every deposit, check, ACH, fee, interest.
-- Registers (deposit/check/payout) are supporting detail; the GL is the source.
--
-- 1. bank_rec_gl_cash — a continuous, community-wide ledger of the cash account's
--    transactions for periods the live trustEd GL doesn't cover (Vantaca-era
--    history, ingested from the GL Trial Balance detail). Post-cutover periods
--    read journal_entry_lines directly; this fills in the years before. Uploads
--    append, replacing rows in the same account + date range (idempotent).
--
-- 2. bank_accounts.opening_position — the "stake in the ground". A community that
--    goes back a decade has no clean zero point, so we record the items
--    outstanding at a chosen cutover ONCE: { as_of_date, outstanding_checks:[
--    {check_number, amount_cents, issue_date, payee} ], deposits_in_transit:[
--    {amount_cents, date, description} ] }. Each clears when it hits the bank;
--    whatever is still uncleared carries forward. This is what lets every month
--    thereafter reconcile to $0 without inventing a fictional clean baseline.
--
-- Record ownership: association_record (the HOA's financial source data).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bank_rec_gl_cash (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  account_last4   text,
  gl_account      text,                 -- e.g. '1000' Operating Cash
  posting_date    date NOT NULL,
  ledger_id       text,
  description     text,
  amount_cents    bigint NOT NULL,      -- signed: debit (deposit) +, credit (payment) -
  check_number    text,
  source_filename text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_rec_gl_cash_lookup
  ON bank_rec_gl_cash (community_id, account_last4, posting_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_rec_gl_cash TO service_role;

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS opening_position jsonb;

COMMIT;
