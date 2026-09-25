// Builds tests/sql/466_recognition_rehearsal.sql: migration 466 (without COMMIT) +
// a synthetic-community test block that ends in RAISE 'REHEARSAL_OK ...', so the
// whole thing rolls back. Nothing persists. LOPF is only read (plus a rolled-back
// forecast line + schedule with no postings).
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '466_recognition_schedules_controls.sql'), 'utf8').replace(/\r\n/g, '\n');
const cut = mig.indexOf('\nCOMMIT;\n');
if (cut < 0) throw new Error('COMMIT not found');
const body = mig.slice(0, cut + 1);

const tests = `
CREATE FUNCTION pg_temp.gl(p_account uuid) RETURNS bigint LANGUAGE sql AS $fn$
  SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
  FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
  WHERE l.account_id = p_account AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))
$fn$;

DO $t$
DECLARE
  lopf uuid; mc uuid; lbid uuid; h0 text; h1 text; je0 text; jel0 text;
  cid uuid; fop uuid; a1000 uuid; a1300 uuid; a1400 uuid; a2000 uuid; a2205 uuid; a4000 uuid; a5600 uuid; p1 uuid;
  jb uuid; ji uuid; sa uuid; si uuid; sr uuid; sd uuid; sx uuid; pid uuid; rid uuid; oj uuid; rj uuid;
  l2205 uuid; l4000 uuid; l5600 uuid; lsid uuid; lfid uuid; lpost bigint;
  m int; n int; x bigint; ok boolean; res text := '';
BEGIN
  SELECT id, management_company_id INTO lopf, mc FROM communities WHERE name = 'Lakes of Pine Forest';
  SELECT id INTO lbid FROM community_budgets WHERE community_id = lopf AND fiscal_year = 2026;
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h0 FROM budget_line_items WHERE budget_id = lbid;
  SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) INTO je0 FROM journal_entries WHERE community_id = lopf;
  SELECT count(*)::text || ':' || sum(l.debit_cents)::text || ':' || sum(l.credit_cents)::text INTO jel0 FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = lopf;
  PERFORM set_config('trusted.actor', 'rehearsal@test', true);

  -- synthetic community + books
  INSERT INTO communities (name, management_company_id) VALUES ('REHEARSAL 466 (synthetic)', mc) RETURNING id INTO cid;
  INSERT INTO account_funds (community_id, fund_code, fund_name, fund_type) VALUES (cid, 'OP', 'Operating', 'operating') RETURNING id INTO fop;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '1000', 'Operating Cash', 'asset', 'debit', fop, true, false) RETURNING id INTO a1000;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '1300', 'Accounts Receivable', 'asset', 'debit', fop, true, false) RETURNING id INTO a1300;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '1400', 'Prepaid Insurance', 'asset', 'debit', fop, true, false) RETURNING id INTO a1400;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '2000', 'Accounts Payable', 'liability', 'credit', fop, true, false) RETURNING id INTO a2000;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '2205', 'Unearned Assessments', 'liability', 'credit', fop, true, false) RETURNING id INTO a2205;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '4000', 'Assessment Income', 'revenue', 'credit', fop, true, false) RETURNING id INTO a4000;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '5600', 'Insurance', 'expense', 'debit', fop, true, false) RETURNING id INTO a5600;
  INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status, period_type)
  SELECT cid, 2026, g, make_date(2026, g, 1), (make_date(2026, g, 1) + interval '1 month' - interval '1 day')::date, 'open', 'monthly' FROM generate_series(1, 12) g;
  SELECT id INTO p1 FROM accounting_periods WHERE community_id = cid AND period_number = 1;

  -- 1) annual assessment billed once, recognized monthly
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
  VALUES (cid, p1, '2026-01-01', 'REH-BILL-2026', '2026 annual assessment billed (deferred)', 'assessment_billing', 38969800, 38969800, 'posted') RETURNING id INTO jb;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES (jb, 1, a1300, fop, 38969800, 0), (jb, 2, a2205, fop, 0, 38969800);
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognize_amount_cents, start_month, term_months, monthly_amount_cents, period_start, period_end, source_type, source_journal_entry_id, created_by)
  VALUES (cid, 'deferred_revenue', '2026 annual assessments (synthetic)', '2205', 38969800, '2026-01-01', 12, 3247483, '2026-01-01', '2026-12-31', 'assessment_billing', jb, 'rehearsal@test') RETURNING id INTO sa;
  INSERT INTO recognition_schedule_segments (schedule_id, income_account_number, label, monthly_amount_cents) VALUES (sa, '4000', 'Assessment Income', 3247483);
  SELECT count(*), sum(scheduled_cents) INTO n, x FROM recognition_schedule_periods WHERE schedule_id = sa;
  IF n <> 12 OR x <> 38969800 OR (SELECT scheduled_cents FROM recognition_schedule_periods WHERE schedule_id = sa AND period_month = '2026-12-01') <> 3247487 THEN RAISE EXCEPTION 'assessment periods wrong'; END IF;
  FOR m IN 1 .. 9 LOOP PERFORM post_recognition_period(sa, make_date(2026, m, 1), 'rehearsal@test'); END LOOP;
  IF (SELECT sum(amount_cents) FROM recognition_postings WHERE schedule_id = sa) <> 29227347 THEN RAISE EXCEPTION 'assessment recognized wrong'; END IF;
  IF -pg_temp.gl(a4000) <> 29227347 OR -pg_temp.gl(a2205) <> 9742453 THEN RAISE EXCEPTION 'assessment GL wrong: 4000 % 2205 %', -pg_temp.gl(a4000), -pg_temp.gl(a2205); END IF;
  IF (SELECT remaining_cents FROM v_recognition_schedule_status WHERE schedule_id = sa) <> 9742453 THEN RAISE EXCEPTION 'view remaining wrong'; END IF;
  res := res || '1 assessment $389,698.00 billed once: 12 months tie (11 x $32,474.83 + $32,474.87), Jan-Sep recognized $292,273.47 in 4000, 2205 remaining $97,424.53 = schedule remaining; ';

  -- 2) prepaid insurance: draft -> approved -> amortized
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
  VALUES (cid, p1, '2026-01-01', 'REH-INS-2026', 'Annual GL premium paid (prepaid)', 'manual', 2400000, 2400000, 'posted') RETURNING id INTO ji;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES (ji, 1, a1400, fop, 2400000, 0), (ji, 2, a2000, fop, 0, 2400000);
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, period_start, period_end, status, source_type, source_journal_entry_id, schedule_basis, created_by)
  VALUES (cid, 'prepaid_expense', 'GL policy 2026 (synthetic)', '1400', a5600, 2400000, '2026-01-01', 12, 200000, '2026-01-01', '2026-12-31', 'draft', 'manual', ji, 'documented', 'rehearsal@test') RETURNING id INTO si;
  ok := false; BEGIN PERFORM post_recognition_period(si, '2026-01-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%only an active schedule%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'draft schedule posted'; END IF;
  ok := false; BEGIN UPDATE recognition_schedules SET status = 'active' WHERE id = si; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%who approved%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'approval without approver allowed'; END IF;
  UPDATE recognition_schedules SET status = 'active', approved_by = 'rehearsal@test', approved_at = now() WHERE id = si;
  ok := false; BEGIN UPDATE recognition_schedules SET recognize_amount_cents = 2500000 WHERE id = si; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%fixed%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'approved schedule edited'; END IF;
  ok := false; BEGIN UPDATE recognition_schedule_periods SET scheduled_cents = 1 WHERE schedule_id = si AND period_month = '2026-12-01'; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%fixed%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'approved months edited'; END IF;
  FOR m IN 1 .. 9 LOOP PERFORM post_recognition_period(si, make_date(2026, m, 1), 'rehearsal@test'); END LOOP;
  IF pg_temp.gl(a5600) <> 1800000 OR pg_temp.gl(a1400) <> 600000 THEN RAISE EXCEPTION 'insurance GL wrong: 5600 % 1400 %', pg_temp.gl(a5600), pg_temp.gl(a1400); END IF;
  IF (SELECT remaining_cents FROM v_recognition_schedule_status WHERE schedule_id = si) <> 600000 THEN RAISE EXCEPTION 'insurance remaining wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recognition_events WHERE schedule_id = si AND event = 'approved' AND actor = 'rehearsal@test') THEN RAISE EXCEPTION 'approval not logged'; END IF;
  res := res || '2 insurance $24,000 prepaid 1/1: after Sep 5600 expense $18,000, 1400 prepaid $6,000 = schedule remaining; draft cannot post, approval needs approver, approved amounts/months fixed; ';

  -- 3) rounding
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, created_by)
  VALUES (cid, 'deferred_revenue', 'Rounding 1000.00 / 3 (synthetic)', '2205', a4000, 100000, '2026-01-01', 3, 33333, 'rehearsal@test') RETURNING id INTO sr;
  IF (SELECT string_agg(scheduled_cents::text, ',' ORDER BY period_month) FROM recognition_schedule_periods WHERE schedule_id = sr) <> '33333,33333,33334' THEN RAISE EXCEPTION 'straight-line rounding wrong'; END IF;
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, recognition_basis, recognition_method, period_start, period_end, created_by)
  VALUES (cid, 'deferred_revenue', 'Daily 1000.01 (synthetic)', '2205', a4000, 100001, '2026-02-01', 13, 7692, 'daily', 'daily', '2026-02-15', '2027-02-14', 'rehearsal@test') RETURNING id INTO sd;
  IF (SELECT sum(scheduled_cents) FROM recognition_schedule_periods WHERE schedule_id = sd) <> 100001 THEN RAISE EXCEPTION 'daily rounding wrong'; END IF;
  res := res || '3 rounding: $1,000.00/3 = 333.33+333.33+333.34; daily $1,000.01 over 2/15-2/14 ties exactly; ';

  -- 4) duplicates refused (function, direct row, and the GL itself)
  ok := false; BEGIN PERFORM post_recognition_period(si, '2026-09-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already recognized%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'duplicate month posted'; END IF;
  ok := false; BEGIN INSERT INTO recognition_postings (schedule_id, period_month, journal_entry_id, amount_cents) VALUES (si, '2026-10-01', ji, 200000); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%posted only by%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'direct posting row allowed'; END IF;
  ok := false; BEGIN
    INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference, total_debits_cents, total_credits_cents, status)
    SELECT cid, p1, '2026-01-01', 'REH-DUP', 'dup', 'recognition', source_reference, 200000, 200000, 'posted' FROM recognition_postings WHERE schedule_id = si AND period_month = '2026-09-01';
  EXCEPTION WHEN unique_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'GL accepted a second recognition journal for the same month'; END IF;
  res := res || '4 duplicate month REFUSED (function, direct row, and GL unique source ref); ';

  -- 5) above total / outside schedule refused
  ok := false; BEGIN PERFORM post_recognition_period(si, '2027-01-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not in this schedule%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'month outside schedule posted'; END IF;
  ok := false; BEGIN
    PERFORM set_config('trusted.recognition_periods', 'on', true);
    UPDATE recognition_schedule_periods SET scheduled_cents = 900000 WHERE schedule_id = si AND period_month = '2026-10-01';
    PERFORM set_config('trusted.recognition_periods', 'off', true);
    PERFORM post_recognition_period(si, '2026-10-01', 'rehearsal@test');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%exceed the schedule total%'; END;
  PERFORM set_config('trusted.recognition_periods', 'off', true);
  IF NOT ok THEN RAISE EXCEPTION 'recognition above total allowed'; END IF;
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, status, recognition_method, schedule_basis, created_by)
  VALUES (cid, 'prepaid_expense', 'Documented over-total (synthetic)', '1400', a5600, 1000, '2026-01-01', 2, 0, 'draft', 'documented_schedule', 'documented', 'rehearsal@test') RETURNING id INTO sx;
  INSERT INTO recognition_schedule_periods (schedule_id, period_month, scheduled_cents) VALUES (sx, '2026-01-01', 600), (sx, '2026-02-01', 500);
  ok := false; BEGIN
    UPDATE recognition_schedules SET status = 'active', approved_by = 'rehearsal@test', approved_at = now() WHERE id = sx;
    SET CONSTRAINTS trg_recognition_schedules_tie IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%must tie exactly%'; END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT ok THEN RAISE EXCEPTION 'documented months above total approved'; END IF;
  ok := false; BEGIN INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognize_amount_cents, start_month, term_months, monthly_amount_cents, recognition_method) VALUES (cid, 'prepaid_expense', 'x', '1400', 1000, '2026-01-01', 1, 1000, 'documented_schedule'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%created as draft%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'documented schedule created active'; END IF;
  res := res || '5 above total REFUSED (tampered month hits the cap; documented months over total cannot be approved; month outside schedule refused); ';

  -- 6) reversal: explicit, audited, then a clean re-post
  SELECT id, journal_entry_id INTO pid, oj FROM recognition_postings WHERE schedule_id = si AND period_month = '2026-09-01' AND kind = 'recognition';
  ok := false; BEGIN PERFORM reverse_recognition_posting(pid, '  ', 'rehearsal@test', '2026-09-30'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%needs a reason%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'reversal without reason allowed'; END IF;
  rid := reverse_recognition_posting(pid, 'Posted before the policy endorsement; re-post after review', 'rehearsal@test', '2026-09-30');
  SELECT journal_entry_id INTO rj FROM recognition_postings WHERE id = rid;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = rj AND source_module = 'reversal' AND reverses_je_id = oj AND status = 'posted')
  OR NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = oj AND status = 'voided' AND void_reversal_je_id = rj AND void_reason IS NOT NULL) THEN RAISE EXCEPTION 'reversal journals wrong'; END IF;
  IF (SELECT amount_cents FROM recognition_postings WHERE id = rid) <> -200000 OR (SELECT reversed_by_posting_id FROM recognition_postings WHERE id = pid) <> rid THEN RAISE EXCEPTION 'reversal rows wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recognition_events WHERE schedule_id = si AND event = 'reversed' AND actor = 'rehearsal@test' AND detail ->> 'reason' LIKE 'Posted before%') THEN RAISE EXCEPTION 'reversal not logged'; END IF;
  IF (SELECT recognized_cents FROM v_recognition_schedule_status WHERE schedule_id = si) <> 1600000 OR pg_temp.gl(a1400) <> 800000 OR pg_temp.gl(a5600) <> 1600000 THEN RAISE EXCEPTION 'after reversal wrong'; END IF;
  ok := false; BEGIN PERFORM reverse_recognition_posting(pid, 'again', 'rehearsal@test', '2026-09-30'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already reversed%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'double reversal allowed'; END IF;
  ok := false; BEGIN DELETE FROM recognition_postings WHERE id = pid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%permanent%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posting deleted'; END IF;
  ok := false; BEGIN UPDATE recognition_postings SET amount_cents = 1 WHERE id = pid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%posted only by%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posting edited'; END IF;
  ok := false; BEGIN UPDATE recognition_events SET actor = 'x' WHERE schedule_id = si; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%permanent%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'events edited'; END IF;
  PERFORM post_recognition_period(si, '2026-09-01', 'rehearsal@test');
  IF (SELECT recognized_cents FROM v_recognition_schedule_status WHERE schedule_id = si) <> 1800000 OR pg_temp.gl(a1400) <> 600000
  OR NOT EXISTS (SELECT 1 FROM recognition_postings WHERE schedule_id = si AND period_month = '2026-09-01' AND kind = 'recognition' AND reversed_by_posting_id IS NULL AND source_reference LIKE '%:2') THEN RAISE EXCEPTION 're-post after reversal wrong'; END IF;
  res := res || '6 reversal explicit (offset JE + original voided + reversal row + event with reason/actor), double/no-reason reversal, delete, edit REFUSED, re-post once OK; ';

  -- controls: closed period, cancel audit, no deletes, completion
  UPDATE accounting_periods SET status = 'closed' WHERE community_id = cid AND period_number = 10;
  ok := false; BEGIN PERFORM post_recognition_period(si, '2026-10-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%no open accounting period%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posted into a closed period'; END IF;
  ok := false; BEGIN UPDATE recognition_schedules SET status = 'cancelled' WHERE id = sd; EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'cancel without reason allowed'; END IF;
  ok := false; BEGIN DELETE FROM recognition_schedules WHERE id = sd; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not deleted%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'schedule deleted'; END IF;
  FOR m IN 1 .. 3 LOOP PERFORM post_recognition_period(sr, make_date(2026, m, 1), 'rehearsal@test'); END LOOP;
  IF (SELECT status FROM recognition_schedules WHERE id = sr) <> 'fully_recognized' OR NOT EXISTS (SELECT 1 FROM recognition_events WHERE schedule_id = sr AND event = 'completed') THEN RAISE EXCEPTION 'completion wrong'; END IF;
  ok := false; BEGIN PERFORM post_recognition_period(sr, '2026-03-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%fully_recognized%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posted past completion'; END IF;
  res := res || 'closed period REFUSED; cancel w/o reason REFUSED; schedule delete REFUSED; completion logged; ';

  -- 7) forecast uses the remaining recognition months (LOPF: read-only GL, rolled-back schedule + line)
  SELECT id INTO l2205 FROM chart_of_accounts WHERE community_id = lopf AND account_number = '2205';
  SELECT id INTO l4000 FROM chart_of_accounts WHERE community_id = lopf AND account_number = '4000';
  SELECT id INTO l5600 FROM chart_of_accounts WHERE community_id = lopf AND account_number = '5600';
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, period_start, period_end, source_type, created_by)
  VALUES (lopf, 'deferred_revenue', 'REHEARSAL: 2026 assessments, 7/31 unearned balance', '2205', l4000, 16237419, '2026-08-01', 5, 3247483, '2026-08-01', '2026-12-31', 'conversion_balance', 'rehearsal@test') RETURNING id INTO lsid;
  SELECT -pg_temp.gl(l4000) INTO lpost;
  IF lpost + (SELECT sum(scheduled_cents) FROM recognition_schedule_periods WHERE schedule_id = lsid) <> (SELECT annual_amount_cents FROM budget_line_items WHERE budget_id = lbid AND account_id = l4000) THEN
    RAISE EXCEPTION 'LOPF recognized + scheduled does not equal the approved levy';
  END IF;
  IF -pg_temp.gl(l2205) <> 16237419 THEN RAISE EXCEPTION 'LOPF 2205 balance is not the scheduled total'; END IF;
  INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month, created_by) VALUES (lopf, 2026, lbid, 9, 'rehearsal@test') RETURNING id INTO lfid;
  INSERT INTO forecast_lines (forecast_id, account_id, method, settings, remaining_months, updated_by)
  VALUES (lfid, l4000, 'recognition_schedule', jsonb_build_object('recognition_schedule_ids', jsonb_build_array(lsid)), ARRAY[0,0,0,0,0,0,0,0,0,9742449,3247483,3247487]::bigint[], 'rehearsal@test');
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, settings, remaining_months) VALUES (lfid, l5600, 'recognition_schedule', jsonb_build_object('recognition_schedule_ids', jsonb_build_array(lsid)), ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%does not recognize into%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'schedule for another account accepted'; END IF;
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, settings, remaining_months) VALUES (lfid, l5600, 'recognition_schedule', jsonb_build_object('recognition_schedule_ids', jsonb_build_array(si)), ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not found for this community%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'other community schedule accepted'; END IF;
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, remaining_months) VALUES (lfid, l5600, 'recognition_schedule', ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%names its schedules%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'recognition line without schedules accepted'; END IF;
  res := res || '7 forecast: LOPF 4000 recognized $227,323.81 + scheduled $162,374.19 (= 2205 balance) = approved levy $389,698.00; recognition_schedule line accepted, wrong account/community/no schedule REFUSED; ';

  -- 8) nothing real moved
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h1 FROM budget_line_items WHERE budget_id = lbid;
  IF h1 <> h0 OR h0 <> 'd246598beacc61cab198e7a89bae5074' THEN RAISE EXCEPTION 'LOPF approved budget changed'; END IF;
  IF je0 <> (SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) FROM journal_entries WHERE community_id = lopf)
  OR jel0 <> (SELECT count(*)::text || ':' || sum(l.debit_cents)::text || ':' || sum(l.credit_cents)::text FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = lopf) THEN RAISE EXCEPTION 'LOPF GL changed'; END IF;
  res := res || '8 LOPF approved budget hash ' || h0 || ' unchanged; LOPF GL unchanged';
  RAISE EXCEPTION 'REHEARSAL_OK %', res;
END
$t$;
`;

const out = body + tests;
for (const bad of ['${', '`', String.fromCharCode(92)]) if (out.includes(bad)) throw new Error('rehearsal contains ' + JSON.stringify(bad));
const dest = path.join(__dirname, '..', 'tests', 'sql', '466_recognition_rehearsal.sql');
fs.writeFileSync(dest, out);
console.log(out.length, crypto.createHash('sha256').update(out).digest('hex'), 'migration prefix chars', body.length);
