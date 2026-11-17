-- ============================================================================
-- 562_waterview_native_interest.sql  (Ed 2026-11-17)
-- ----------------------------------------------------------------------------
-- Waterview Estates: trustEd-native late interest replaces Vantaca's monthly interest charges.
--
-- Authority: Declaration Section 6.11 (2004): "Any assessment not paid within thirty (30) days after
-- the due date shall bear interest at the rate of ten percent (10%) per annum." Authorized by Ed
-- 2026-11-17: 10% annually, 30-day grace, assessment principal only, income GL 4030, calculated on
-- the eligible principal at the prior month-end (calc_cutoff) and posted on the run date.
--
-- Rows (Kat prepares; nothing posts without the owner's in-app approval; auto_post stays false):
--   interest             enabled, the settings above (lib/ar/monthly_interest.js; same as Canyon Gate's
--                        rate and grace, plus the prior-month-end cutoff).
--   bank_reconciliation  enabled for Operating Checking (GL 1000) and Savings (GL 1100): the interest
--                        run is blocked until the prior month's reconciliation of these accounts is
--                        complete, so interest is never charged on an unverified payment history.
--
-- Changes no journal entry, ledger row or balance. Record ownership: workpaper (Bedrock configuration).
-- ============================================================================
BEGIN;

INSERT INTO community_accounting_automation (community_id, process, enabled, auto_post, settings, updated_by)
SELECT 'a0000000-0000-4000-8000-000000000001', p.process, true, false, p.settings::jsonb, 'Migration 562 (Ed 2026-11-17)'
  FROM (VALUES
    ('interest', '{"rate_bps": 1000, "grace_days": 30, "due_offset_days": 0, "income_account_number": "4030", "calc_cutoff": "prior_month_end", "authority": "Declaration 6.11 (2004): 10% per annum on assessments unpaid 30 days after the due date"}'),
    ('bank_reconciliation', '{"bank_account_ids": ["829b287e-3d9f-4a4e-9eab-4ba437a329be", "238efceb-02de-4f8c-b5f5-dd078258c0f1"]}')
  ) AS p(process, settings)
ON CONFLICT (community_id, process) DO NOTHING;

COMMIT;
