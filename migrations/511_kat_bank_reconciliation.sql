-- ============================================================================
-- 511_kat_bank_reconciliation.sql  (Ed 2026-10-11)
-- ----------------------------------------------------------------------------
-- Kat's monthly bank reconciliation, on the same controlled run framework as
-- migration 510 (prepare -> approve / hold -> post -> audit). One run per bank
-- account per month: accounting_runs.subject_id names the bank account, and the
-- one-live-run index now includes it. The reconciliation itself is still stored
-- in bank_reconciliations / bank_reconciliation_items (migration 169); the run
-- holds what Kat prepared (matching, exceptions, proposed entries with their
-- evidence) and the audit trail of who approved what.
--
-- Seeds Canyon Gate at Cinco Ranch only:
--   * community_accounting_automation 'bank_reconciliation': enabled, auto_post
--     off, for NewFirst 5313 (GL 1000) and Columbia 3170 (GL 1005).
--   * bank_accounts.opening_position (migration 241) for those two accounts:
--     the reconciling items at the 7/31/2026 GL cutover, from the Vantaca "Bank
--     Account Reconciliation for Period 7/31/2026" report. These tie exactly:
--       NewFirst: book 121,269.35 = bank 117,182.17 + in transit 4,287.18 - check 27 200.00
--       Columbia: book  24,657.61 = bank  25,047.31 - check 50 (Texas Access Works) 389.70
--     opening_book_refs lists JE-2026-00420 (8/1 split of the Columbia opening
--     balance from GL 1000 to GL 1005): part of each account's opening book
--     balance, never a cash movement to be matched.
--
-- Record ownership: unchanged from 510 (runs mixed, automation workpaper);
-- opening_position is association_record (it is the books' reconciled position).
-- No journal entry, ledger row or balance is created or changed.
-- ============================================================================
BEGIN;

ALTER TABLE accounting_runs ADD COLUMN IF NOT EXISTS subject_id uuid;
COMMENT ON COLUMN accounting_runs.subject_id IS 'What the run is for when a process runs more than once a month (bank_reconciliation: bank_accounts.id). Null for community-wide processes.';

ALTER TABLE community_accounting_automation DROP CONSTRAINT IF EXISTS community_accounting_automation_process_check;
ALTER TABLE community_accounting_automation ADD CONSTRAINT community_accounting_automation_process_check CHECK (process IN ('recognition', 'interest', 'bank_reconciliation'));
ALTER TABLE accounting_runs DROP CONSTRAINT IF EXISTS accounting_runs_process_check;
ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check CHECK (process IN ('recognition', 'interest', 'bank_reconciliation'));

-- One live run per community + process + month + subject.
DROP INDEX IF EXISTS uq_accounting_runs_live;
CREATE UNIQUE INDEX uq_accounting_runs_live
  ON accounting_runs (community_id, process, period_month, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('prepared', 'approved', 'posted', 'held', 'failed');

-- The subject is part of what was prepared: it cannot be edited either.
CREATE OR REPLACE FUNCTION accounting_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'accounting runs are permanent (run %)', OLD.id; END IF;
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'a posted accounting run is final (run %)', OLD.id; END IF;
  IF OLD.status = 'superseded' THEN RAISE EXCEPTION 'a superseded accounting run is final (run %)', OLD.id; END IF;
  IF NEW.preview IS DISTINCT FROM OLD.preview OR NEW.totals IS DISTINCT FROM OLD.totals OR NEW.period_month IS DISTINCT FROM OLD.period_month
     OR NEW.community_id IS DISTINCT FROM OLD.community_id OR NEW.process IS DISTINCT FROM OLD.process OR NEW.subject_id IS DISTINCT FROM OLD.subject_id THEN
    RAISE EXCEPTION 'what was prepared cannot be edited; supersede the run and prepare a new one (run %)', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

-- Canyon Gate at Cinco Ranch only. bank_fee_account: where Kat proposes bank
-- service charges (5010 Bank Charges). No interest income account is set for the
-- operating accounts, so bank interest is an exception for a person to code.
INSERT INTO community_accounting_automation (community_id, process, enabled, auto_post, settings, updated_by)
SELECT 'a0000000-0000-4000-8000-000000000003', 'bank_reconciliation', true, false,
  '{"bank_account_ids": ["2dd4bf0b-0e71-4da0-b8a7-269845ddf54c", "ea31dca3-a435-4e9b-b72c-137ee840f6ba"], "bank_fee_account": "5010", "stale_check_days": 90, "stale_deposit_days": 10, "statement_due_day": 10, "match_window_days": 45}'::jsonb,
  'Migration 511 (Ed 2026-10-11)'
WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000003')
ON CONFLICT (community_id, process) DO NOTHING;

UPDATE bank_accounts SET opening_position = '{
  "as_of_date": "2026-07-31",
  "source": "Vantaca Bank Account Reconciliation for Period 7/31/2026 (NF - Operating Cash)",
  "bank_balance_cents": 11718217,
  "book_balance_cents": 12126935,
  "outstanding_checks": [
    {"check_number": "27", "amount_cents": 20000, "issue_date": "2026-07-14", "payee": "Cole W. Young (gate welding)"}
  ],
  "deposits_in_transit": [
    {"amount_cents": 184978, "date": "2026-07-31", "description": "Vantaca Pay payout ST-I4X2G8P5G6H7"},
    {"amount_cents": 150940, "date": "2026-07-31", "description": "Vantaca Pay payout ST-A6X2I7Q6Y6B0"},
    {"amount_cents": 92800, "date": "2026-07-31", "description": "Homeowner checks $25 + $25 + $878 (remote deposit)"}
  ],
  "opening_book_refs": ["JE-2026-00420"]
}'::jsonb
WHERE id = '2dd4bf0b-0e71-4da0-b8a7-269845ddf54c' AND opening_position IS NULL;

UPDATE bank_accounts SET opening_position = '{
  "as_of_date": "2026-07-31",
  "source": "Vantaca Bank Account Reconciliation for Period 7/31/2026 (Columbia Operating)",
  "bank_balance_cents": 2504731,
  "book_balance_cents": 2465761,
  "outstanding_checks": [
    {"check_number": "50", "amount_cents": 38970, "issue_date": "2026-05-07", "payee": "Texas Access Works LLC, invoice 03-042126-001 (gate clickers)"}
  ],
  "deposits_in_transit": [],
  "opening_book_refs": ["JE-2026-00420"]
}'::jsonb
WHERE id = 'ea31dca3-a435-4e9b-b72c-137ee840f6ba' AND opening_position IS NULL;

COMMIT;
