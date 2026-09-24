-- ============================================================================
-- 460 same-day sequential resale rehearsal tests. Runs INSIDE the rehearsal
-- transaction after migration 460 (and the 459 suite), then raises so
-- everything rolls back. Synthetic lot in the demo community (Drama Creek)
-- mirroring LOPF 4719 Waterhaven: import-dated owner, then two closings on 8/12.
-- ============================================================================
DO $tests460$
DECLARE
  DC    constant uuid := 'dc100000-0000-4000-a000-000000000000';
  mc    uuid; batch uuid;
  log   text := coalesce(current_setting('rehearsal.log459', true), '(459 suite not run)') || ' || 460: ';
  got   text; r1 jsonb; r2 jsonb; n bigint; v bigint;
  q uuid; tb uuid; baker uuid; harkor uuid; fiat uuid; th uuid; tf uuid;
  hs1 uuid; hs2 uuid; p0 uuid; p1 uuid; pdup uuid; pnos uuid; p2 uuid; p3 uuid; pk uuid;
  names text;
BEGIN
  SELECT management_company_id INTO mc FROM communities WHERE id = DC;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status)
  VALUES (mc, DC, 'TEST 460 rehearsal', '2026-07-31', 'manual', 'committed') RETURNING id INTO batch;

  PERFORM set_config('trusted.ownership_transfer', 'on', true);
  INSERT INTO properties (community_id, street_address, vantaca_account_id, trusted_account_number)
  VALUES (DC, 'TEST460 4719 Rehearsal Ln', '946000101', 'T460-Q') RETURNING id INTO q;
  -- the import-dated current owner, like 4719 (start 5/19/2026, origin backfill_current)
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin)
  VALUES (DC, q, 'owner', '2026-05-19', '946000101', 'backfill_current') RETURNING id INTO tb;
  PERFORM set_config('trusted.ownership_transfer', 'off', true);
  INSERT INTO contacts (full_name) VALUES ('TEST460 Jim & Jeanne Baker') RETURNING id INTO baker;
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source) VALUES (q, baker, '2026-05-19', true, 'vantaca_import');
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents) VALUES
    (batch, 1, DC, '946000101', q, '2026-07-01', 'TEST460 assessment', 'charge', 1000),
    (batch, 2, DC, '946000101', q, '2026-08-12', 'TEST460 same-day charge', 'charge', 500);

  -- A. same-day on an import/backfill start date is refused (no weakening of date rules)
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (q, DC, baker, 'TEST460 Harkor Homes LLC', 'title_company', 'pending', '2026-05-19') RETURNING id INTO p0;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(p0, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%must be after%' THEN RAISE EXCEPTION 'FAIL A %', got; END IF;
  UPDATE ownership_change_proposals SET status = 'withdrawn' WHERE id = p0;
  log := log || 'PASS A same-day against an import start date refused | ';

  -- B. closing 1: Baker -> Harkor on 8/12 (own Home Sale + proposal)
  INSERT INTO home_sales (community_id, property_id, status, seller_contact_id, seller_name, buyer_name)
  VALUES (DC, q, 'requested', baker, 'TEST460 Jim & Jeanne Baker', 'TEST460 Harkor Homes LLC') RETURNING id INTO hs1;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date, home_sale_id)
  VALUES (q, DC, baker, 'TEST460 Harkor Homes LLC', 'title_company', 'pending', '2026-08-12', hs1) RETURNING id INTO p1;
  r1 := approve_ownership_proposal(p1, 'TEST460');
  harkor := (r1->>'new_contact_id')::uuid; th := (r1->>'buyer_tenure_id')::uuid;
  IF (r1->>'same_day_resale')::boolean
     OR (SELECT end_date FROM ownership_tenures WHERE id = tb) <> '2026-08-11'
     OR (SELECT end_date FROM property_ownerships WHERE property_id = q AND contact_id = baker) <> '2026-08-11'
     OR (SELECT start_date FROM ownership_tenures WHERE id = th) <> '2026-08-12'
     OR (SELECT origin FROM ownership_tenures WHERE id = th) <> 'transfer'
     OR jsonb_array_length(r1->'transfer_exceptions') <> 1 THEN
    RAISE EXCEPTION 'FAIL B closing 1 %', r1;
  END IF;
  log := log || 'PASS B Baker ends 8/11, Harkor tenure starts 8/12 (8/12 charge flagged on Baker, not moved) | ';

  -- C. duplicate entry of closing 1, and re-approval, refused
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (q, DC, baker, 'TEST460 Harkor Homes LLC', 'title_company', 'pending', '2026-08-12') RETURNING id INTO pdup;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pdup, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%seller_changed%' THEN RAISE EXCEPTION 'FAIL C1 %', got; END IF;
  UPDATE ownership_change_proposals SET status = 'withdrawn' WHERE id = pdup;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(p1, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%already approved%' THEN RAISE EXCEPTION 'FAIL C2 %', got; END IF;
  log := log || 'PASS C duplicate closing 1 and re-approval refused | ';

  -- D. same-day closing without a named seller refused
  INSERT INTO ownership_change_proposals (property_id, community_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (q, DC, 'TEST460 Fiat Homes LLC', 'vantaca_import', 'pending', '2026-08-12') RETURNING id INTO pnos;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pnos, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%must name the seller%' THEN RAISE EXCEPTION 'FAIL D %', got; END IF;
  UPDATE ownership_change_proposals SET status = 'withdrawn' WHERE id = pnos;
  log := log || 'PASS D same-day with no named seller refused | ';

  -- E. closing 2: Harkor -> Fiat on 8/12 (own Home Sale + proposal)
  INSERT INTO home_sales (community_id, property_id, status, seller_contact_id, seller_name, buyer_name)
  VALUES (DC, q, 'requested', harkor, 'TEST460 Harkor Homes LLC', 'TEST460 Fiat Homes LLC') RETURNING id INTO hs2;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date, home_sale_id)
  VALUES (q, DC, harkor, 'TEST460 Fiat Homes LLC', 'title_company', 'pending', '2026-08-12', hs2) RETURNING id INTO p2;
  r2 := approve_ownership_proposal(p2, 'TEST460');
  fiat := (r2->>'new_contact_id')::uuid; tf := (r2->>'buyer_tenure_id')::uuid;
  IF NOT (r2->>'same_day_resale')::boolean
     OR (SELECT start_date FROM ownership_tenures WHERE id = th) <> '2026-08-12'
     OR (SELECT end_date FROM ownership_tenures WHERE id = th) <> '2026-08-12'
     OR (SELECT start_date FROM property_ownerships WHERE property_id = q AND contact_id = harkor) <> '2026-08-12'
     OR (SELECT end_date FROM property_ownerships WHERE property_id = q AND contact_id = harkor) <> '2026-08-12'
     OR (SELECT start_date FROM ownership_tenures WHERE id = tf) <> '2026-08-12'
     OR (SELECT end_date FROM ownership_tenures WHERE id = tf) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL E closing 2 %', r2;
  END IF;
  log := log || 'PASS E Harkor kept as one-day owner 8/12-8/12; Fiat starts 8/12 | ';

  -- F. Fiat is the final current owner; exactly one open tenure and ownership
  IF (SELECT owner_contact_id FROM v_current_property_owners WHERE property_id = q) <> fiat
     OR (SELECT tenure_id FROM v_current_property_owners WHERE property_id = q) <> tf
     OR (SELECT count(*) FROM ownership_tenures WHERE property_id = q AND kind = 'owner' AND end_date IS NULL) <> 1
     OR (SELECT count(*) FROM property_ownerships WHERE property_id = q AND end_date IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL F current owner';
  END IF;
  log := log || 'PASS F Fiat Homes LLC is the only current owner | ';

  -- G. full history, three separate tenures, deterministic order
  SELECT string_agg(c.full_name, ' > ' ORDER BY o.start_date, o.end_date NULLS LAST, o.created_at) INTO names
    FROM property_ownerships o JOIN contacts c ON c.id = o.contact_id WHERE o.property_id = q;
  IF names <> 'TEST460 Jim & Jeanne Baker > TEST460 Harkor Homes LLC > TEST460 Fiat Homes LLC'
     OR (SELECT count(DISTINCT tenure_id) FROM property_ownerships WHERE property_id = q) <> 3 THEN
    RAISE EXCEPTION 'FAIL G history %', names;
  END IF;
  log := log || 'PASS G history Baker > Harkor > Fiat on 3 separate tenures | ';

  -- H. no balance movement: Baker keeps both rows; Harkor and Fiat have none
  SELECT count(*), coalesce(sum(amount_cents), 0) INTO n, v FROM homeowner_transactions WHERE property_id = q AND tenure_id = tb;
  IF n <> 2 OR v <> 1500
     OR EXISTS (SELECT 1 FROM homeowner_transactions WHERE tenure_id IN (th, tf))
     OR EXISTS (SELECT 1 FROM v_current_owner_ledger WHERE property_id = q)
     OR jsonb_array_length(r2->'transfer_exceptions') <> 0 THEN
    RAISE EXCEPTION 'FAIL H balances (rows %, sum %)', n, v;
  END IF;
  log := log || 'PASS H Baker keeps $15.00 on his tenure; Harkor and Fiat inherit nothing | ';

  -- I. two separate Home Sales, each closed and linked to its own proposal
  IF (SELECT status FROM home_sales WHERE id = hs1) <> 'closed' OR (SELECT ownership_proposal_id FROM home_sales WHERE id = hs1) <> p1
     OR (SELECT status FROM home_sales WHERE id = hs2) <> 'closed' OR (SELECT ownership_proposal_id FROM home_sales WHERE id = hs2) <> p2
     OR (SELECT buyer_contact_id FROM home_sales WHERE id = hs1) <> harkor OR (SELECT buyer_contact_id FROM home_sales WHERE id = hs2) <> fiat THEN
    RAISE EXCEPTION 'FAIL I home sales';
  END IF;
  log := log || 'PASS I two Home Sales, each closed + linked to its own proposal | ';

  -- J. out of order / after the fact: Harkor is no longer current; re-approval refused;
  --    a date before Fiat's start refused
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (q, DC, harkor, 'TEST460 Someone Else', 'title_company', 'pending', '2026-08-12') RETURNING id INTO p3;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(p3, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%seller_changed%' THEN RAISE EXCEPTION 'FAIL J1 %', got; END IF;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(p2, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%already approved%' THEN RAISE EXCEPTION 'FAIL J2 %', got; END IF;
  UPDATE ownership_change_proposals SET status = 'withdrawn' WHERE id = p3;
  INSERT INTO ownership_change_proposals (property_id, community_id, current_contact_id, proposed_owner_name, source, status, effective_start_date)
  VALUES (q, DC, fiat, 'TEST460 Someone Else', 'title_company', 'pending', '2026-08-11') RETURNING id INTO pk;
  got := NULL; BEGIN PERFORM approve_ownership_proposal(pk, 'TEST460'); EXCEPTION WHEN others THEN got := SQLERRM; END;
  IF got IS NULL OR got NOT LIKE '%must be after%' THEN RAISE EXCEPTION 'FAIL J3 %', got; END IF;
  log := log || 'PASS J former seller refused, re-approval refused, date before current start refused | ';

  RAISE EXCEPTION 'REHEARSAL_OK: 459 + 460 tests passed; rolled back. %', log;
END
$tests460$;
