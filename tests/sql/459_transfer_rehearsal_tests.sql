-- ============================================================================
-- 459 transfer rehearsal tests. Runs INSIDE the rehearsal transaction, after the
-- migration 459 body, and always ends by raising so everything rolls back.
-- Fixtures are synthetic lots in the demo community (Drama Creek). Nothing here
-- touches LOPF or any real homeowner.
-- ============================================================================
DO $tests$
DECLARE
  DC   constant uuid := 'dc100000-0000-4000-a000-000000000000';
  mc   uuid;
  batch uuid;
  log  text := '';
  got  text;
  r    jsonb;
  n    bigint;
  v    bigint;
  -- lot 1 (normal sale)
  p1 uuid; t1 uuid; s1 uuid; hs1 uuid; pa uuid; pb uuid; b1_t uuid; b1_c uuid;
  -- lot 2 (partial failure)
  p2 uuid; t2 uuid; s2 uuid; pc uuid; contacts0 bigint;
  -- lot 3 (co-owners)
  p3 uuid; t3 uuid; s3a uuid; s3b uuid; pd uuid; b3_t uuid; co uuid;
  -- lot 4 (bad dates) / lot 5 (new source account)
  p4 uuid; t4 uuid; s4 uuid; pe uuid; pf uuid;
  p5 uuid; t5 uuid; s5 uuid; pg uuid; pbad uuid; b5_t uuid;
BEGIN
  SELECT management_company_id INTO mc FROM communities WHERE id = DC;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status)
  VALUES (mc, DC, 'TEST 459 rehearsal', '2026-09-24', 'manual', 'committed') RETURNING id INTO batch;

  -- Fixture tenures can only be created on the transfer path.
  PERFORM set_config('trusted.ownership_transfer', 'on', true);
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST459 1 Rehearsal Ln', '945900101', 'T459-P1') RETURNING id INTO p1;
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST459 2 Rehearsal Ln', '945900202', 'T459-P2') RETURNING id INTO p2;
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST459 3 Rehearsal Ln', '945900303', 'T459-P3') RETURNING id INTO p3;
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST459 4 Rehearsal Ln', '945900404', 'T459-P4') RETURNING id INTO p4;
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST459 5 Rehearsal Ln', '945900505', 'T459-P5') RETURNING id INTO p5;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, p1, 'owner', '2020-01-01', '945900101', 'backfill_current') RETURNING id INTO t1;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, p2, 'owner', '2020-01-01', '945900202', 'backfill_current') RETURNING id INTO t2;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, p3, 'owner', '2020-01-01', '945900303', 'backfill_current') RETURNING id INTO t3;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, p4, 'owner', '2026-09-01', '945900404', 'backfill_current') RETURNING id INTO t4;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, p5, 'owner', '2020-01-01', '945900505', 'backfill_current') RETURNING id INTO t5;
  PERFORM set_config('trusted.ownership_transfer', 'off', true);

  INSERT INTO contacts (full_name) VALUES ('TEST459 Seller One')   RETURNING id INTO s1;
  INSERT INTO contacts (full_name) VALUES ('TEST459 Seller Two')   RETURNING id INTO s2;
  INSERT INTO contacts (full_name) VALUES ('TEST459 Seller ThreeA') RETURNING id INTO s3a;
  INSERT INTO contacts (full_name) VALUES ('TEST459 Seller ThreeB') RETURNING id INTO s3b;
  INSERT INTO contacts (full_name) VALUES ('TEST459 Seller Four')  RETURNING id INTO s4;
  INSERT INTO contacts (full_name) VALUES ('TEST459 Seller Five')  RETURNING id INTO s5;
  -- Owners added the ordinary way (no transfer path): stamped to the current tenure.
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source) VALUES
    (p1, s1, '2020-01-01', true, 'manual'), (p2, s2, '2020-01-01', true, 'manual'),
    (p3, s3a, '2020-01-01', true, 'manual'), (p4, s4, '2026-09-01', true, 'manual'),
    (p5, s5, '2020-01-01', true, 'manual');

  -- Lot 1 ledger: one row stamped to the seller, three unstamped on the account
  -- (one dated after the 8/15 settlement). Seller balance = 20.00+100.00-40.00+50.00 = 130.00
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents, tenure_id) VALUES
    (batch, 1, DC, '945900101', p1, '2026-06-01', 'TEST459 stamped assessment', 'charge', 2000, t1),
    (batch, 2, DC, '945900101', p1, '2026-07-01', 'TEST459 assessment', 'charge', 10000, NULL),
    (batch, 3, DC, '945900101', p1, '2026-07-15', 'TEST459 payment', 'payment', -4000, NULL),
    (batch, 4, DC, '945900101', p1, '2026-09-01', 'TEST459 post-settlement assessment', 'charge', 5000, NULL),
    (batch, 5, DC, '945900202', p2, '2026-07-01', 'TEST459 lot2 assessment', 'charge', 7000, NULL),
    (batch, 6, DC, '945900505', p5, '2026-07-01', 'TEST459 lot5 assessment', 'charge', 3000, NULL);

  -- ===== 11a. co-owner added outside a transfer: valid, lands on the current tenure
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source) VALUES (p3, s3b, '2021-05-01', false, 'manual') RETURNING id INTO co;
  IF (SELECT tenure_id FROM property_ownerships WHERE id = co) <> t3 THEN RAISE EXCEPTION 'FAIL 11a co-owner not on current tenure'; END IF;
  log := log || 'PASS 11a co-owner add stamped to current tenure | ';

  -- ===== 1-7, 12. normal manual sale, settlement 8/15 processed today, linked Home Sale
  INSERT INTO home_sales (community_id, property_id, status, seller_contact_id, seller_name, buyer_name)
  VALUES (DC, p1, 'disclosed', s1, 'TEST459 Seller One', 'TEST459 Buyer One') RETURNING id INTO hs1;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, current_owner_name, proposed_owner_name, proposed_owner_email, proposed_mailing_address, source, status, effective_start_date, home_sale_id)
  VALUES (p1, DC, s1, 'TEST459 Seller One', 'TEST459 Buyer One', 'test459.buyer1@example.invalid', '1 Buyer St, Houston TX 77084', 'manual_entry', 'pending', '2026-08-15', hs1) RETURNING id INTO pa;
  -- a duplicate entry of the same sale, still pending
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (p1, DC, s1, 'TEST459 Buyer One', 'manual_entry', 'pending', '2026-08-15') RETURNING id INTO pb;

  r := approve_ownership_proposal(pa, 'TEST459 reviewer', 'rehearsal');
  b1_t := (r->>'buyer_tenure_id')::uuid; b1_c := (r->>'new_contact_id')::uuid;
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL 1 not ok'; END IF;
  log := log || 'PASS 1 normal manual sale approved | ';

  IF (SELECT reviewed_at::date FROM ownership_change_proposals WHERE id = pa) <> CURRENT_DATE
     OR (SELECT effective_start_date FROM ownership_change_proposals WHERE id = pa) <> '2026-08-15' THEN
    RAISE EXCEPTION 'FAIL 2 processed/settlement dates';
  END IF;
  log := log || 'PASS 2 settlement 2026-08-15 kept separate from processed ' || CURRENT_DATE || ' | ';

  IF (SELECT end_date FROM property_ownerships WHERE property_id = p1 AND contact_id = s1) <> '2026-08-14'
     OR (SELECT end_date FROM ownership_tenures WHERE id = t1) <> '2026-08-14'
     OR (SELECT start_date FROM property_ownerships WHERE property_id = p1 AND contact_id = b1_c) <> '2026-08-15'
     OR (SELECT count(*) FROM property_ownerships WHERE property_id = p1 AND end_date IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL 3 seller end / buyer start';
  END IF;
  log := log || 'PASS 3 seller ownership+tenure end 2026-08-14, buyer starts 2026-08-15 | ';

  IF b1_t = t1 OR (SELECT start_date FROM ownership_tenures WHERE id = b1_t) <> '2026-08-15'
     OR (SELECT origin FROM ownership_tenures WHERE id = b1_t) <> 'transfer'
     OR (SELECT end_date FROM ownership_tenures WHERE id = b1_t) IS NOT NULL
     OR (SELECT tenure_id FROM property_ownerships WHERE property_id = p1 AND end_date IS NULL) <> b1_t
     OR (SELECT created_by_proposal_id FROM ownership_tenures WHERE id = b1_t) <> pa THEN
    RAISE EXCEPTION 'FAIL 4 buyer tenure';
  END IF;
  log := log || 'PASS 4 buyer on a new tenure | ';

  SELECT count(*), coalesce(sum(amount_cents), 0) INTO n, v FROM homeowner_transactions WHERE property_id = p1 AND tenure_id = t1;
  IF n <> 4 OR v <> 13000 OR (r->>'seller_balance_cents')::bigint <> 13000
     OR (SELECT coalesce(sum(balance_cents), 0) FROM v_former_owner_ledger_balances WHERE tenure_id = t1) <> 13000 THEN
    RAISE EXCEPTION 'FAIL 5 seller balance (rows %, sum %)', n, v;
  END IF;
  log := log || 'PASS 5 seller keeps $130.00 on the seller tenure (4 rows) | ';

  IF EXISTS (SELECT 1 FROM v_current_owner_ledger WHERE property_id = p1)
     OR EXISTS (SELECT 1 FROM v_current_owner_balance WHERE property_id = p1 AND balance_cents <> 0) THEN
    RAISE EXCEPTION 'FAIL 6 buyer inherited rows';
  END IF;
  log := log || 'PASS 6 buyer starts with $0.00 | ';

  IF jsonb_array_length(r->'transfer_exceptions') <> 1
     OR (r->'transfer_exceptions'->0->>'amount_cents')::bigint <> 5000
     OR (SELECT tenure_id FROM homeowner_transactions WHERE source_batch_id = batch AND source_row_index = 4) <> t1
     OR jsonb_array_length((SELECT transfer_exceptions FROM ownership_change_proposals WHERE id = pa)) <> 1 THEN
    RAISE EXCEPTION 'FAIL 7 post-settlement flag';
  END IF;
  log := log || 'PASS 7 9/1 charge after settlement flagged on the proposal, left on seller | ';

  IF (SELECT trusted_account_number FROM properties WHERE id = p1) <> 'T459-P1'
     OR (SELECT vantaca_account_id FROM properties WHERE id = p1) <> '945900101'
     OR (SELECT vantaca_account_id FROM ownership_tenures WHERE id = b1_t) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 12 account numbers';
  END IF;
  log := log || 'PASS 12 trusted account # unchanged; no source account supplied so xref unchanged | ';

  IF (SELECT status FROM home_sales WHERE id = hs1) <> 'closed'
     OR (SELECT closing_date FROM home_sales WHERE id = hs1) <> '2026-08-15'
     OR (SELECT seller_final_balance_cents FROM home_sales WHERE id = hs1) <> 13000
     OR (SELECT buyer_contact_id FROM home_sales WHERE id = hs1) <> b1_c
     OR (SELECT ownership_proposal_id FROM home_sales WHERE id = hs1) <> pa THEN
    RAISE EXCEPTION 'FAIL HS home sale link';
  END IF;
  log := log || 'PASS HS Home Sale closed + linked in the same transaction | ';

  -- ===== 8. duplicate approval refused (same proposal, and the duplicate entry)
  got := NULL;
  BEGIN PERFORM approve_ownership_proposal(pa, 'TEST459 reviewer'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%already approved%' THEN RAISE EXCEPTION 'FAIL 8a %', got; END IF;
  IF (SELECT status FROM ownership_change_proposals WHERE id = pb) <> 'superseded' THEN RAISE EXCEPTION 'FAIL 8b duplicate not superseded'; END IF;
  got := NULL;
  BEGIN PERFORM approve_ownership_proposal(pb, 'TEST459 reviewer'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%already superseded%' THEN RAISE EXCEPTION 'FAIL 8c %', got; END IF;
  log := log || 'PASS 8 re-approval refused; duplicate entry superseded and refused | ';

  -- ===== 9. direct writers refused (no transfer path)
  got := NULL; BEGIN UPDATE property_ownerships SET end_date = CURRENT_DATE WHERE property_id = p1 AND end_date IS NULL; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%Ownership Review%' THEN RAISE EXCEPTION 'FAIL 9a %', got; END IF;
  got := NULL; BEGIN DELETE FROM property_ownerships WHERE property_id = p1 AND end_date IS NULL; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 9b delete allowed'; END IF;
  got := NULL; BEGIN INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, origin) VALUES (DC, p2, 'owner', CURRENT_DATE, 'transfer'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 9c tenure insert allowed'; END IF;
  got := NULL; BEGIN UPDATE ownership_tenures SET end_date = CURRENT_DATE WHERE id = t2; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 9d tenure end allowed'; END IF;
  got := NULL; BEGIN UPDATE properties SET vantaca_account_id = '945900299' WHERE id = p2; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 9e account flip allowed'; END IF;
  got := NULL; BEGIN INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, tenure_id) VALUES (p1, s2, CURRENT_DATE, false, t1); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 9f open ownership on an ended tenure allowed'; END IF;
  got := NULL; BEGIN UPDATE property_ownerships SET end_date = NULL WHERE property_id = p1 AND contact_id = s1; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 9g reopening the seller allowed'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'approve_ownership_proposal') <> 1 THEN RAISE EXCEPTION 'FAIL 9h more than one approve path'; END IF;
  log := log || 'PASS 9 direct end/delete/reopen ownership, create/end tenure, account flip, stray open owner all refused; one approve function | ';

  -- ===== 10. partial failure rolls everything back (fails at the very last step)
  SELECT count(*) INTO contacts0 FROM contacts;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (p2, DC, s2, 'TEST459 Buyer Two', 'manual_entry', 'pending', '2026-08-20') RETURNING id INTO pc;
  got := NULL;
  BEGIN PERFORM approve_ownership_proposal(pc, 'TEST459 reviewer', NULL, NULL, gen_random_uuid()); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%home sale%' THEN RAISE EXCEPTION 'FAIL 10a %', got; END IF;
  IF (SELECT status FROM ownership_change_proposals WHERE id = pc) <> 'pending'
     OR (SELECT end_date FROM ownership_tenures WHERE id = t2) IS NOT NULL
     OR (SELECT count(*) FROM ownership_tenures WHERE property_id = p2) <> 1
     OR (SELECT count(*) FROM property_ownerships WHERE property_id = p2) <> 1
     OR (SELECT end_date FROM property_ownerships WHERE property_id = p2) IS NOT NULL
     OR (SELECT tenure_id FROM homeowner_transactions WHERE source_batch_id = batch AND source_row_index = 5) IS NOT NULL
     OR (SELECT count(*) FROM contacts) <> contacts0
     OR ownership_transfer_in_progress() THEN
    RAISE EXCEPTION 'FAIL 10b partial state left behind';
  END IF;
  log := log || 'PASS 10 failure at the last step left no trace (proposal pending, seller open, no tenure, no contact, no stamping) | ';

  -- ===== 11b. co-owner sale: both sellers end, buyer co-owner joins the buyer tenure
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (p3, DC, s3b, 'TEST459 Buyer Three', 'manual_entry', 'pending', '2026-08-10') RETURNING id INTO pd;
  r := approve_ownership_proposal(pd, 'TEST459 reviewer');
  b3_t := (r->>'buyer_tenure_id')::uuid;
  IF (r->>'prior_ownerships_closed')::int <> 2
     OR (SELECT count(*) FROM property_ownerships WHERE property_id = p3 AND end_date = '2026-08-09' AND tenure_id = t3) <> 2 THEN
    RAISE EXCEPTION 'FAIL 11b co-owner sellers';
  END IF;
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source) VALUES (p3, s4, '2026-08-10', false, 'manual') RETURNING id INTO co;
  IF (SELECT tenure_id FROM property_ownerships WHERE id = co) <> b3_t THEN RAISE EXCEPTION 'FAIL 11c buyer co-owner tenure'; END IF;
  log := log || 'PASS 11 both co-owner sellers ended 2026-08-09 on the seller tenure; buyer co-owner joins buyer tenure | ';

  -- ===== 14. invalid dates refused
  INSERT INTO ownership_change_proposals (property_id, community_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (p4, DC, 'TEST459 Buyer Four', 'manual_entry', 'pending', '2026-08-15') RETURNING id INTO pe;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pe, 'TEST459 reviewer'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%must be after%' THEN RAISE EXCEPTION 'FAIL 14a %', got; END IF;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pe, 'TEST459 reviewer', NULL, CURRENT_DATE + 30); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%future%' THEN RAISE EXCEPTION 'FAIL 14b %', got; END IF;
  INSERT INTO ownership_change_proposals (property_id, community_id, proposed_owner_name, source, status)
  VALUES (p4, DC, 'TEST459 Buyer Four', 'vantaca_import', 'pending') RETURNING id INTO pf;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pf, 'TEST459 reviewer'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%settlement_date_required%' THEN RAISE EXCEPTION 'FAIL 14c %', got; END IF;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pf, 'TEST459 reviewer', NULL, '2026-09-10'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NOT NULL THEN RAISE EXCEPTION 'FAIL 14d reviewer-supplied date refused: %', got; END IF;
  log := log || 'PASS 14 date before current tenure, future date, and missing date refused; reviewer-supplied date accepted | ';

  -- ===== 8/12b. supported new source account: xref moves, trusted # does not; bad account refused
  INSERT INTO ownership_change_proposals (property_id, community_id, proposed_owner_name, source, status, effective_start_date, vantaca_account_id)
  VALUES (p5, DC, 'TEST459 Buyer Five', 'vantaca_import', 'pending', '2026-08-05', 'ABC-1') RETURNING id INTO pbad;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pbad, 'TEST459 reviewer'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%unsupported source account%' THEN RAISE EXCEPTION 'FAIL XR1 %', got; END IF;
  UPDATE ownership_change_proposals SET status = 'withdrawn' WHERE id = pbad;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date, vantaca_account_id)
  VALUES (p5, DC, s5, 'TEST459 Buyer Five', 'vantaca_import', 'pending', '2026-08-05', '945900599') RETURNING id INTO pg;
  r := approve_ownership_proposal(pg, 'TEST459 reviewer');
  b5_t := (r->>'buyer_tenure_id')::uuid;
  IF (SELECT vantaca_account_id FROM properties WHERE id = p5) <> '945900599'
     OR (SELECT vantaca_account_id FROM ownership_tenures WHERE id = b5_t) <> '945900599'
     OR (SELECT vantaca_account_id FROM ownership_tenures WHERE id = t5) <> '945900505'
     OR (SELECT trusted_account_number FROM properties WHERE id = p5) <> 'T459-P5'
     OR (SELECT tenure_id FROM homeowner_transactions WHERE source_batch_id = batch AND source_row_index = 6) <> t5
     OR EXISTS (SELECT 1 FROM v_current_owner_ledger WHERE property_id = p5) THEN
    RAISE EXCEPTION 'FAIL XR2 new source account';
  END IF;
  log := log || 'PASS XR malformed account refused; supplied account 945900599 set on lot + buyer tenure, trusted # unchanged, seller $30.00 stays on seller | ';

  RAISE EXCEPTION 'REHEARSAL_OK: all transfer tests passed; rolled back. %', log;
END
$tests$;
