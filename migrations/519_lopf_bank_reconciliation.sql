-- ============================================================================
-- 519_lopf_bank_reconciliation.sql  (Ed 2026-10-13)
-- ----------------------------------------------------------------------------
-- Lakes of Pine Forest on Kat's monthly bank reconciliation (migrations 510/511),
-- so entries the NewFirst statements show but the GL lacks are proposed and
-- approved by the owner by name (Ed: "Present them through the existing approval
-- workflow. Do not post them automatically.").
--
--   * community_accounting_automation 'bank_reconciliation' for LOPF: enabled,
--     auto_post OFF, for the Savings (••2457, GL 1100) and Reserve Money Market
--     (••2465, GL 1110) accounts. Interest is proposed to 4110 Interest - Savings
--     and 4120 Interest - Reserve respectively. Operating (••2449) joins once its
--     7/31 opening position is documented (the prior system's 7/31 reconciliation);
--     its IntraFi ICS sweep transfers are then proposed against 1005 (transfer rule).
--   * opening_position for Savings and Reserve at the 7/31/2026 cutover: the
--     NewFirst 7/31 statements equal the converted GL exactly (Savings $197,766.56,
--     Reserve $240,584.57), so there are no reconciling items.
-- Nothing is posted. Record ownership: automation workpaper; opening_position
-- association_record (the books' reconciled position).
-- ============================================================================
BEGIN;

INSERT INTO community_accounting_automation (community_id, process, enabled, auto_post, settings, updated_by)
SELECT 'a0000000-0000-4000-8000-000000000002', 'bank_reconciliation', true, false,
  '{"bank_account_ids": ["8467a5a4-1291-4d94-8c28-b5f85fd862e0", "f7124b35-d108-44f9-a304-9834964dcae7"],
    "interest_income_accounts": {"8467a5a4-1291-4d94-8c28-b5f85fd862e0": "4110", "f7124b35-d108-44f9-a304-9834964dcae7": "4120", "13d7c91d-955c-43a1-bee6-a77c8b5a84de": "4100"},
    "transfer_rules": [{"bank_account_id": "13d7c91d-955c-43a1-bee6-a77c8b5a84de", "match": "INTRAFI ICS", "account": "1005", "basis": "Transfer from the association''s IntraFi ICS sweep account (99792449, GL 1005) to Operating: both are LOPF Operating-fund cash."}],
    "stale_check_days": 90, "stale_deposit_days": 10, "statement_due_day": 10, "match_window_days": 45}'::jsonb,
  'Migration 519 (Ed 2026-10-13)'
WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000002')
ON CONFLICT (community_id, process) DO NOTHING;

UPDATE bank_accounts SET opening_position = '{"as_of_date": "2026-07-31", "source": "NewFirst statement 7/31/2026 (Business Premium MM 792457) equals converted GL 1100", "bank_balance_cents": 19776656, "book_balance_cents": 19776656, "outstanding_checks": [], "deposits_in_transit": []}'::jsonb
 WHERE id = '8467a5a4-1291-4d94-8c28-b5f85fd862e0' AND opening_position IS NULL;
UPDATE bank_accounts SET opening_position = '{"as_of_date": "2026-07-31", "source": "NewFirst statement 7/31/2026 (Business Premium MM 792465) equals converted GL 1110", "bank_balance_cents": 24058457, "book_balance_cents": 24058457, "outstanding_checks": [], "deposits_in_transit": []}'::jsonb
 WHERE id = 'f7124b35-d108-44f9-a304-9834964dcae7' AND opening_position IS NULL;

COMMIT;
