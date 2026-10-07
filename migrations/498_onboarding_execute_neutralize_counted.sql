-- ============================================================================
-- 498_onboarding_execute_neutralize_counted.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- Canyon Gate's approved conversion (CONV-CGACR-20260731) was refused at EXECUTE:
-- "35 of 40 entries to neutralize are unchanged since the preflight". The 5 are
-- the originals of void pairs that straddle the cutoff (entry on/before 7/31, void
-- reversal after it). Such an original is status 'voided' with its reversal, and it
-- COUNTS in the GL (the rule EXECUTE itself uses for the trial balance and the
-- post-cutover fingerprint). The neutralize precondition alone demanded 'posted'.
--
-- Fix: the neutralize precondition accepts exactly the counted entries (posted, or
-- voided with a reversal). Date, total and line-count checks are unchanged. Nothing
-- else in onboarding_execute changes (the body is 488's, verbatim, but for that
-- predicate). The rejected attempt rolled back fully; no rows change here.
-- Record ownership: workpaper (unchanged).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION onboarding_execute(p_batch UUID, p_completion UUID, p_preflight_sha256 TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE
  bt conversion_batches%ROWTYPE; c onboarding_stage_events%ROWTYPE; ex onboarding_executions%ROWTYPE;
  rep JSONB; plan JSONB; w JSONB; pre JSONB; ab JSONB; r JSONB; proof_plan JSONB;
  code TEXT; comm UUID; cutoff DATE; cutover DATE; why TEXT; bad TEXT; prov TEXT;
  appr UUID; adv UUID; done UUID; ar_batch UUID := gen_random_uuid(); row_id UUID; je UUID;
  exec_id UUID := gen_random_uuid(); n BIGINT; v BIGINT; i INT;
  n_open INT; n_neut INT; n_repost INT; n_sup INT; n_rev INT; n_ar INT; n_ap INT; n_post BIGINT;
  ar_recv BIGINT; ar_cur BIGINT; ar_prior BIGINT; counts JSONB; proof JSONB; controls JSONB; old_cutover DATE;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, TRUE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS NULL THEN RAISE EXCEPTION 'onboarding: no such engine batch' USING ERRCODE = 'check_violation'; END IF;

  -- Idempotent retry: a committed execution is returned, never repeated.
  SELECT * INTO ex FROM onboarding_executions WHERE batch_id = p_batch AND status = 'committed';
  IF FOUND THEN
    IF ex.preflight_completion_id = p_completion AND ex.preflight_sha256 = p_preflight_sha256 THEN
      RETURN jsonb_build_object('status', 'already_executed', 'execution_id', ex.id, 'execute_completion_id', ex.execute_completion_id,
                                'write_counts', ex.write_counts, 'proof', ex.proof, 'rows_written_now', 0);
    END IF;
    RAISE EXCEPTION 'onboarding: execute refused: this batch was already executed (execution %) from another preflight', ex.id USING ERRCODE = 'check_violation';
  END IF;
  IF bt.onboarding_stage <> 'preflight' THEN
    RAISE EXCEPTION 'onboarding: execute refused: execute starts from the preflight stage; the batch is in %', bt.onboarding_stage USING ERRCODE = 'check_violation';
  END IF;

  -- The exact CURRENT preflight result, approved by a human for exactly this hash.
  SELECT * INTO c FROM onboarding_stage_events WHERE id = p_completion AND batch_id = p_batch AND event_type = 'stage_completed' AND stage = 'preflight';
  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: execute refused: not a preflight result of this batch' USING ERRCODE = 'check_violation'; END IF;
  why := onboarding_completion_gate(c.id);
  IF why IS NOT NULL THEN RAISE EXCEPTION 'onboarding: execute refused: %', why USING ERRCODE = 'check_violation'; END IF;
  IF p_preflight_sha256 IS NULL OR bt.approved_preflight_sha256 IS DISTINCT FROM p_preflight_sha256 THEN
    RAISE EXCEPTION 'onboarding: execute refused: % is not the approved preflight hash', coalesce(p_preflight_sha256, '(none)') USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO appr FROM onboarding_stage_events WHERE batch_id = p_batch AND event_type = 'preflight_approved' AND actor_kind = 'human'
     AND completion_event_id = c.id AND preflight_sha256 = p_preflight_sha256 ORDER BY seq DESC LIMIT 1;
  IF appr IS NULL THEN RAISE EXCEPTION 'onboarding: execute refused: no human approval of that hash for the current preflight result' USING ERRCODE = 'check_violation'; END IF;
  rep := c.result->'summary'->'preflight_report';
  IF rep IS NULL OR rep->>'format' IS DISTINCT FROM 'trusted.onboarding.preflight/v2' OR rep->'plan'->'writes' IS NULL THEN
    RAISE EXCEPTION 'onboarding: execute refused: the preflight result carries no conversion write contract' USING ERRCODE = 'check_violation';
  END IF;
  IF rep->'batch'->>'batch_code' IS DISTINCT FROM bt.batch_code THEN RAISE EXCEPTION 'onboarding: execute refused: the report is for another batch' USING ERRCODE = 'check_violation'; END IF;
  -- Without waivers the approved hash IS the recorded report's hash. (With waivers the approved report
  -- carries their dispositions; the service rebuilds and compares it before calling.)
  IF NOT EXISTS (SELECT 1 FROM onboarding_stage_events wv WHERE wv.completion_event_id = c.id AND wv.event_type = 'control_waived')
     AND c.result->'summary'->>'preflight_sha256' IS DISTINCT FROM p_preflight_sha256 THEN
    RAISE EXCEPTION 'onboarding: execute refused: the approved hash is not the recorded preflight report' USING ERRCODE = 'check_violation';
  END IF;

  plan := rep->'plan'; w := plan->'writes'; pre := plan->'preconditions'; ab := w->'ar_opening_batch'; proof_plan := plan->'proof_plan';
  code := bt.batch_code; comm := bt.community_id; cutoff := (plan->>'cutoff')::date; cutover := (plan->>'cutover')::date;
  IF cutoff IS DISTINCT FROM bt.as_of_date OR cutover IS DISTINCT FROM cutoff + 1 OR (w->'cutover_date'->>'to')::date IS DISTINCT FROM cutover THEN
    RAISE EXCEPTION 'onboarding: execute refused: the plan''s cutoff/cutover does not match the batch' USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------- preconditions (live)
  IF NOT (bt.status IN (SELECT jsonb_array_elements_text(pre->'batch_status_in'))) THEN
    RAISE EXCEPTION 'onboarding: execute refused: batch status % is not postable', bt.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO n FROM journal_entries WHERE community_id = comm AND left(reference, length(code)) = code;
  IF n <> 0 THEN RAISE EXCEPTION 'onboarding: execute refused: % journal entr(ies) with reference % already exist', n, code || '*' USING ERRCODE = 'check_violation'; END IF;
  SELECT gl_cutover_date INTO old_cutover FROM communities WHERE id = comm;
  IF old_cutover IS DISTINCT FROM (pre->>'gl_cutover_date_is')::date THEN
    RAISE EXCEPTION 'onboarding: execute refused: the GL cutover date is %, the plan expected %', old_cutover, pre->>'gl_cutover_date_is' USING ERRCODE = 'check_violation';
  END IF;
  n_sup := jsonb_array_length(w->'supersede_journal_entries');
  SELECT count(*) INTO n FROM jsonb_array_elements(w->'supersede_journal_entries') x
    JOIN journal_entries j ON j.id = (x->>'id')::uuid AND j.community_id = comm AND j.status = 'posted';
  IF n <> n_sup OR n_sup <> (pre->'supersede_set'->>'count')::int THEN
    RAISE EXCEPTION 'onboarding: execute refused: % of % entries to supersede are still posted', n, n_sup USING ERRCODE = 'check_violation';
  END IF;
  n_neut := jsonb_array_length(w->'neutralize_journal_entries');
  SELECT count(*) INTO n FROM jsonb_array_elements(w->'neutralize_journal_entries') x
    -- 498: a neutralize target is any COUNTED entry (posted, or voided with its reversal: the same rule as the
    -- trial balance above and below). A void pair straddling the cutoff has a voided original that still counts.
    JOIN journal_entries j ON j.id = (x->>'original_je_id')::uuid AND j.community_id = comm
     AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))
     AND j.posting_date = (x->>'posting_date')::date AND j.total_debits_cents = (x->>'total_debits_cents')::bigint
     AND (SELECT count(*) FROM journal_entry_lines jl WHERE jl.journal_entry_id = j.id) = jsonb_array_length(x->'lines');
  IF n <> n_neut OR n_neut <> (pre->'neutralize_set'->>'count')::int THEN
    RAISE EXCEPTION 'onboarding: execute refused: % of % entries to neutralize are unchanged since the preflight', n, n_neut USING ERRCODE = 'check_violation';
  END IF;
  n_repost := jsonb_array_length(w->'repost_journal_entries');
  n_rev := jsonb_array_length(w->'revert_ar_batches');
  SELECT count(*) INTO n FROM jsonb_array_elements(w->'revert_ar_batches') x
    JOIN transaction_upload_batches t ON t.id = (x->>'id')::uuid AND t.community_id = comm AND t.status = 'committed';
  IF n <> n_rev THEN RAISE EXCEPTION 'onboarding: execute refused: % of % legacy ledger batches are still committed', n, n_rev USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*), coalesce(sum(total_debits_cents), 0) INTO n, v FROM journal_entries
   WHERE community_id = comm AND posting_date >= cutover AND (status = 'posted' OR (status = 'voided' AND void_reversal_je_id IS NOT NULL));
  IF n <> (pre->'post_cutover_entries'->>'count')::bigint OR v <> (pre->'post_cutover_entries'->>'debits_cents')::bigint THEN
    RAISE EXCEPTION 'onboarding: execute refused: post-cutover activity changed since the preflight (% entries, % debits)', n, v USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(x->>'reference', ', ') INTO bad
    FROM (SELECT x FROM jsonb_array_elements(w->'opening_journal_entries') x UNION ALL SELECT x FROM jsonb_array_elements(w->'neutralize_journal_entries') x
          UNION ALL SELECT x FROM jsonb_array_elements(w->'repost_journal_entries') x) q
   WHERE NOT EXISTS (SELECT 1 FROM accounting_periods p WHERE p.id = (x->>'period_id')::uuid AND p.community_id = comm
                       AND p.period_start <= (x->>'posting_date')::date AND p.period_end >= (x->>'posting_date')::date AND p.status IN ('open','reopened'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'onboarding: execute refused: no open accounting period for %', bad USING ERRCODE = 'check_violation'; END IF;

  -- ------------------------------------------------- enter execute; the write lock opens
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id)
  VALUES (p_batch, 'stage_advanced', 'preflight', 'execute', c.id, 'human', p_actor_id)      -- validate trigger: next stage, latest result, gate
  RETURNING id INTO adv;
  UPDATE conversion_batches SET onboarding_stage = 'execute', write_locked = FALSE WHERE id = p_batch;   -- guard: human advance + approved hash for this result
  prov := format('onboarding %s · batch %s · preflight %s · execution %s', code, p_batch, c.id, exec_id);

  -- ---------------------------------------------------------------- journal entries
  n_open := jsonb_array_length(w->'opening_journal_entries');
  FOR r IN SELECT x FROM jsonb_array_elements(w->'opening_journal_entries') x LOOP PERFORM onboarding_exec_post_je(exec_id, p_batch, comm, r, 'opening_je', prov); END LOOP;
  FOR r IN SELECT x FROM jsonb_array_elements(w->'neutralize_journal_entries') x LOOP PERFORM onboarding_exec_post_je(exec_id, p_batch, comm, r, 'neutralize_je', prov); END LOOP;
  FOR r IN SELECT x FROM jsonb_array_elements(w->'repost_journal_entries') x LOOP PERFORM onboarding_exec_post_je(exec_id, p_batch, comm, r, 'repost_je', prov); END LOOP;

  FOR r IN SELECT x FROM jsonb_array_elements(w->'supersede_journal_entries') x LOOP
    UPDATE journal_entries SET status = 'superseded', superseded_at = now(), superseded_by_conversion = code,
           superseded_reason = (r->'set'->>'superseded_reason') || ' [' || prov || ']'
     WHERE id = (r->>'id')::uuid AND community_id = comm AND status = 'posted';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'onboarding execute: % could not be superseded', r->>'id' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, before, after)
    VALUES (exec_id, p_batch, 'journal_entries', (r->>'id')::uuid, 'update', 'supersede_je', r->>'reference', jsonb_build_object('status', 'posted'), jsonb_build_object('status', 'superseded'));
  END LOOP;

  -- ------------------------------------------------------------ homeowner ledger
  n_ar := jsonb_array_length(ab->'rows');
  INSERT INTO transaction_upload_batches (id, management_company_id, community_id, period_label, as_of_date, source_filename, source_format, row_count, account_count,
                                          total_charges_cents, total_payments_cents, status, uploaded_by, committed_at, min_transaction_date, max_transaction_date, notes)
  VALUES (ar_batch, (ab->>'management_company_id')::uuid, comm, ab->>'period_label', (ab->>'as_of_date')::date, ab->>'key', 'manual', n_ar, (ab->>'account_count')::int,
          (SELECT coalesce(sum((x->>'amount_cents')::bigint), 0) FROM jsonb_array_elements(ab->'rows') x WHERE (x->>'amount_cents')::bigint > 0),
          (SELECT coalesce(-sum((x->>'amount_cents')::bigint), 0) FROM jsonb_array_elements(ab->'rows') x WHERE (x->>'amount_cents')::bigint < 0),
          'committed', ab->>'uploaded_by', now(), (ab->>'as_of_date')::date, (ab->>'as_of_date')::date, 'Conversion opening homeowner balances · ' || prov);
  INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
  VALUES (exec_id, p_batch, 'transaction_upload_batches', ar_batch, 'insert', 'ar_opening_batch', ab->>'key', jsonb_build_object('row_count', n_ar, 'status', 'committed'));
  i := 0;
  FOR r IN SELECT x FROM jsonb_array_elements(ab->'rows') x LOOP
    i := i + 1; row_id := gen_random_uuid();
    INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, tenure_id, transaction_date,
                                        description, txn_type, charge_category, amount_cents, raw_row_jsonb, notes)
    VALUES (row_id, ar_batch, i, comm, r->>'vantaca_account_id', (r->>'property_id')::uuid, (r->>'tenure_id')::uuid, (r->>'transaction_date')::date,
            r->>'description', r->>'txn_type', r->>'charge_category', (r->>'amount_cents')::bigint,
            coalesce(r->'raw_row', '{}'::jsonb) || jsonb_build_object('onboarding', jsonb_build_object('batch_id', p_batch, 'preflight_completion_id', c.id, 'execution_id', exec_id,
                                                   'source_line_no', r->'source_line_no', 'prior_owner', coalesce((r->>'prior_owner')::boolean, false))),
            'source line ' || coalesce(r->>'source_line_no', '?') || ' · ' || prov);
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'homeowner_transactions', row_id, 'insert', 'ar_opening_row', ab->>'key' || ':' || i,
            jsonb_build_object('vantaca_account_id', r->>'vantaca_account_id', 'amount_cents', (r->>'amount_cents')::bigint, 'prior_owner', coalesce((r->>'prior_owner')::boolean, false)));
  END LOOP;
  FOR r IN SELECT x FROM jsonb_array_elements(w->'revert_ar_batches') x LOOP
    UPDATE transaction_upload_batches SET status = 'reverted', reverted_at = now(), replaced_by_batch_id = ar_batch,
           reverted_reason = (r->'set'->>'reverted_reason') || ' [' || prov || ']'
     WHERE id = (r->>'id')::uuid AND community_id = comm AND status = 'committed';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'onboarding execute: legacy ledger batch % could not be reverted', r->>'id' USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, before, after)
    VALUES (exec_id, p_batch, 'transaction_upload_batches', (r->>'id')::uuid, 'update', 'revert_ar_batch', r->>'id', jsonb_build_object('status', 'committed'), jsonb_build_object('status', 'reverted', 'replaced_by_batch_id', ar_batch));
  END LOOP;

  -- -------------------------------------------------------------- open AP invoices
  n_ap := jsonb_array_length(w->'ap_opening_invoices');
  FOR r IN SELECT x FROM jsonb_array_elements(w->'ap_opening_invoices') x LOOP
    SELECT id INTO je FROM journal_entries WHERE community_id = comm AND reference = r->>'posting_journal_entry_reference';
    IF je IS NULL THEN RAISE EXCEPTION 'onboarding execute: AP invoice posting entry % was not written', r->>'posting_journal_entry_reference' USING ERRCODE = 'check_violation'; END IF;
    row_id := gen_random_uuid();
    INSERT INTO ap_invoices (id, community_id, vendor_id, vendor_invoice_number, invoice_date, subtotal_cents, total_cents, amount_paid_cents, status, posting_journal_entry_id, notes)
    VALUES (row_id, comm, (r->>'vendor_id')::uuid, r->>'vendor_invoice_number', (r->>'invoice_date')::date, (r->>'subtotal_cents')::bigint, (r->>'total_cents')::bigint,
            (r->>'amount_paid_cents')::bigint, r->>'status', je, 'Conversion opening AP; key ' || (r->>'idempotency_key') || ' · ' || prov);
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'ap_invoices', row_id, 'insert', 'ap_opening_invoice', r->>'idempotency_key', jsonb_build_object('total_cents', (r->>'total_cents')::bigint, 'posting_journal_entry_id', je));
  END LOOP;

  -- ------------------------------------------------------------------ cutover date
  UPDATE communities SET gl_cutover_date = cutover WHERE id = comm AND gl_cutover_date IS NOT DISTINCT FROM old_cutover;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'onboarding execute: the GL cutover date could not be set' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, before, after)
  VALUES (exec_id, p_batch, 'communities', comm, 'update', 'cutover_date', 'gl_cutover_date', jsonb_build_object('gl_cutover_date', old_cutover), jsonb_build_object('gl_cutover_date', cutover));

  -- -------------------------------------------------- VERIFY (mismatch -> rollback)
  bad := onboarding_exec_tb_diff(comm, cutoff, (SELECT x->'expected' FROM jsonb_array_elements(proof_plan) x WHERE x->>'check' = 'cutoff_trial_balance'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'onboarding execute: cutoff trial balance does not equal the source: %', bad USING ERRCODE = 'check_violation'; END IF;
  bad := onboarding_exec_tb_diff(comm, NULL, (SELECT x->'expected' FROM jsonb_array_elements(proof_plan) x WHERE x->>'check' = 'current_trial_balance'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'onboarding execute: current trial balance does not equal the projection: %', bad USING ERRCODE = 'check_violation'; END IF;
  SELECT coalesce(sum(amount_cents) FILTER (WHERE txn_type <> 'credit'), 0),
         coalesce(sum(amount_cents) FILTER (WHERE txn_type = 'credit' AND NOT coalesce((raw_row_jsonb->'onboarding'->>'prior_owner')::boolean, false)), 0),
         coalesce(sum(amount_cents) FILTER (WHERE txn_type = 'credit' AND coalesce((raw_row_jsonb->'onboarding'->>'prior_owner')::boolean, false)), 0)
    INTO ar_recv, ar_cur, ar_prior FROM homeowner_transactions WHERE source_batch_id = ar_batch;
  IF ar_recv <> (ab->>'receivable_cents')::bigint OR ar_cur <> (ab->>'current_owner_prepaid_cents')::bigint OR ar_prior <> (ab->>'prior_owner_credit_cents')::bigint THEN
    RAISE EXCEPTION 'onboarding execute: homeowner ledger (% / % / %) does not equal the plan', ar_recv, ar_cur, ar_prior USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), coalesce(sum(total_debits_cents), 0) INTO n_post, v FROM journal_entries
   WHERE community_id = comm AND posting_date >= cutover AND left(reference, length(code)) <> code
     AND (status = 'posted' OR (status = 'voided' AND void_reversal_je_id IS NOT NULL));
  IF n_post <> (pre->'post_cutover_entries'->>'count')::bigint OR v <> (pre->'post_cutover_entries'->>'debits_cents')::bigint THEN
    RAISE EXCEPTION 'onboarding execute: post-cutover entries changed during execute' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO n FROM journal_entries WHERE community_id = comm AND left(reference, length(code)) = code;
  IF n <> n_open + n_neut + n_repost THEN RAISE EXCEPTION 'onboarding execute: % conversion entries written, % planned', n, n_open + n_neut + n_repost USING ERRCODE = 'check_violation'; END IF;
  counts := jsonb_build_object('opening_journal_entries', n_open, 'neutralize_journal_entries', n_neut, 'repost_journal_entries', n_repost,
                               'supersede_journal_entries', n_sup, 'revert_ar_batches', n_rev, 'ar_opening_rows', n_ar, 'ap_opening_invoices', n_ap);
  IF counts IS DISTINCT FROM (SELECT jsonb_build_object('opening_journal_entries', (s->>'opening_journal_entries')::int, 'neutralize_journal_entries', (s->>'neutralize_journal_entries')::int,
        'repost_journal_entries', (s->>'repost_journal_entries')::int, 'supersede_journal_entries', (s->>'supersede_journal_entries')::int, 'revert_ar_batches', (s->>'revert_ar_batches')::int,
        'ar_opening_rows', (s->>'ar_opening_rows')::int, 'ap_opening_invoices', (s->>'ap_opening_invoices')::int) FROM (SELECT plan->'summary' AS s) q) THEN
    RAISE EXCEPTION 'onboarding execute: write counts % do not equal the plan', counts USING ERRCODE = 'check_violation';
  END IF;
  proof := jsonb_build_object('cutoff_trial_balance', 'equal', 'current_trial_balance', 'equal', 'ar_receivable_cents', ar_recv, 'ar_current_owner_prepaid_cents', ar_cur,
                              'ar_prior_owner_credit_cents', ar_prior, 'post_cutover_entries_unchanged', n_post, 'cutover_date', cutover, 'write_counts', counts);
  controls := jsonb_build_array(
    jsonb_build_object('code', 'execute.preconditions_held', 'label', 'Every recorded precondition held against live data at execute time', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.cutoff_tb_equals_source', 'label', 'Trusted TB at the cutoff equals the source TB on every account', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.current_tb_equals_projection', 'label', 'Trusted TB through today equals the projected TB', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.homeowner_ledger_equals_plan', 'label', 'Homeowner ledger receivables / prepaids / prior-owner credits equal the plan', 'status', 'PASS', 'level', 'execute',
                       'left_cents', ar_recv, 'right_cents', (ab->>'receivable_cents')::bigint, 'difference_cents', 0),
    jsonb_build_object('code', 'execute.post_cutover_unchanged', 'label', 'Every post-cutover entry is unchanged', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.write_counts_equal_plan', 'label', 'Exactly the planned rows were written', 'status', 'PASS', 'level', 'execute'));

  -- ------------------------------------- execute result, batch posted, lock closed
  done := onboarding_record_completion(p_batch, 'execute', 'PASS', '[]'::jsonb, controls,
            jsonb_build_object('execution_id', exec_id, 'preflight_completion_id', c.id, 'preflight_sha256', p_preflight_sha256, 'write_counts', counts, 'proof', proof),
            p_actor_kind, p_actor_id);
  UPDATE conversion_batches SET status = 'posted', write_locked = TRUE,
         notes = coalesce(notes || ' ', '') || 'posted by ' || prov WHERE id = p_batch;
  INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, before, after)
  VALUES (exec_id, p_batch, 'conversion_batches', p_batch, 'update', 'conversion_batch', code, jsonb_build_object('status', bt.status), jsonb_build_object('status', 'posted'));
  INSERT INTO onboarding_executions (id, batch_id, community_id, status, preflight_completion_id, preflight_sha256, approval_event_id, advance_event_id, execute_completion_id,
                                     actor_kind, actor_id, write_counts, proof, proof_plan)
  VALUES (exec_id, p_batch, comm, 'committed', c.id, p_preflight_sha256, appr, adv, done, p_actor_kind, p_actor_id, counts, proof, coalesce(proof_plan, '[]'::jsonb));
  RETURN jsonb_build_object('status', 'executed', 'execution_id', exec_id, 'execute_completion_id', done, 'write_counts', counts, 'proof', proof,
                            'rows_written_now', (SELECT count(*) FROM onboarding_execution_writes WHERE execution_id = exec_id));
END;
$fn$;

COMMIT;
