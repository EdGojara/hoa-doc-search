-- ============================================================================
-- 268_check_disbursement_account.sql  (Ed 2026-07-08)
-- ----------------------------------------------------------------------------
-- Lock check-cutting to ONE designated account per community. During a bank
-- transition a community can hold accounts at two banks (e.g. Canyon Gate:
-- Columbia [closing] + NewFirst [go-forward]). Checks must ONLY ever draw on the
-- designated account (the NewFirst operating), never a legacy/closing account —
-- even if that legacy account later gets a number entered for reconciliation.
--
-- The partial unique index enforces at most ONE disbursement account per
-- community at the DB level; createCheckRun refuses to cut from any other.
-- ============================================================================
BEGIN;

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS is_check_disbursement BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one designated check account per community.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_accounts_one_disbursement
  ON bank_accounts (community_id) WHERE is_check_disbursement = TRUE;

COMMIT;
