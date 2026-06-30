-- ============================================================================
-- 250_trial_balance_line_fund.sql
-- ----------------------------------------------------------------------------
-- Fund-as-dimension, Phase 2 (view side). Re-point v_trial_balance at the
-- LINE's fund (COALESCE(jel.fund_id, coa.fund_id)) instead of the account's
-- fund. Grain becomes (account, fund): a single-fund account is one row exactly
-- as before; a multi-fund account (one 3050 segmented by fund, after the
-- Phase-3 equity collapse) splits into one row per fund.
--
-- BEHAVIOR-NEUTRAL TODAY: migration 249 backfilled every line's fund_id to its
-- account's fund, so COALESCE(jel.fund_id, coa.fund_id) == coa.fund_id for all
-- existing data — the view returns byte-identical rows until a multi-fund
-- account exists.
--
-- DROP+CREATE loses GRANTs (CLAUDE.md scar) — re-issued below.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS v_trial_balance CASCADE;

CREATE VIEW v_trial_balance AS
SELECT
  coa.community_id,
  coa.id                          AS account_id,
  coa.account_number,
  coa.account_name,
  coa.account_type,
  coa.account_subtype,
  coa.normal_balance,
  COALESCE(jel.fund_id, coa.fund_id) AS fund_id,
  af.fund_code,
  af.fund_name,
  COALESCE(SUM(jel.debit_cents), 0)  AS total_debits_cents,
  COALESCE(SUM(jel.credit_cents), 0) AS total_credits_cents,
  COALESCE(SUM(jel.debit_cents), 0) - COALESCE(SUM(jel.credit_cents), 0) AS balance_cents,
  CASE
    WHEN coa.normal_balance = 'debit' THEN COALESCE(SUM(jel.debit_cents), 0) - COALESCE(SUM(jel.credit_cents), 0)
    ELSE COALESCE(SUM(jel.credit_cents), 0) - COALESCE(SUM(jel.debit_cents), 0)
  END AS natural_balance_cents
FROM chart_of_accounts coa
LEFT JOIN journal_entry_lines jel ON jel.account_id = coa.id
LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
  AND je.status = 'posted'
LEFT JOIN account_funds af ON af.id = COALESCE(jel.fund_id, coa.fund_id)
WHERE coa.is_active = TRUE
GROUP BY coa.community_id, coa.id, coa.account_number, coa.account_name,
         coa.account_type, coa.account_subtype, coa.normal_balance,
         COALESCE(jel.fund_id, coa.fund_id), af.fund_code, af.fund_name;

GRANT SELECT ON v_trial_balance TO anon, authenticated, service_role;

COMMIT;
