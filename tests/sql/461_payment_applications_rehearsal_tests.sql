-- ============================================================================
-- 461 rehearsal tests (run inside the rolled-back rehearsal, after mig 461).
-- Part 1: synthetic Drama Creek lots. Part 2: the REAL 4707 Lakes of Pine Forest
-- Ct closing + $119.23 payoff, simulated end to end and rolled back, to produce
-- the exact dry run for approval. Ends by raising; nothing persists.
-- ============================================================================
DO $tests461$
DECLARE
  DC constant uuid := 'dc100000-0000-4000-a000-000000000000';
  LP constant uuid := 'a0000000-0000-4000-8000-000000000002';
  P4707 constant uuid := '0f0cde95-3f76-4eba-bf84-ff81ded44e4d';
  mc uuid; batch uuid; log text := '';
  q uuid; tq uuid; s uuid; pr uuid; r jsonb; d jsonb; seller_t uuid; buyer_t uuid; pay uuid; pbatch uuid;
  got text; n bigint; v bigint; app1 uuid; bc uuid;
  q2 uuid; tq2 uuid; s2 uuid;
  -- 4707
  hs uuid; pr4 uuid; r4 jsonb; d4 jsonb; p4 jsonb; st4 uuid; bt4 uuid; sum4 text;
BEGIN
  SELECT management_company_id INTO mc FROM communities WHERE id = DC;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status)
  VALUES (mc, DC, 'TEST461 ledger', '2026-07-31', 'manual', 'committed') RETURNING id INTO batch;
  PERFORM set_config('trusted.ownership_transfer', 'on', true);
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST461 1 Payoff Ln', '946100101', 'T461-Q') RETURNING id INTO q;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, q, 'owner', '2020-01-01', '946100101', 'backfill_current') RETURNING id INTO tq;
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number) VALUES (DC, 'TEST461 2 Payoff Ln', '946100202', 'T461-R') RETURNING id INTO q2;
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin) VALUES (DC, q2, 'owner', '2020-01-01', '946100202', 'backfill_current') RETURNING id INTO tq2;
  PERFORM set_config('trusted.ownership_transfer', 'off', true);
  INSERT INTO contacts (full_name) VALUES ('TEST461 Seller') RETURNING id INTO s;
  INSERT INTO contacts (full_name) VALUES ('TEST461 Owner R') RETURNING id INTO s2;
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source) VALUES (q, s, '2020-01-01', true, 'manual'), (q2, s2, '2020-01-01', true, 'manual');
  -- lot Q mirrors 4707: $119.23 across assessment, late fee, interest, certified letter
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents) VALUES
    (batch, 1, DC, '946100101', q, tq, '2026-07-31', 'TEST461 interest', 'balance_brought_forward', 'interest', 761),
    (batch, 2, DC, '946100101', q, tq, '2026-07-31', 'TEST461 certified letter', 'balance_brought_forward', 'certified_letter', 2500),
    (batch, 3, DC, '946100101', q, tq, '2026-07-31', 'TEST461 assessment', 'balance_brought_forward', 'assessment', 6500),
    (batch, 4, DC, '946100101', q, tq, '2026-07-31', 'TEST461 late fee', 'balance_brought_forward', 'late_fee', 2000),
    (batch, 5, DC, '946100101', q, tq, '2026-07-31', 'TEST461 interest b', 'balance_brought_forward', 'interest', 54),
    (batch, 6, DC, '946100101', q, tq, '2026-07-31', 'TEST461 interest c', 'balance_brought_forward', 'interest', 54),
    (batch, 7, DC, '946100101', q, tq, '2026-08-01', 'TEST461 8/1 interest', 'charge', 'interest', 54),
    -- lot R: an ambiguous prior_balance row plus an assessment
    (batch, 8, DC, '946100202', q2, tq2, '2026-07-31', 'TEST461 prior balance', 'balance_brought_forward', 'prior_balance', 1000),
    (batch, 9, DC, '946100202', q2, tq2, '2026-07-31', 'TEST461 assessment R', 'balance_brought_forward', 'assessment', 500);

  -- transfer Q (seller S) -> buyer on 8/27
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (q, DC, s, 'TEST461 Buyer', 'title_company', 'pending', '2026-08-27') RETURNING id INTO pr;
  r := approve_ownership_proposal(pr, 'TEST461');
  seller_t := (r->>'seller_tenure_id')::uuid; buyer_t := (r->>'buyer_tenure_id')::uuid;
  IF seller_t <> tq THEN RAISE EXCEPTION 'FAIL setup seller tenure'; END IF;

  -- 1. dry run: ties, assessment first, then step 6 oldest first, nothing written
  d := post_homeowner_tenure_payment(DC, q, seller_t, 11923, '2026-08-27', 'T-105699', 'TEST HOA', '{}'::jsonb, 'TEST461', true);
  IF (d->>'applied_cents')::bigint <> 11923 OR (d->>'open_after_cents')::bigint <> 0
     OR d->'applications'->0->>'category' <> 'assessment' OR (d->'applications'->0->>'step')::int <> 1
     OR d->'applications'->6->>'date' <> '2026-08-01' OR jsonb_array_length(d->'flagged') <> 0
     OR EXISTS (SELECT 1 FROM homeowner_txn_applications WHERE tenure_id = seller_t) THEN
    RAISE EXCEPTION 'FAIL 1 dry run %', d;
  END IF;
  log := log || 'PASS 1 dry run ties $119.23, assessment (step 1) first, 8/1 interest last, nothing written | ';

  -- 2. post: draft batch, one payment row on the SELLER tenure, 7 applications
  r := post_homeowner_tenure_payment(DC, q, seller_t, 11923, '2026-08-27', 'T-105699', 'TEST HOA', '{"home_sale_id":"test"}'::jsonb, 'TEST461', false);
  pay := (r->>'payment_txn_id')::uuid; pbatch := (r->>'batch_id')::uuid;
  IF (SELECT status FROM transaction_upload_batches WHERE id = pbatch) <> 'draft'
     OR (SELECT tenure_id FROM homeowner_transactions WHERE id = pay) <> seller_t
     OR (SELECT transaction_date FROM homeowner_transactions WHERE id = pay) <> '2026-08-27'
     OR (SELECT amount_cents FROM homeowner_transactions WHERE id = pay) <> -11923
     OR (SELECT reduction_source FROM homeowner_transactions WHERE id = pay) <> 'cash_payment'
     OR (SELECT count(*) FROM homeowner_txn_applications WHERE payment_txn_id = pay) <> 7
     OR (SELECT sum(applied_cents) FROM homeowner_txn_applications WHERE payment_txn_id = pay) <> 11923
     OR EXISTS (SELECT 1 FROM homeowner_txn_applications WHERE payment_txn_id = pay AND tenure_id <> seller_t) THEN
    RAISE EXCEPTION 'FAIL 2 post %', r;
  END IF;
  log := log || 'PASS 2 payment on seller tenure dated 8/27 (check date), 7 applications = $119.23 | ';

  -- 3. draft is invisible; after commit the seller is $0 and the buyer untouched
  IF (SELECT coalesce(sum(balance_cents), 0) FROM v_former_owner_ledger_balances WHERE tenure_id = seller_t) <> 11923 THEN RAISE EXCEPTION 'FAIL 3a draft visible'; END IF;
  UPDATE transaction_upload_batches SET status = 'committed', committed_at = now() WHERE id = pbatch;
  IF (SELECT coalesce(sum(balance_cents), 0) FROM v_former_owner_ledger_balances WHERE tenure_id = seller_t) <> 0
     OR EXISTS (SELECT 1 FROM homeowner_transactions WHERE tenure_id = buyer_t)
     OR EXISTS (SELECT 1 FROM v_current_owner_ledger WHERE property_id = q)
     OR EXISTS (SELECT 1 FROM homeowner_txn_applications WHERE tenure_id = buyer_t) THEN
    RAISE EXCEPTION 'FAIL 3b balances';
  END IF;
  log := log || 'PASS 3 draft invisible; committed -> seller $0.00, buyer tenure untouched | ';

  -- 4. no duplicate posting
  r := post_homeowner_tenure_payment(DC, q, seller_t, 11923, '2026-08-27', 'T-105699', 'TEST HOA', '{}'::jsonb, 'TEST461', false);
  IF NOT coalesce((r->>'already_posted')::boolean, false) OR (SELECT count(*) FROM homeowner_transactions WHERE raw_row_jsonb->>'check_number' = 'T-105699') <> 1 THEN
    RAISE EXCEPTION 'FAIL 4a re-post %', r;
  END IF;
  got := NULL;
  BEGIN
    INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, reduction_source, raw_row_jsonb)
    VALUES (pbatch, 2, DC, '946100101', q, seller_t, '2026-08-27', 'dup', 'payment', 'payment', -11923, 'cash_payment', '{"source":"closing_payoff","check_number":"T-105699"}');
  EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 4b duplicate row allowed'; END IF;
  log := log || 'PASS 4 retry returns the existing posting; a duplicate row is refused by the unique key | ';

  -- 5. never across tenures; no over-application; append-only; exact single reversal
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents)
  VALUES (batch, 10, DC, '946100101', q, buyer_t, '2026-09-01', 'TEST461 buyer charge', 'charge', 'assessment', 100) RETURNING id INTO bc;
  got := NULL; BEGIN INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis, applied_as_of, method)
    VALUES (DC, seller_t, pay, bc, 1, 1, 'delinquent_assessment', '2026-08-27', 'auto_209_0063'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%one owner tenure%' THEN RAISE EXCEPTION 'FAIL 5a cross-tenure %', got; END IF;
  SELECT id INTO app1 FROM homeowner_txn_applications WHERE payment_txn_id = pay ORDER BY priority_step, created_at LIMIT 1;
  got := NULL; BEGIN INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis, applied_as_of, method)
    SELECT DC, seller_t, pay, charge_txn_id, 1, 1, 'delinquent_assessment', '2026-08-27', 'auto_209_0063' FROM homeowner_txn_applications WHERE id = app1; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%over-applied%' THEN RAISE EXCEPTION 'FAIL 5b over-apply %', got; END IF;
  got := NULL; BEGIN UPDATE homeowner_txn_applications SET applied_cents = 1 WHERE id = app1; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 5c update allowed'; END IF;
  got := NULL; BEGIN DELETE FROM homeowner_txn_applications WHERE id = app1; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 5d delete allowed'; END IF;
  got := NULL; BEGIN INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_basis, applied_as_of, method, reverses_application_id)
    SELECT DC, seller_t, pay, charge_txn_id, -applied_cents, 'manual', '2026-09-24', 'manual_exception', id FROM homeowner_txn_applications WHERE id = app1; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%reason%' THEN RAISE EXCEPTION 'FAIL 5e reversal without approver %', got; END IF;
  INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_basis, applied_as_of, method, reverses_application_id, approved_by, notes)
    SELECT DC, seller_t, pay, charge_txn_id, -applied_cents, 'manual', '2026-09-24', 'manual_exception', id, 'TEST461', 'test reversal' FROM homeowner_txn_applications WHERE id = app1;
  got := NULL; BEGIN INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_basis, applied_as_of, method, reverses_application_id, approved_by, notes)
    SELECT DC, seller_t, pay, charge_txn_id, -applied_cents, 'manual', '2026-09-24', 'manual_exception', id, 'TEST461', 'again' FROM homeowner_txn_applications WHERE id = app1; EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL 5f second reversal allowed'; END IF;
  log := log || 'PASS 5 cross-tenure, over-application, update, delete, unapproved and repeat reversals refused; one exact reversal allowed | ';

  -- 6. ambiguous prior_balance never auto-applied; overpayment refused; wrong tenure refused
  d := post_homeowner_tenure_payment(DC, q2, tq2, 500, '2026-08-27', 'T-R1', 'TEST HOA', '{}'::jsonb, 'TEST461', true);
  IF (d->>'applied_cents')::bigint <> 500 OR d->'applications'->0->>'category' <> 'assessment' OR jsonb_array_length(d->'flagged') <> 1
     OR d->'flagged'->0->>'category' <> 'prior_balance' THEN RAISE EXCEPTION 'FAIL 6a %', d; END IF;
  got := NULL; BEGIN PERFORM post_homeowner_tenure_payment(DC, q2, tq2, 900, '2026-08-27', 'T-R2', 'TEST HOA', '{}'::jsonb, 'TEST461', true); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%exceeds%' THEN RAISE EXCEPTION 'FAIL 6b overpayment %', got; END IF;
  got := NULL; BEGIN PERFORM post_homeowner_tenure_payment(DC, q2, tq, 500, '2026-08-27', 'T-R3', 'TEST HOA', '{}'::jsonb, 'TEST461', true); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%does not belong%' THEN RAISE EXCEPTION 'FAIL 6c wrong tenure %', got; END IF;
  log := log || 'PASS 6 prior_balance flagged not applied; overpayment refused; tenure of another lot refused | ';

  -- ===== Part 2: REAL 4707 Lakes of Pine Forest Ct, simulated and rolled back =====
  INSERT INTO home_sales (community_id, property_id, status, seller_contact_id, seller_name, buyer_name, buyer_email)
  VALUES (LP, P4707, 'requested', '6228e6a2-bf8f-4b48-aa13-efb3030b6463', 'John & Anne Halphen', 'Corinne Little', 'cocorilit@gmail.com') RETURNING id INTO hs;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, current_owner_name, proposed_owner_name, proposed_owner_email, proposed_owner_phone, source, status, effective_start_date, home_sale_id)
  VALUES (P4707, LP, '6228e6a2-bf8f-4b48-aa13-efb3030b6463', 'John & Anne Halphen', 'Corinne Little', 'cocorilit@gmail.com', '832-748-4901', 'title_company', 'pending', '2026-08-27', hs) RETURNING id INTO pr4;
  r4 := approve_ownership_proposal(pr4, 'REHEARSAL');
  st4 := (r4->>'seller_tenure_id')::uuid; bt4 := (r4->>'buyer_tenure_id')::uuid;
  d4 := post_homeowner_tenure_payment(LP, P4707, st4, 11923, '2026-08-27', '105699', 'Lakes of Pine Forest Homeowners Association Inc', jsonb_build_object('home_sale_id', hs), 'REHEARSAL', true);
  p4 := post_homeowner_tenure_payment(LP, P4707, st4, 11923, '2026-08-27', '105699', 'Lakes of Pine Forest Homeowners Association Inc', jsonb_build_object('home_sale_id', hs), 'REHEARSAL', false);
  UPDATE transaction_upload_batches SET status = 'committed', committed_at = now() WHERE id = (p4->>'batch_id')::uuid;
  SELECT string_agg(format('%s. %s %s $%s (step %s) %s', ord, x->>'date', x->>'category', to_char((x->>'applied_cents')::bigint / 100.0, 'FM990.00'), x->>'step', left(x->>'charge_txn_id', 8)), ' ; ' ORDER BY ord)
    INTO sum4 FROM jsonb_array_elements(d4->'applications') WITH ORDINALITY AS e(x, ord);
  log := log || '|| 4707 REAL (rolled back): seller tenure ' || left(st4::text, 8) || ' ended ' || (r4->>'seller_end_date') || ', buyer tenure ' || left(bt4::text, 8)
    || ' starts ' || (r4->>'settlement_date') || ' | before ' || (d4->'by_category_before')::text || ' | order: ' || sum4
    || ' | after ' || (d4->'by_category_after')::text || ' | applied ' || (d4->>'applied_cents') || ' of ' || (d4->>'amount_cents')
    || ' | flagged ' || jsonb_array_length(d4->'flagged')
    || ' | posted rows: payment ' || left((p4->>'payment_txn_id'), 8) || ' tenure=seller ' || ((SELECT tenure_id FROM homeowner_transactions WHERE id = (p4->>'payment_txn_id')::uuid) = st4)::text
    || ', applications ' || (p4->>'applications_written')
    || ' | seller balance after ' || (SELECT coalesce(sum(balance_cents), 0) FROM v_former_owner_ledger_balances WHERE tenure_id = st4)::text
    || ' | buyer rows ' || (SELECT count(*) FROM homeowner_transactions WHERE tenure_id = bt4)::text
    || ' | buyer contact phone ' || coalesce((SELECT primary_phone FROM contacts WHERE id = (r4->>'new_contact_id')::uuid), 'null')
    || ' email ' || coalesce((SELECT primary_email FROM contacts WHERE id = (r4->>'new_contact_id')::uuid), 'null')
    || ' | current owner ' || (SELECT owner_name FROM v_current_property_owners WHERE property_id = P4707);

  RAISE EXCEPTION 'REHEARSAL_OK: 461 tests passed; rolled back. %', log;
END
$tests461$;
