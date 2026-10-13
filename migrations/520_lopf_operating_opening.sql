-- ============================================================================
-- 520_lopf_operating_opening.sql  (Ed 2026-10-13)
-- ----------------------------------------------------------------------------
-- Lakes of Pine Forest Operating checking (NewFirst ••2449, GL 1000) joins Kat's
-- bank reconciliation (migration 519 enabled Savings and Reserve). Its 7/31/2026
-- opening position is the prior system's "Bank Account Reconciliation for Period
-- 7/31/2026" (balanced): bank $59,088.10, book $57,801.88, outstanding checks
-- #40 $1.00 (10/21/2025 owner refund), #1002 Lake Pro $1,185.22 and #1003
-- Prepared Publications $100.00 (both cleared in August). Its IntraFi ICS sweep
-- transfers are then proposed against 1005 by migration 519's transfer rule, for
-- owner approval. Nothing is posted.
-- Record ownership: opening_position association_record; automation workpaper.
-- ============================================================================
BEGIN;

UPDATE bank_accounts SET opening_position = '{"as_of_date": "2026-07-31", "source": "Vantaca Bank Account Reconciliation for Period 7/31/2026 (LOPF Operating Checking - 2449), balanced", "bank_balance_cents": 5908810, "book_balance_cents": 5780188, "outstanding_checks": [{"check_number": "40", "amount_cents": 100, "issue_date": "2025-10-21", "payee": "Owner refund"}, {"check_number": "1002", "amount_cents": 118522, "issue_date": "2026-07-31", "payee": "Lake Pro, Inc. (July 2026 lake management)"}, {"check_number": "1003", "amount_cents": 10000, "issue_date": "2026-07-31", "payee": "Prepared Publications (website maintenance)"}], "deposits_in_transit": []}'::jsonb
 WHERE id = '13d7c91d-955c-43a1-bee6-a77c8b5a84de' AND opening_position IS NULL;

UPDATE community_accounting_automation
   SET settings = jsonb_set(settings, '{bank_account_ids}', (settings->'bank_account_ids') || '["13d7c91d-955c-43a1-bee6-a77c8b5a84de"]'::jsonb)
 WHERE community_id = 'a0000000-0000-4000-8000-000000000002' AND process = 'bank_reconciliation'
   AND NOT (settings->'bank_account_ids') ? '13d7c91d-955c-43a1-bee6-a77c8b5a84de';

COMMIT;
