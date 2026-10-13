-- ============================================================================
-- 518_cutoff_adjustment_runs.sql  (Ed 2026-10-13)
-- ----------------------------------------------------------------------------
-- Cutoff corrections go through Kat's controlled run framework (migration 510):
-- Kat PREPARES the correcting entries her month-end cutoff review found (accruals
-- with their reversals, deferrals with a prepaid recognition schedule, an Accrued
-- Expenses account if the chart lacks one), and the OWNER approves each proposal
-- by name with an authenticated in-app approval (lib/accounting/monthly_runs,
-- lib/accounting/cutoff_adjustments). Nothing posts at prepare time.
--
-- Ed: "Use the existing journal-entry approval process for the three accruals and
-- two deferrals." trustEd had no approval step for journal entries; this is the
-- minimum: one more process on the existing accounting_runs check. Prepared on
-- request only, so community_accounting_automation is unchanged (no schedule).
--
-- No row changes. Record ownership: unchanged from 510 (runs mixed).
-- ============================================================================
BEGIN;

ALTER TABLE accounting_runs DROP CONSTRAINT IF EXISTS accounting_runs_process_check;
ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check
  CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment'));

COMMIT;
