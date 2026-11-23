-- ============================================================================
-- 575_stamp_three_interest_rows.sql  (Ed 2026-11-23)
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (owner ledger).
-- Three interest charges posted through Kat's approved run 810c6af4 carry no owner
-- tenure, so the closing payoff (post_homeowner_tenure_payment, stamped charges only)
-- does not see them and refuses the seller's payoff. This records the owner they
-- already belong to. No amount, date, category or balance changes; nothing is added
-- or removed. Refuses unless exactly these three rows match.
-- ============================================================================
BEGIN;
DO $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ownership_tenures WHERE id = '359f7476-e6e7-4239-abbe-7534dff15a7a' AND property_id = '9d13a0a3-3116-4559-9a48-a4f6a93aa7f1' AND kind = 'owner' AND end_date IS NULL) THEN
    RAISE EXCEPTION '575: the tenure is not the open owner tenure of this lot';
  END IF;
  UPDATE homeowner_transactions
     SET tenure_id = '359f7476-e6e7-4239-abbe-7534dff15a7a'
   WHERE id IN ('688b825f-d013-4c14-8516-f37aeaf2020e', 'd58a6682-ce4d-466e-a517-72ee12aef173', '977cca97-45ce-4918-a425-e845ee5cc5a9')
     AND property_id = '9d13a0a3-3116-4559-9a48-a4f6a93aa7f1' AND tenure_id IS NULL
     AND txn_type = 'charge' AND charge_category = 'interest' AND amount_cents = 1144;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 3 THEN RAISE EXCEPTION '575: expected 3 rows, found %', n; END IF;
END $$;
COMMIT;
