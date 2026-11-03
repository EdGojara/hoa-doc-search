-- ============================================================================
-- 559_kat_account_reconciliation.sql  (Ed 2026-11-03: Kat's monthly 2300 control)
-- ----------------------------------------------------------------------------
-- Kat's accounting runs gain the READ-ONLY process 'account_reconciliation': a
-- monthly reconciliation of GL 2300 (owner fees passing through to Bedrock) with
-- its exceptions, prepared by Kat and reviewed by the owner on Today. Nothing ever
-- posts (lib/accounting/account_2300_rec, lib/accounting/monthly_runs).
-- It is switched on as a recurring monthly control for every association that has
-- a 2300 account (enabled, never auto-posting; there is nothing to post).
-- Record ownership: workpaper (Kat's control; it changes no association record).
-- ============================================================================
BEGIN;

ALTER TABLE accounting_runs DROP CONSTRAINT IF EXISTS accounting_runs_process_check;
ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check
  CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment', 'reclassification', 'journal_entry', 'account_reconciliation'));

ALTER TABLE community_accounting_automation DROP CONSTRAINT IF EXISTS community_accounting_automation_process_check;
ALTER TABLE community_accounting_automation ADD CONSTRAINT community_accounting_automation_process_check
  CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'account_reconciliation'));

INSERT INTO community_accounting_automation (community_id, process, enabled, auto_post, settings, updated_by)
SELECT c.id, 'account_reconciliation', true, false, jsonb_build_object('account_number', '2300'), 'migration 559'
  FROM communities c
 WHERE c.id IN ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003',
                'a0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000006')
   AND EXISTS (SELECT 1 FROM chart_of_accounts a WHERE a.community_id = c.id AND a.account_number = '2300')
ON CONFLICT (community_id, process) DO NOTHING;

COMMIT;
