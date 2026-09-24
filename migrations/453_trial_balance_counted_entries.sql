-- ============================================================================
-- 453_trial_balance_counted_entries.sql
-- ----------------------------------------------------------------------------
-- One rule for which journal entries count in balances, shared with
-- lib/accounting/je_status.js (countsInGl):
--   counts:        status 'posted', or status 'voided' WITH its reversal present
--   never counts:  'draft', a voided entry with no reversal, any other status
--
-- Why: voidJournalEntry() posts a reversal AND marks the original 'voided'.
-- The statements counted only 'posted', dropping the original but keeping the
-- reversal, so every void was applied twice (LOPF 7/31: AP understated by
-- $11,275.23). This view had the opposite problem: its "je.status = 'posted'"
-- sat inside a LEFT JOIN, so it filtered nothing and counted every line,
-- including drafts. After this migration the view and the statements agree.
--
-- Read-side only: no journal entry, line or status is changed.
-- DROP + CREATE (column list unchanged) and re-GRANT, per the DROP VIEW scar.
-- ============================================================================
BEGIN;

DROP VIEW IF EXISTS v_trial_balance;
CREATE VIEW v_trial_balance AS
SELECT
  coa.community_id,
  coa.id                          AS account_id,
  coa.account_number,
  coa.account_name,
  coa.account_type,
  coa.account_subtype,
  coa.normal_balance,
  COALESCE(jl.fund_id, coa.fund_id) AS fund_id,
  af.fund_code,
  af.fund_name,
  COALESCE(SUM(jl.debit_cents), 0)  AS total_debits_cents,
  COALESCE(SUM(jl.credit_cents), 0) AS total_credits_cents,
  COALESCE(SUM(jl.debit_cents), 0) - COALESCE(SUM(jl.credit_cents), 0) AS balance_cents,
  CASE
    WHEN coa.normal_balance = 'debit' THEN COALESCE(SUM(jl.debit_cents), 0) - COALESCE(SUM(jl.credit_cents), 0)
    ELSE COALESCE(SUM(jl.credit_cents), 0) - COALESCE(SUM(jl.debit_cents), 0)
  END AS natural_balance_cents
FROM chart_of_accounts coa
LEFT JOIN (
  SELECT jel.account_id, jel.fund_id, jel.debit_cents, jel.credit_cents
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.status = 'posted'
     OR (je.status = 'voided' AND je.void_reversal_je_id IS NOT NULL)
) jl ON jl.account_id = coa.id
LEFT JOIN account_funds af ON af.id = COALESCE(jl.fund_id, coa.fund_id)
WHERE coa.is_active = TRUE
GROUP BY coa.community_id, coa.id, coa.account_number, coa.account_name,
         coa.account_type, coa.account_subtype, coa.normal_balance,
         COALESCE(jl.fund_id, coa.fund_id), af.fund_code, af.fund_name;

GRANT SELECT ON v_trial_balance TO anon, authenticated, service_role;

COMMIT;
