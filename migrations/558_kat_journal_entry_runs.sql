-- ============================================================================
-- 558_kat_journal_entry_runs.sql  (Ed 2026-11-01: Kat prepares ordinary journal entries)
-- ----------------------------------------------------------------------------
-- Kat's controlled runs gain the process 'journal_entry': Kat PREPARES a balanced
-- entry (date, accounts, debits, credits, description, evidence); nothing posts at
-- prepare time. The owner approves each entry by name in Kat's queue (the same
-- authenticated in-app approval as every run), and only then does it post through
-- the existing posting code (lib/accounting/posting.postJournalEntry) with an
-- idempotency key, so a corrected and resubmitted entry can never post twice.
-- No new table, ledger or approval path. No rows change.
-- ============================================================================
BEGIN;

ALTER TABLE accounting_runs DROP CONSTRAINT IF EXISTS accounting_runs_process_check;
ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check
  CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment', 'reclassification', 'journal_entry'));

COMMIT;
