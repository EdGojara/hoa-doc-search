// Builds tests/sql/465_forecast_rehearsal.sql: migration 465 + a test block that
// ends in RAISE (so the whole transaction rolls back). Synthetic rows only.
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const mig = fs.readFileSync(path.join(ROOT, 'migrations/465_forecasts_and_assessment_authority.sql'), 'utf8').replace(/\r\n/g, '\n');
const cut = mig.indexOf('  --@@END@@');
const Z9 = '0,0,0,0,0,0,0,0,0';
const tests = `  --@@END@@
END
$guard$;

DO $t$
DECLARE
  cid uuid; mc uuid; bid uuid; fid uuid; sid uuid; l5030 uuid; l5450 uuid; a5030 uuid; a5450 uuid; a4000 uuid; pj uuid; doc uuid; dbud uuid;
  ok boolean; msg text; n int; res text := ''; h0 text; h1 text; je0 text; jel0 text;
BEGIN
  SELECT id, management_company_id INTO cid, mc FROM communities WHERE name = 'Lakes of Pine Forest';
  SELECT id INTO bid FROM community_budgets WHERE community_id = cid AND fiscal_year = 2026;
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h0 FROM budget_line_items WHERE budget_id = bid;
  SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) INTO je0 FROM journal_entries;
  SELECT count(*)::text || ':' || sum(debit_cents)::text || ':' || sum(credit_cents)::text INTO jel0 FROM journal_entry_lines;
  SELECT id INTO a5030 FROM chart_of_accounts WHERE community_id = cid AND account_number = '5030';
  SELECT id INTO a5450 FROM chart_of_accounts WHERE community_id = cid AND account_number = '5450';
  SELECT id INTO a4000 FROM chart_of_accounts WHERE community_id = cid AND account_number = '4000';
  PERFORM set_config('trusted.actor', 'rehearsal@test', true);

  -- working forecast
  INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month, created_by) VALUES (cid, 2026, bid, 9, 'rehearsal@test') RETURNING id INTO fid;
  ok := false; BEGIN INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month) VALUES (cid, 2026, bid, 9); EXCEPTION WHEN unique_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'second working forecast allowed'; END IF; res := res || 'one working forecast ENFORCED; ';
  INSERT INTO community_budgets (community_id, fiscal_year, status) VALUES (cid, 2099, 'draft') RETURNING id INTO dbud;
  ok := false; BEGIN INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month) VALUES (cid, 2099, dbud, 0); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%approved budget%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'forecast on a draft budget allowed'; END IF; res := res || 'draft-budget forecast REFUSED; ';
  ok := false; BEGIN INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month, status, snapshot_of, frozen_at) VALUES (cid, 2026, bid, 9, 'snapshot', fid, now()); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%snapshot_budget_forecast%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'direct snapshot insert allowed'; END IF; res := res || 'direct snapshot insert REFUSED; ';

  -- lines
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, remaining_months) VALUES (fid, a5030, ARRAY[5,0,0,0,0,0,0,0,0,11041,11041,11049]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%actual, not forecast%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'forecast in an actual month allowed'; END IF; res := res || 'forecast in actual month REFUSED; ';
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, remaining_months, actual_months) VALUES (fid, a5030, ARRAY[${Z9},11041,11041,11049]::bigint[], ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%read actual months from the GL%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'working line stored actuals'; END IF; res := res || 'actuals stored on working line REFUSED; ';
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, remaining_months) VALUES (fid, a5030, 'manual', ARRAY[${Z9},100,100,100]::bigint[]); EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'manual without reason allowed'; END IF; res := res || 'manual w/o reason REFUSED; ';
  INSERT INTO forecast_lines (forecast_id, account_id, method, remaining_months, explanation, updated_by) VALUES (fid, a5030, 'remaining_budget', ARRAY[${Z9},11041,11041,11049]::bigint[], 'remaining budget', 'rehearsal@test') RETURNING id INTO l5030;
  INSERT INTO vendor_projects (management_company_id, community_id, title, category, stage, approved_cost_cents, target_date, funding_source, budget_account_id)
    VALUES (mc, cid, 'Fence replacement (rehearsal)', 'fencing', 'approved', 3000000, '2026-12-15', 'operating', a5450) RETURNING id INTO pj;
  INSERT INTO forecast_lines (forecast_id, account_id, method, remaining_months, updated_by) VALUES (fid, a5450, 'components', ARRAY[${Z9},25000,25000,3025000]::bigint[], 'rehearsal@test') RETURNING id INTO l5450;
  INSERT INTO forecast_line_components (forecast_line_id, forecast_id, kind, label, months, schedule_basis) VALUES (l5450, fid, 'recurring', 'Recurring repairs', ARRAY[${Z9},25000,25000,25000]::bigint[], 'calculated');
  INSERT INTO forecast_line_components (forecast_line_id, forecast_id, kind, label, months, schedule_basis, vendor_project_id, expected_date) VALUES (l5450, fid, 'project', 'Fence replacement (moved Oct→Dec)', ARRAY[${Z9},0,0,3000000]::bigint[], 'calculated', pj, '2026-12-15');
  PERFORM forecast_components_tie(l5450);
  res := res || 'hybrid line: recurring + project explain 100%; ';
  ok := false; BEGIN
    UPDATE forecast_line_components SET months = ARRAY[${Z9},0,0,2000000]::bigint[] WHERE forecast_line_id = l5450 AND kind = 'project';
    SET CONSTRAINTS trg_forecast_components_tie IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%100%%'; END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT ok THEN RAISE EXCEPTION 'components not explaining the line allowed'; END IF; res := res || 'partial components REFUSED; ';
  ok := false; BEGIN INSERT INTO forecast_line_components (forecast_line_id, forecast_id, kind, label, months, schedule_basis, is_assumption) VALUES (l5450, fid, 'contract', 'x', ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[], 'documented', true); EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'documented assumption allowed'; END IF; res := res || 'documented+assumed REFUSED; ';
  ok := false; BEGIN INSERT INTO forecast_line_components (forecast_line_id, forecast_id, kind, label, months, schedule_basis) VALUES (l5450, fid, 'known_invoice', 'x', ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[], 'documented'); EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'known_invoice without invoice allowed'; END IF; res := res || 'known_invoice w/o invoice REFUSED; ';
  UPDATE forecast_lines SET method = 'manual', override_reason = 'Vendor quoted $100/mo', remaining_months = ARRAY[${Z9},10000,10000,10000]::bigint[], updated_by = 'rehearsal@test' WHERE id = l5030;
  IF NOT EXISTS (SELECT 1 FROM forecast_events WHERE forecast_id = fid AND event = 'override' AND line_id = l5030 AND actor = 'rehearsal@test') THEN RAISE EXCEPTION 'override not logged'; END IF;
  res := res || 'override logged with actor; ';

  -- snapshot
  sid := snapshot_budget_forecast(fid, 'September close', 'rehearsal@test',
    jsonb_build_object(l5030::text, '[0,0,0,0,0,0,110,0,0,0,0,0]'::jsonb, l5450::text, '[0,0,0,0,0,0,9900,0,0,0,0,0]'::jsonb));
  SELECT count(*) INTO n FROM forecast_lines WHERE forecast_id = sid AND actual_months IS NOT NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'snapshot lines not frozen with actuals'; END IF;
  SELECT count(*) INTO n FROM forecast_line_components WHERE forecast_id = sid;
  IF n <> 2 THEN RAISE EXCEPTION 'snapshot components not copied'; END IF;
  IF (SELECT count(*) FROM forecast_events WHERE event = 'snapshot' AND forecast_id IN (fid, sid)) <> 2 THEN RAISE EXCEPTION 'snapshot not logged'; END IF;
  res := res || 'snapshot frozen (2 lines w/ actuals, 2 components, logged); ';
  ok := false; BEGIN UPDATE forecast_lines SET explanation = 'x' WHERE forecast_id = sid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%immutable%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'snapshot line edit allowed'; END IF;
  ok := false; BEGIN DELETE FROM forecast_line_components WHERE forecast_id = sid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%immutable%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'snapshot component delete allowed'; END IF;
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, remaining_months, actual_months) VALUES (sid, a4000, ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[], ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%immutable%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'snapshot line insert allowed'; END IF;
  ok := false; BEGIN UPDATE budget_forecasts SET label = 'x' WHERE id = sid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%immutable%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'snapshot header edit allowed'; END IF;
  ok := false; BEGIN DELETE FROM budget_forecasts WHERE id = fid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not deleted%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'forecast delete allowed'; END IF;
  ok := false; BEGIN UPDATE forecast_events SET actor = 'x' WHERE forecast_id = fid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%permanent%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'events not append-only'; END IF;
  res := res || 'snapshot edit/delete/insert + forecast delete REFUSED; events append-only; ';
  ok := false; BEGIN UPDATE budget_forecasts SET as_of_month = 10 WHERE id = fid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%clear forecast amounts%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'refresh left forecast in an actual month'; END IF; res := res || 'refresh with stale Oct forecast REFUSED; ';
  UPDATE forecast_line_components SET months[10] = 0 WHERE forecast_line_id = l5450;
  UPDATE forecast_lines SET remaining_months[10] = 0 WHERE id IN (l5030, l5450);
  UPDATE budget_forecasts SET as_of_month = 10, updated_by = 'rehearsal@test' WHERE id = fid;
  IF NOT EXISTS (SELECT 1 FROM forecast_events WHERE forecast_id = fid AND event = 'refresh') THEN RAISE EXCEPTION 'refresh not logged'; END IF;
  res := res || 'refresh to Oct logged; ';

  -- assessment authority
  SELECT id INTO doc FROM library_documents WHERE community_id = cid AND category = 'bylaws' LIMIT 1;
  ok := false; BEGIN INSERT INTO community_assessment_authority (community_id, effective_from, board_max_increase_pct, status) VALUES (cid, '2026-01-01', 10, 'verified'); EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'verified rule without source allowed'; END IF; res := res || 'verified rule w/o source REFUSED; ';
  INSERT INTO community_assessment_authority (community_id, effective_from, board_max_increase_pct, above_cap_permitted, member_approval_threshold_pct, member_approval_basis, source_document_id, source_citation, source_excerpt, status, verified_by, verified_at)
    VALUES (cid, '2026-01-01', 10, true, 66.667, 'votes_cast', doc, 'REHEARSAL citation', 'REHEARSAL excerpt', 'verified', 'rehearsal@test', now());
  ok := false; BEGIN INSERT INTO community_assessment_authority (community_id, effective_from, board_max_increase_pct, source_document_id, source_citation, source_excerpt, status, verified_by, verified_at)
    VALUES (cid, '2026-06-01', 5, doc, 'c', 'e', 'verified', 'x', now()); EXCEPTION WHEN unique_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'two current verified rules allowed'; END IF; res := res || 'one current verified rule ENFORCED; ';
  INSERT INTO community_assessment_rate_history (community_id, fiscal_year, annual_amount_cents, approved_by_body) VALUES (cid, 2026, 71768, 'board');
  ok := false; BEGIN INSERT INTO community_assessment_rate_history (community_id, fiscal_year, annual_amount_cents) VALUES (cid, 2026, 1); EXCEPTION WHEN unique_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'duplicate rate year allowed'; END IF; res := res || 'one rate per year ENFORCED; ';

  -- nothing real moved
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h1 FROM budget_line_items WHERE budget_id = bid;
  IF h1 <> h0 OR h0 <> 'd246598beacc61cab198e7a89bae5074' THEN RAISE EXCEPTION 'approved budget changed'; END IF;
  IF je0 <> (SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) FROM journal_entries)
  OR jel0 <> (SELECT count(*)::text || ':' || sum(debit_cents)::text || ':' || sum(credit_cents)::text FROM journal_entry_lines) THEN RAISE EXCEPTION 'GL changed'; END IF;
  res := res || 'approved budget hash ' || h0 || ' unchanged; GL unchanged';
  RAISE EXCEPTION 'REHEARSAL_OK %', res;
END
$t$;
`;
const out = mig.slice(0, cut) + tests;
fs.writeFileSync(path.join(ROOT, 'tests/sql/465_forecast_rehearsal.sql'), out);
console.log(out.length, require('crypto').createHash('sha256').update(out).digest('hex'), 'has ${:', out.includes('${'), 'backtick:', out.includes('`'), 'backslash:', out.includes('\\'));
