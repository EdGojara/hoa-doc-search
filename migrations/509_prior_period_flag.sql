-- ============================================================================
-- 509_prior_period_flag.sql  (Ed 2026-10-11)
-- ----------------------------------------------------------------------------
-- Presentation flag for prior-period activity recorded in a later month.
--
-- journal_entries.prior_period_through (date, nullable): "this entry records or
-- corrects activity of periods through this date." The financial statements
-- (lib/accounting/financial_statements.js budgetVsActual) exclude flagged
-- entries, and conversion re-posts (reference CONV-<batch>-REPOST-<je>), from
-- the month's operating results and print them on their own line below the
-- excess of revenue over expenses. Year to date keeps them in their accounts.
-- Accounting is unchanged: no amount, account, fund or date moves.
--
-- Backfill (Canyon Gate at Cinco Ranch, Ed-directed presentation): the six
-- reserve reclassification entries of pre-cutover spending, posted on the
-- first open date after the 7/31/2026 conversion:
--   JE-2026-00455  8/1  Saifee monument sign down payment (paid 4/22)
--   JE-2026-00457  8/1  Joel's clubhouse/guard shack painting (June)
--   JE-2026-00458  8/1  Joel's entrance structures painting (7/9)
--   JE-2026-00459  8/1  TAW tire spikes deposit (May)
--   JE-2026-00460  9/1  TAW tire spikes balance (invoice accrued 7/24, re-posted 8/1)
--   JE-2026-00461  9/1  CJ Wright clubhouse AC (2025 invoice re-posted 8/1)
--
-- Additive and safe to re-run. Applied through the in-app runner with
-- migrations/checks/509_prior_period_flag.json.
-- ============================================================================
BEGIN;

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS prior_period_through date;
COMMENT ON COLUMN journal_entries.prior_period_through IS
  'Presentation only: this entry records or corrects activity of periods through this date. Statements show it apart from the month''s operating results; year to date includes it. (Migration 509)';

UPDATE journal_entries
   SET prior_period_through = DATE '2026-07-31'
 WHERE community_id = 'a0000000-0000-4000-8000-000000000003'
   AND reference IN ('JE-2026-00455', 'JE-2026-00457', 'JE-2026-00458', 'JE-2026-00459', 'JE-2026-00460', 'JE-2026-00461')
   AND prior_period_through IS NULL;

COMMIT;
