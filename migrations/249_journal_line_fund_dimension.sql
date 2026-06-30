-- ============================================================================
-- 249_journal_line_fund_dimension.sql
-- ----------------------------------------------------------------------------
-- Fund as a transaction-line DIMENSION (Ed 2026-06-30). Align to Vantaca's
-- model: ONE natural fund-balance account (3050) segmented by the fund tagged
-- on each journal line, instead of separate per-fund equity accounts
-- (3010/3020/3050). This is PHASE 1 of that move — purely additive:
--
--   * Add journal_entry_lines.fund_id (nullable FK to account_funds).
--   * Backfill every existing line with its ACCOUNT's current fund.
--
-- NON-DESTRUCTIVE BY CONSTRUCTION: each line gets exactly the fund its account
-- already carries, so v_trial_balance (which still groups by the account's
-- fund) and every financial statement are byte-identical after this runs. The
-- later phases (point the view/statements at the line fund, then collapse the
-- equity accounts) are separate migrations so each can be verified to keep the
-- books tied to the penny.
--
-- account_funds is the fund table (migration 170). No new grants needed — this
-- only alters an existing table the service role already writes to.
-- ============================================================================

BEGIN;

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS fund_id UUID REFERENCES account_funds(id) ON DELETE SET NULL;

-- Backfill: each line inherits the fund currently on its account. Idempotent
-- (only fills NULLs), so re-running is safe.
UPDATE journal_entry_lines jel
   SET fund_id = coa.fund_id
  FROM chart_of_accounts coa
 WHERE coa.id = jel.account_id
   AND jel.fund_id IS NULL
   AND coa.fund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jel_fund
  ON journal_entry_lines (fund_id) WHERE fund_id IS NOT NULL;

COMMIT;
