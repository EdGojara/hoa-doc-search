-- ============================================================================
-- 523_lopf_savings_reserve_transfer.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- Lakes of Pine Forest moved $85,400 from Savings (NewFirst ••2457, GL 1100, SAV
-- fund) to Reserve (••2465, GL 1110, RES fund) on 9/10/2026, as two bank lines:
-- "2025 Transfer" $42,700 and "2026 Transfer" $42,700. The bank movement is a fact;
-- only the authorization of the 2025 half is missing.
--
-- Configuration only (nothing posts):
--   * GL 4015 "Transfer Savings to Reserve": an interfund transfer account from SAV
--     to RES (migration 506 configuration), so the statements show "Transfer to
--     Reserve Fund" in Savings and "Transfer from Savings Fund" in Reserve, below
--     net income, and the consolidated statement nets it to zero.
--   * Kat's reconciliation rules on Savings for the two lines: each proposes the
--     transfer with both cash sides (Dr 4015 SAV / Cr 1100; Dr 1110 / Cr 4015 RES)
--     for owner approval; Reserve's reconciliation then matches its side. The 2025
--     line carries an authorization exception beside the proposal; the 2026 line
--     cites the budgeted $42,700 contribution (budgeted on 4010 from Operating, but
--     funded from Savings, which the basis states).
-- Record ownership: 4015 association_record; automation settings workpaper.
-- ============================================================================
BEGIN;

INSERT INTO chart_of_accounts (community_id, fund_id, account_number, account_name, account_type, account_subtype, normal_balance, is_active, is_summary, interfund_from_fund_id, interfund_to_fund_id)
SELECT 'a0000000-0000-4000-8000-000000000002', fs.id, '4015', 'Transfer Savings to Reserve', 'revenue', 'interfund_transfer', 'credit', true, false, fs.id, fr.id
  FROM account_funds fs, account_funds fr
 WHERE fs.community_id = 'a0000000-0000-4000-8000-000000000002' AND fs.fund_code = 'SAV'
   AND fr.community_id = 'a0000000-0000-4000-8000-000000000002' AND fr.fund_code = 'RES'
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.community_id = 'a0000000-0000-4000-8000-000000000002' AND c.account_number = '4015');

UPDATE community_accounting_automation
   SET settings = jsonb_set(settings, '{transfer_rules}', coalesce(settings->'transfer_rules', '[]'::jsonb) || '[
     {"bank_account_id": "8467a5a4-1291-4d94-8c28-b5f85fd862e0", "match": "^2026 Transfer$", "account": "4015", "counter_cash_account": "1110", "from_fund": "SAV", "to_fund": "RES",
      "basis": "Savings (1100) to Reserve (1110) on 9/10/2026, bank line \"2026 Transfer\", matching the $42,700.00 2026 reserve contribution in the approved 2026 budget (budgeted on 4010 from Operating; funded from Savings)."},
     {"bank_account_id": "8467a5a4-1291-4d94-8c28-b5f85fd862e0", "match": "^2025 Transfer$", "account": "4015", "counter_cash_account": "1110", "from_fund": "SAV", "to_fund": "RES",
      "basis": "Savings (1100) to Reserve (1110) on 9/10/2026, bank line \"2025 Transfer\": the cash moved and is recorded as a fund transfer.",
      "flag": "No board authorization for a 2025 reserve contribution of $42,700.00 is on file (the 2026 budget and the May 2026 board packet show none). Obtain the board approval or ratification."}
   ]'::jsonb)
 WHERE community_id = 'a0000000-0000-4000-8000-000000000002' AND process = 'bank_reconciliation'
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(settings->'transfer_rules', '[]'::jsonb)) r WHERE r->>'account' = '4015');

COMMIT;
