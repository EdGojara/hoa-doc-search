-- ============================================================================
-- 522_accounting_run_followups.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- Kat's runs are approved proposal by proposal ("tick to post; the rest stay").
-- Once a bank reconciliation or cutoff run was POSTED, the live-run index still
-- counted it, so the items left unticked for that account and month could never
-- come back for approval, in any community. A posted run is history:
--   * one OPEN run (prepared, approved, held, failed) per community + process +
--     month + subject, for every process (unchanged rule for open runs);
--   * a POSTED run blocks another posting run only where a second one would
--     duplicate amounts that are not keyed to a source: interest and recognition.
-- Bank reconciliation and cutoff proposals are idempotent on their own source
-- reference (bankrec:<bank line>, cutoff:<invoice>:...), so a follow-up run posts
-- only what is still unposted. No run, entry or reconciliation row changes.
-- Record ownership: workpaper (run bookkeeping).
-- ============================================================================
BEGIN;

DROP INDEX IF EXISTS uq_accounting_runs_live;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_runs_open
  ON accounting_runs (community_id, process, period_month, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('prepared', 'approved', 'held', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_runs_posted_once
  ON accounting_runs (community_id, process, period_month, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'posted' AND process IN ('interest', 'recognition');

COMMIT;
