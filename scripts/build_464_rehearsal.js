// Builds the rolled-back rehearsal of migration 464. Monthly arrays come from
// lib/accounting/budget_phasing.js (the same code the API uses).
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'lib/accounting/budget_phasing'));
const { evenSplit } = require(path.join(ROOT, 'lib/accounting/budget_merge'));
const arr = (m) => `ARRAY[${m.join(',')}]::bigint[]`;
const js = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;

const FY = 2099;
const even5030 = P.phase({ method: 'even', annual_cents: 132500 });
const oct30k = P.placeInMonths(3000000, [9]);
const rec3k = evenSplit(300000);
const line5450 = rec3k.map((v, i) => v + oct30k[i]);
const assumed = P.phase({ method: 'contract', fy: FY, contract: { annual_cents: 6120000, effective_date: `${FY}-01-01`, end_date: `${FY}-12-31`, source_label: 'Rehearsal Landscape Co contract' } });
const sched = [{ month: 5, amount_cents: 900000 }, { month: 6, amount_cents: 1500000 }, { month: 7, amount_cents: 1500000 }, { month: 8, amount_cents: 1200000 }, { month: 9, amount_cents: 600000 }];
const documented = P.phase({ method: 'contract', fy: FY, contract: { documented_schedule: sched, source_label: 'Rehearsal Pool Co contract' } });

const mig = fs.readFileSync(path.join(ROOT, 'migrations/464_budget_monthly_plan.sql'), 'utf8').replace(/\r\n/g, '\n');
const cut = mig.indexOf('  --@@END@@');
const tests = `  --@@END@@
END
$guard$;

DO $t$
DECLARE
  cid uuid; mc uuid; src uuid; db uuid; proj_a uuid; proj_b uuid; vc_a uuid; vc_b uuid;
  l5300 uuid; l5030 uuid; l5740 uuid; l5450 uuid; l5200 uuid; l5320 uuid; l_fy26 uuid;
  a5450 uuid; a5740 uuid; m bigint[]; ok boolean; msg text; r jsonb; res text := ''; h0 text; h1 text; fp0 text := ''; fp1 text := ''; tb text; x text;
  pool26 bigint[];
BEGIN
  SELECT id, management_company_id INTO cid, mc FROM communities WHERE name = 'Lakes of Pine Forest';
  SELECT id INTO src FROM community_budgets WHERE community_id = cid AND fiscal_year = 2026;
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h0 FROM budget_line_items WHERE budget_id = src;
  FOREACH tb IN ARRAY ARRAY['journal_entries','journal_entry_lines','property_ownerships','homeowner_transactions','homeowner_payment_applications','ar_charges','ap_invoices','vendor_invoices','contacts','community_budgets','community_budget_events'] LOOP
    IF to_regclass('public.' || tb) IS NOT NULL THEN EXECUTE format('SELECT %L || '':'' || count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' ORDER BY t.id), '''')) FROM %I t', tb, tb) INTO x; fp0 := fp0 || x || ';'; END IF;
  END LOOP;
  SELECT monthly_amounts_cents INTO pool26 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = src AND a.account_number = '5300';

  -- Synthetic draft: FY${FY} copy of LOPF FY2026 (rolled back at the end).
  INSERT INTO community_budgets (community_id, fiscal_year, status, notes) VALUES (cid, ${FY}, 'draft', 'rehearsal copy') RETURNING id INTO db;
  INSERT INTO budget_line_items (budget_id, account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes)
    SELECT db, account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes FROM budget_line_items WHERE budget_id = src;
  -- 5740 has activity but no FY2026 budget line: add it to the draft as a zero line.
  INSERT INTO budget_line_items (budget_id, account_id, fund_id, annual_amount_cents, monthly_amounts_cents)
    SELECT db, a.id, a.fund_id, 0, ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[] FROM chart_of_accounts a WHERE a.community_id = cid AND a.account_number = '5740'
      AND NOT EXISTS (SELECT 1 FROM budget_line_items x WHERE x.budget_id = db AND x.account_id = a.id);
  SELECT b.id INTO l5300 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = db AND a.account_number = '5300';
  SELECT b.id INTO l5030 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = db AND a.account_number = '5030';
  SELECT b.id, a.id INTO l5740, a5740 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = db AND a.account_number = '5740';
  SELECT b.id, a.id INTO l5450, a5450 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = db AND a.account_number = '5450';
  SELECT b.id INTO l5200 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = db AND a.account_number = '5200';
  SELECT b.id INTO l5320 FROM budget_line_items b JOIN chart_of_accounts a ON a.id = b.account_id WHERE b.budget_id = db AND a.account_number = '5320';

  -- 1) Seasonal pool line: open + save unchanged -> identical.
  SELECT monthly_amounts_cents INTO m FROM budget_line_items WHERE id = l5300;
  PERFORM save_budget_line_plan(l5300, m, NULL, NULL, NULL, NULL, NULL, NULL);
  IF (SELECT monthly_amounts_cents FROM budget_line_items WHERE id = l5300) <> pool26 THEN RAISE EXCEPTION 'pool schedule changed on save'; END IF;
  res := res || '1 pool 5300 saved unchanged: ' || array_to_string(pool26, ',') || '; ';

  -- 2) Even line, because Even was chosen.
  PERFORM save_budget_line_plan(l5030, ${arr(even5030.monthly)}, 'even', ${js({ explanation: even5030.explanation })}, 'calculated', NULL, NULL, NULL);
  IF (SELECT monthly_amounts_cents FROM budget_line_items WHERE id = l5030) <> ${arr(even5030.monthly)} OR (SELECT annual_amount_cents FROM budget_line_items WHERE id = l5030) <> 132500 THEN RAISE EXCEPTION 'even line wrong'; END IF;
  res := res || '2 even 5030: ' || array_to_string((SELECT monthly_amounts_cents FROM budget_line_items WHERE id = l5030), ',') || '; ';

  -- 3) One-time project, $30,000 entirely in October, linked to a live project (synthetic).
  INSERT INTO vendor_projects (management_company_id, community_id, title, category, stage, approved_cost_cents, target_date, funding_source, budget_account_id)
    VALUES (mc, cid, 'Bulkhead repair (rehearsal)', 'general', 'approved', 3000000, '${FY}-10-31', 'operating', a5740) RETURNING id INTO proj_a;
  r := save_budget_line_plan(l5740, ${arr(oct30k)}, 'project', NULL, 'manual', 'Bulkhead repair', NULL,
    jsonb_build_array(jsonb_build_object('name', 'Bulkhead repair', 'kind', 'project', 'vendor_project_id', proj_a, 'project_stage_at_budget', 'approved', 'project_cost_at_budget_cents', 3000000,
      'monthly_amounts_cents', ${js(oct30k)}, 'planned_start', '${FY}-10-01', 'planned_end', '${FY}-10-31', 'schedule_basis', 'manual')));
  SELECT monthly_amounts_cents INTO m FROM budget_line_items WHERE id = l5740;
  IF m[10] <> 3000000 OR (SELECT sum(v) FROM unnest(m) v) <> 3000000 THEN RAISE EXCEPTION 'project not in October'; END IF;
  res := res || '3 project 5740: Oct ' || m[10] || ', other months 0, 1 component linked to project; ';

  -- 4) Recurring $3,000 + October project $30,000 = $33,000 line; components explain 100%.
  INSERT INTO vendor_projects (management_company_id, community_id, title, category, stage, approved_cost_cents, target_date, funding_source, budget_account_id)
    VALUES (mc, cid, 'Fence replacement (rehearsal)', 'fencing', 'approved', 3000000, '${FY}-10-31', 'operating', a5450) RETURNING id INTO proj_b;
  ok := false; BEGIN
    PERFORM save_budget_line_plan(l5450, ${arr(line5450)}, 'project', NULL, 'manual', NULL, NULL,
      jsonb_build_array(jsonb_build_object('name', 'Fence replacement', 'kind', 'project', 'vendor_project_id', proj_b, 'monthly_amounts_cents', ${js(oct30k)})));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%100%%'; msg := SQLERRM; END;
  IF NOT ok THEN RAISE EXCEPTION 'partial components accepted'; END IF;
  res := res || '4a line 33000 with only the 30000 project REFUSED (' || left(msg, 90) || '...); ';
  r := save_budget_line_plan(l5450, ${arr(line5450)}, 'project', NULL, 'manual', 'Repairs + fence replacement', NULL,
    jsonb_build_array(
      jsonb_build_object('name', 'Recurring repairs', 'kind', 'recurring', 'monthly_amounts_cents', ${js(rec3k)}, 'schedule_basis', 'calculated'),
      jsonb_build_object('name', 'Fence replacement', 'kind', 'project', 'vendor_project_id', proj_b, 'project_stage_at_budget', 'approved', 'project_cost_at_budget_cents', 3000000, 'monthly_amounts_cents', ${js(oct30k)}, 'schedule_basis', 'manual')));
  IF (SELECT annual_amount_cents FROM budget_line_items WHERE id = l5450) <> 3300000 THEN RAISE EXCEPTION 'line not 33000'; END IF;
  IF (SELECT sum(annual_amount_cents) FROM budget_line_components WHERE budget_line_id = l5450) <> 3300000 THEN RAISE EXCEPTION 'components not 33000'; END IF;
  res := res || '4b 5450 line ' || array_to_string((SELECT monthly_amounts_cents FROM budget_line_items WHERE id = l5450), ',') || ' = recurring 3000 + Oct project 30000 (tie OK); ';
  -- Changing the line alone (components unchanged) is refused at commit (forced immediate here).
  ok := false; BEGIN
    UPDATE budget_line_items SET monthly_amounts_cents = ${arr(evenSplit(3300000))} WHERE id = l5450;
    SET CONSTRAINTS trg_budget_line_items_components_tie IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%100%%'; END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT ok THEN RAISE EXCEPTION 'line changed without its components'; END IF;
  res := res || '4c flattening the line without its components REFUSED; ';
  -- A project's later move does not move the budget.
  UPDATE vendor_projects SET target_date = '${FY + 1}-03-31', stage = 'on_hold' WHERE id = proj_b;
  IF (SELECT monthly_amounts_cents FROM budget_line_components WHERE budget_line_id = l5450 AND kind = 'project') <> ${arr(oct30k)} THEN RAISE EXCEPTION 'budget moved with project'; END IF;
  res := res || '4d project moved to next March: budgeted October unchanged; ';

  -- 5a) Contract with amount + dates only: calculated, labelled an assumption.
  INSERT INTO vendor_contracts (management_company_id, community_id, vendor_name_raw, service_category, annualized_amount, effective_date, end_date, status)
    VALUES (mc, cid, 'Rehearsal Landscape Co', 'landscape_maintenance', 61200, '${FY}-01-01', '${FY}-12-31', 'active') RETURNING id INTO vc_a;
  r := save_budget_line_plan(l5200, ${arr(assumed.monthly)}, 'contract', ${js({ assumption: true, confirmed_by: null, confirmed_at: null, explanation: assumed.explanation })} || jsonb_build_object('vendor_contract_id', vc_a), 'calculated', 'Landscape contract', NULL,
    jsonb_build_array(jsonb_build_object('name', 'Landscape contract', 'kind', 'contract', 'vendor_contract_id', vc_a, 'vendor_name', 'Rehearsal Landscape Co', 'monthly_amounts_cents', ${js(assumed.monthly)}, 'schedule_basis', 'calculated', 'schedule_settings', ${js({ assumption: true })})));
  IF (SELECT annual_amount_cents FROM budget_line_items WHERE id = l5200) <> 6120000 OR (SELECT schedule_basis FROM budget_line_items WHERE id = l5200) <> 'calculated'
     OR (SELECT (phasing_settings->>'assumption')::boolean FROM budget_line_items WHERE id = l5200) IS NOT TRUE THEN RAISE EXCEPTION 'assumed contract not recorded as assumption'; END IF;
  res := res || '5a 5200 contract (amount+dates only): ' || array_to_string((SELECT monthly_amounts_cents FROM budget_line_items WHERE id = l5200), ',') || ' basis=calculated, assumption=true, unconfirmed; ';
  -- 5b) Contract whose document carries a schedule: documented.
  INSERT INTO vendor_contracts (management_company_id, community_id, vendor_name_raw, service_category, annualized_amount, effective_date, end_date, status, extracted_data)
    VALUES (mc, cid, 'Rehearsal Pool Co', 'pool_management', 57000, '${FY}-01-01', '${FY}-12-31', 'active', ${js({ payment_schedule: sched })}) RETURNING id INTO vc_b;
  r := save_budget_line_plan(l5320, ${arr(documented.monthly)}, 'contract', ${js({ assumption: false, explanation: documented.explanation })} || jsonb_build_object('vendor_contract_id', vc_b), 'documented', 'Pool contract (documented schedule)', NULL, NULL);
  IF (SELECT schedule_basis FROM budget_line_items WHERE id = l5320) <> 'documented' THEN RAISE EXCEPTION 'documented contract not recorded'; END IF;
  res := res || '5b 5320 contract with documented schedule: ' || array_to_string((SELECT monthly_amounts_cents FROM budget_line_items WHERE id = l5320), ',') || ' basis=documented; ';

  -- 6) Locks: approve the rehearsal budget; nothing on it can change.
  UPDATE community_budgets SET status = 'approved' WHERE id = db;
  ok := false; BEGIN PERFORM save_budget_line_plan(l5030, ${arr(even5030.monthly)}, 'even', NULL, 'calculated', NULL, NULL, NULL); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%only draft%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'plan save on approved budget allowed'; END IF;
  ok := false; BEGIN UPDATE budget_line_components SET name = 'x' WHERE budget_line_id = l5450; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'component edit on approved allowed'; END IF;
  ok := false; BEGIN DELETE FROM budget_line_components WHERE budget_line_id = l5450; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'component delete on approved allowed'; END IF;
  ok := false; BEGIN INSERT INTO budget_line_components (budget_line_id, budget_id, name, kind, monthly_amounts_cents) VALUES (l5030, db, 'x', 'other', ${arr(Array(12).fill(0))}); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'component insert on approved allowed'; END IF;
  ok := false; BEGIN UPDATE budget_line_items SET phasing_method = 'even' WHERE id = l5030; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'line phasing edit on approved allowed'; END IF;
  SELECT b.id INTO l_fy26 FROM budget_line_items b WHERE b.budget_id = src LIMIT 1;
  ok := false; BEGIN INSERT INTO budget_line_components (budget_line_id, budget_id, name, kind, monthly_amounts_cents) VALUES (l_fy26, src, 'x', 'other', ${arr(Array(12).fill(0))}); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'component on LOPF FY2026 allowed'; END IF;
  ok := false; BEGIN PERFORM save_budget_line_plan(l_fy26, ${arr(Array(12).fill(0))}, 'even', NULL, NULL, NULL, NULL, NULL); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%only draft%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'plan save on LOPF FY2026 allowed'; END IF;
  res := res || '6 approved: plan save, component edit/delete/insert, line phasing edit all REFUSED; LOPF FY2026 component + plan save REFUSED; ';

  -- 7) Nothing real moved (checked before the rollback).
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h1 FROM budget_line_items WHERE budget_id = src;
  IF h1 <> h0 OR h0 <> 'd246598beacc61cab198e7a89bae5074' THEN RAISE EXCEPTION 'LOPF FY2026 changed'; END IF;
  FOREACH tb IN ARRAY ARRAY['journal_entries','journal_entry_lines','property_ownerships','homeowner_transactions','homeowner_payment_applications','ar_charges','ap_invoices','vendor_invoices','contacts'] LOOP
    IF to_regclass('public.' || tb) IS NOT NULL THEN EXECUTE format('SELECT %L || '':'' || count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' ORDER BY t.id), '''')) FROM %I t', tb, tb) INTO x; fp1 := fp1 || x || ';'; END IF;
  END LOOP;
  IF position(fp1 in fp0) <> 1 THEN RAISE EXCEPTION 'GL / AR / AP / ownership / homeowner data changed'; END IF;
  res := res || '7 LOPF FY2026 hash ' || h0 || ' unchanged; journals, ownership, homeowner transactions, AR, AP, contacts unchanged';
  RAISE EXCEPTION 'REHEARSAL_OK %', res;
END
$t$;
`;
const out = mig.slice(0, cut) + tests;
fs.writeFileSync(path.join(ROOT, 'tests/sql/464_budget_monthly_plan_rehearsal.sql'), out);
console.log(out.length, require('crypto').createHash('sha256').update(out).digest('hex'));
console.log(JSON.stringify({ even5030: even5030.monthly, oct30k, rec3k, line5450, assumed: assumed.monthly, documented: documented.monthly }));
