-- ============================================================================
-- 563_waterview_bank_opening_position.sql  (Ed 2026-11-17)
-- ----------------------------------------------------------------------------
-- Waterview Estates: the opening reconciled position at the 7/31/2026 cutover for Operating Checking (5961)
-- and Savings (6425), from Vantaca's balanced 7/31 bank reconciliation (the same pattern as LOPF 520).
-- Kat's monthly bank reconciliation needs it to carry the cutover items (deposits in transit, outstanding
-- checks); Waterview's native interest runs require that reconciliation for the prior month-end.
--   Operating: bank $80,210.75 + deposits in transit $5,457.82 - outstanding $373.21 = book $85,295.36.
--   Savings:   bank $38,183.64 = book $38,183.64.
-- Only sets bank_accounts.opening_position where it is still NULL. No journal entry, ledger row or balance changes.
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

UPDATE bank_accounts SET opening_position = '{"as_of_date":"2026-07-31","source":"Vantaca Bank Account Reconciliation for Period 7/31/2026 (WVA Operating Checking - 5961), balanced: bank $80,210.75, uncleared $5,084.61, book $85,295.36","bank_balance_cents":8021075,"book_balance_cents":8529536,"outstanding_checks":[{"check_number":"124","amount_cents":2000,"issue_date":"2025-10-27","payee":"Owner refund"},{"check_number":"125","amount_cents":4584,"issue_date":"2025-10-27","payee":"Owner refund"},{"check_number":"3162","amount_cents":500,"issue_date":"2026-04-10","payee":"Vantaca Pay fee (failed payment)"},{"check_number":"3162","amount_cents":500,"issue_date":"2026-05-11","payee":"Vantaca Pay fee (failed payment)"},{"check_number":"220","amount_cents":29737,"issue_date":"2026-06-09","payee":"Owner refund"}],"deposits_in_transit":[{"date":"2026-07-30","amount_cents":5600,"description":"Vantaca Pay recurring payment"},{"date":"2026-07-30","amount_cents":5125,"description":"Vantaca Pay recurring payment"},{"date":"2026-07-30","amount_cents":67078,"description":"Vantaca Pay recurring payment"},{"date":"2026-07-31","amount_cents":22500,"description":"Vantaca Pay recurring payment"},{"date":"2026-07-31","amount_cents":2000,"description":"Owner check"},{"date":"2026-07-31","amount_cents":2000,"description":"Owner check"},{"date":"2026-07-31","amount_cents":2000,"description":"Owner check"},{"date":"2026-07-31","amount_cents":12000,"description":"Owner check"},{"date":"2026-07-31","amount_cents":62500,"description":"Owner check"},{"date":"2026-07-31","amount_cents":7000,"description":"Owner check"},{"date":"2026-07-31","amount_cents":222679,"description":"Vantaca Pay one-time payment"},{"date":"2026-07-31","amount_cents":61500,"description":"Owner check #77935"},{"date":"2026-07-31","amount_cents":6150,"description":"Owner check #77935"},{"date":"2026-07-31","amount_cents":61500,"description":"Owner check #593035397"},{"date":"2026-07-31","amount_cents":6150,"description":"Owner check #593035397"}]}'::jsonb
 WHERE id = '829b287e-3d9f-4a4e-9eab-4ba437a329be' AND opening_position IS NULL;

UPDATE bank_accounts SET opening_position = '{"as_of_date":"2026-07-31","source":"Vantaca Bank Account Reconciliation for Period 7/31/2026 (WVA Savings MMKT - 6425), balanced: bank $38,183.64, no uncleared items","bank_balance_cents":3818364,"book_balance_cents":3818364,"outstanding_checks":[],"deposits_in_transit":[]}'::jsonb
 WHERE id = '238efceb-02de-4f8c-b5f5-dd078258c0f1' AND opening_position IS NULL;

COMMIT;
