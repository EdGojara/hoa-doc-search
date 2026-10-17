-- ============================================================================
-- 536_conversion_execute_establishment.sql  (Ed 2026-10-17)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- EXECUTE learns the 535 conversion records. Source- and community-agnostic.
--
-- 1) IDENTITY-SAFE ESTABLISHMENT: conversion_source_identities (UNIQUE community + source
--    system + kind + external id; append-only): a re-run can never establish the same
--    source account twice. ownership_tenures accepts origin 'conversion'; the 459 guard
--    additionally lets onboarding_execute create exactly two shapes, under a transaction-
--    local flag: a legacy-owner record (kind legacy, no lot) and the FIRST owner tenure of a
--    lot that never had one (start NULL: never invented). No person / contact is created or
--    matched. Transfers still go only through approve_ownership_proposal.
-- 2) THE ADJUSTMENT AUDIT CHAIN: conversion_adjustment_applications (append-only): per
--    approved adjustment, the source position before, the approved lines + fingerprint, the
--    position after, and the GL measured at the cutoff inside EXECUTE.
-- 3) conversion_reconciling_items.kind also allows 'suspense_balance'; the execution write log
--    learns the new tables and kinds.
-- 4) onboarding_execute = the 501 body unchanged plus: (preconditions) the approved-objects
--    digest equals the preflight's, every applied adjustment is approved with the preflight's
--    fingerprint, no planned source identity exists yet, an old-format preflight is refused
--    when approved objects exist; (writes) post-opening adjustment entries, legacy-owner
--    records, initial ownership + identity, ledger rows on them; (verify, rolls back on any
--    mismatch) prior-owner rows only on legacy records, current-owner rows only on their
--    lot's current owner tenure, the audit chain, the new write counts.
--
-- ENFORCED BY THE DATABASE (this file): everything in 4); identities unique and permanent;
-- the tenure guard shapes; the audit chain permanent. NOT ENFORCEABLE HERE: who the human
-- actor is (application / session; see 535).
--
-- Record ownership: conversion_source_identities, conversion_adjustment_applications =
-- association_record (the association's roster links and the audit of its books).
-- Requires 501 (onboarding_execute with builder coverage), 504, 456 / 459 (tenures) and 535.
-- Changes no existing row.
-- ============================================================================
BEGIN;

DO $$ BEGIN
  IF to_regclass('conversion_adjustments') IS NULL OR to_regclass('conversion_reconciling_items') IS NULL
     OR to_regclass('ownership_tenures') IS NULL OR to_regprocedure('onboarding_execute(uuid,uuid,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '536 requires 535 (conversion records), 501 (builder coverage / reconciling items) and 456 (ownership tenures)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Identity-safe establishment + the tenure guard
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_source_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  source_system     text NOT NULL CHECK (length(btrim(source_system)) > 0),
  external_id_kind  text NOT NULL CHECK (external_id_kind IN ('account')),
  external_id       text NOT NULL CHECK (length(btrim(external_id)) > 0),
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id         uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  batch_id          uuid NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  execution_id      uuid,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversion_source_identity UNIQUE (community_id, source_system, external_id_kind, external_id)
);
DROP TRIGGER IF EXISTS trg_conversion_source_identities_append_only ON conversion_source_identities;
CREATE TRIGGER trg_conversion_source_identities_append_only BEFORE UPDATE OR DELETE ON conversion_source_identities FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
COMMENT ON TABLE conversion_source_identities IS 'association_record: a lot / ownership period the conversion established, keyed by source system + source account (unique per community: a re-run can never establish it twice).';

ALTER TABLE ownership_tenures DROP CONSTRAINT IF EXISTS ownership_tenures_origin_check;
ALTER TABLE ownership_tenures ADD CONSTRAINT ownership_tenures_origin_check CHECK (origin IN ('backfill_current','backfill_historical','backfill_legacy','transfer','conversion'));

-- 459 guard + the two conversion shapes (only inside onboarding_execute, transaction-local flag).
CREATE OR REPLACE FUNCTION ownership_tenures_transfer_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF coalesce(current_setting('trusted.ownership_transfer', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND coalesce(current_setting('trusted.onboarding_establish', true), '') = 'on' AND NEW.origin = 'conversion' THEN
    IF NEW.kind = 'legacy' AND NEW.property_id IS NULL AND NEW.end_date IS NULL THEN RETURN NEW; END IF;
    IF NEW.kind = 'owner' AND NEW.property_id IS NOT NULL AND NEW.end_date IS NULL
       AND NOT EXISTS (SELECT 1 FROM ownership_tenures t WHERE t.property_id = NEW.property_id AND t.kind = 'owner') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'a conversion creates only a legacy-owner record (no lot) or the first owner tenure of a lot that never had one';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'ownership tenures are created only by an approved ownership transfer (Ownership Review / Home Sales)';
  END IF;
  IF NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    RAISE EXCEPTION 'a tenure ends only through an approved ownership transfer (tenure %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_ownership_tenures_transfer_only ON ownership_tenures;
CREATE TRIGGER trg_ownership_tenures_transfer_only BEFORE INSERT OR UPDATE ON ownership_tenures
  FOR EACH ROW EXECUTE FUNCTION ownership_tenures_transfer_only();

-- ---------------------------------------------------------------------------
-- 2) The adjustment audit chain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_adjustment_applications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 uuid NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id             uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  execution_id             uuid NOT NULL,
  adjustment_id            uuid NOT NULL REFERENCES conversion_adjustments(id) ON DELETE RESTRICT,
  fingerprint              text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  effect                   text NOT NULL CHECK (effect IN ('opening','post_opening')),
  journal_entry_id         uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  journal_entry_reference  text,
  before_balances          jsonb NOT NULL,
  lines                    jsonb NOT NULL,
  after_balances           jsonb NOT NULL,
  gl_after_execute         jsonb NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, adjustment_id)
);
DROP TRIGGER IF EXISTS trg_conversion_adjustment_applications_append_only ON conversion_adjustment_applications;
CREATE TRIGGER trg_conversion_adjustment_applications_append_only BEFORE UPDATE OR DELETE ON conversion_adjustment_applications FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
COMMENT ON TABLE conversion_adjustment_applications IS 'association_record: per approved adjustment at EXECUTE, the permanent chain source position before -> approved lines + fingerprint -> position after (approved) and the GL measured at the cutoff.';

-- ---------------------------------------------------------------------------
-- 3) Reconciling items + the execution write log learn the new kinds
-- ---------------------------------------------------------------------------
ALTER TABLE conversion_reconciling_items DROP CONSTRAINT IF EXISTS conversion_reconciling_items_kind_check;
ALTER TABLE conversion_reconciling_items ADD CONSTRAINT conversion_reconciling_items_kind_check CHECK (kind IN ('deferral_residue', 'builder_position_unresolved', 'suspense_balance'));
ALTER TABLE onboarding_execution_writes DROP CONSTRAINT IF EXISTS onboarding_execution_writes_table_name_check;
ALTER TABLE onboarding_execution_writes ADD CONSTRAINT onboarding_execution_writes_table_name_check
  CHECK (table_name IN ('journal_entries','transaction_upload_batches','homeowner_transactions','ap_invoices','communities','conversion_batches',
                        'builder_assessment_coverage','recognition_schedules','conversion_reconciling_items',
                        'ownership_tenures','conversion_source_identities','conversion_adjustment_applications'));
ALTER TABLE onboarding_execution_writes DROP CONSTRAINT IF EXISTS onboarding_execution_writes_write_kind_check;
ALTER TABLE onboarding_execution_writes ADD CONSTRAINT onboarding_execution_writes_write_kind_check
  CHECK (write_kind IN ('opening_je','neutralize_je','repost_je','supersede_je','ar_opening_batch','ar_opening_row',
                        'revert_ar_batch','ap_opening_invoice','cutover_date','conversion_batch',
                        'builder_batch','builder_row','builder_coverage','deferral_schedule','reconciling_item',
                        'adjustment_je','adjustment_application','legacy_tenure','initial_ownership','source_identity'));

-- ---------------------------------------------------------------------------
-- 4) onboarding_execute: the 501 body + the 536 blocks (everything else unchanged)
-- ---------------------------------------------------------------------------
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
  -- 501
  bb JSONB; b_batch UUID; b_je UUID; b_je_ref TEXT; n_bcov INT := 0; n_brow INT := 0; n_sched INT := 0; n_items INT := 0;
  b_ledger BIGINT; b_gl BIGINT; txn UUID; cov_id UUID; appr_actor TEXT; sched_id UUID;
  -- 536
  n_adj INT := 0; n_app INT := 0; n_leg INT := 0; n_est INT := 0; refs JSONB := '{}'::jsonb; tid UUID; adj_je UUID; gl_after JSONB; x536 JSONB;
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
  SELECT id, actor_id INTO appr, appr_actor FROM onboarding_stage_events WHERE batch_id = p_batch AND event_type = 'preflight_approved' AND actor_kind = 'human'
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
  bb := w->'builder_coverage_batch';
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
  -- 501: no builder lot may already carry coverage for the conversion year (the conversion writes the first period).
  IF bb IS NOT NULL THEN
    SELECT string_agg(x->>'street_address', ', ') INTO bad FROM jsonb_array_elements(bb->'rows') x
     WHERE EXISTS (SELECT 1 FROM builder_assessment_coverage cv WHERE cv.tenure_id = (x->>'tenure_id')::uuid AND cv.fiscal_year = (x->>'fiscal_year')::int AND cv.status <> 'voided');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'onboarding: execute refused: builder coverage already exists for %', bad USING ERRCODE = 'check_violation'; END IF;
  END IF;

  -- 536: the approved conversion objects are exactly the ones this preflight bound (adjustments and
  -- policies by id + database fingerprint), every adjustment the plan applies is still approved with
  -- that fingerprint, and no source identity the plan establishes exists yet.
  IF pre ? 'conversion_objects_digest' THEN
    IF onboarding_conversion_objects_digest(p_batch) IS DISTINCT FROM pre->>'conversion_objects_digest' THEN
      RAISE EXCEPTION 'onboarding: execute refused: the approved conversion adjustments / policies changed since the preflight' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM conversion_adjustments WHERE batch_id = p_batch AND status = 'approved')
     OR EXISTS (SELECT 1 FROM conversion_policies WHERE batch_id = p_batch AND status = 'approved') THEN
    RAISE EXCEPTION 'onboarding: execute refused: this batch has approved conversion adjustments / policies but the preflight predates them' USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(x->>'adjustment_no', ', ') INTO bad FROM jsonb_array_elements(coalesce(w->'adjustment_applications', '[]'::jsonb)) x
   WHERE NOT EXISTS (SELECT 1 FROM conversion_adjustments a WHERE a.id = (x->>'adjustment_id')::uuid AND a.batch_id = p_batch AND a.status = 'approved' AND a.fingerprint = x->>'fingerprint');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'onboarding: execute refused: adjustment(s) % are not approved with the fingerprint the preflight carries', bad USING ERRCODE = 'check_violation'; END IF;
  SELECT string_agg(x->>'external_id', ', ') INTO bad FROM jsonb_array_elements(coalesce(pre->'source_identities_absent', '[]'::jsonb)) x
   WHERE EXISTS (SELECT 1 FROM conversion_source_identities s WHERE s.community_id = comm AND s.source_system = x->>'source_system' AND s.external_id_kind = x->>'external_id_kind' AND s.external_id = x->>'external_id');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'onboarding: execute refused: source account(s) % are already established', bad USING ERRCODE = 'check_violation'; END IF;

  -- ------------------------------------------------- enter execute; the write lock opens
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id)
  VALUES (p_batch, 'stage_advanced', 'preflight', 'execute', c.id, 'human', p_actor_id)      -- validate trigger: next stage, latest result, gate
  RETURNING id INTO adv;
  UPDATE conversion_batches SET onboarding_stage = 'execute', write_locked = FALSE WHERE id = p_batch;   -- guard: human advance + approved hash for this result
  prov := format('onboarding %s · batch %s · preflight %s · execution %s', code, p_batch, c.id, exec_id);

  -- ---------------------------------------------------------------- journal entries
  n_open := jsonb_array_length(w->'opening_journal_entries');
  FOR r IN SELECT x FROM jsonb_array_elements(w->'opening_journal_entries') x LOOP PERFORM onboarding_exec_post_je(exec_id, p_batch, comm, r, 'opening_je', prov); END LOOP;
  -- 536: approved post-opening conversion adjustments, dated the cutoff, after the opening entries.
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(w->'adjustment_journal_entries', '[]'::jsonb)) x LOOP
    PERFORM onboarding_exec_post_je(exec_id, p_batch, comm, r, 'adjustment_je', prov); n_adj := n_adj + 1;
  END LOOP;
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

  -- ------------------------------------- 536: legacy-owner records + initial ownership periods
  -- Created ONLY here, under a transaction-local flag the ownership guard honours for exactly
  -- these two shapes (a legacy record with no lot; the first owner tenure of a lot that never had
  -- one). Each initial ownership is keyed by source system + source account (unique), never a name.
  PERFORM set_config('trusted.onboarding_establish', 'on', true);
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(w->'legacy_tenures', '[]'::jsonb)) x LOOP
    INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin, notes)
    VALUES (comm, NULL, 'legacy', NULL, r->>'vantaca_account_id', 'conversion', (r->>'notes') || ' · ' || prov)
    RETURNING id INTO tid;
    refs := refs || jsonb_build_object(r->>'key', tid); n_leg := n_leg + 1;
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'ownership_tenures', tid, 'insert', 'legacy_tenure', r->>'key', jsonb_build_object('kind', 'legacy', 'vantaca_account_id', r->>'vantaca_account_id'));
  END LOOP;
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(w->'establishments', '[]'::jsonb)) x LOOP
    IF NOT EXISTS (SELECT 1 FROM properties WHERE id = (r->>'property_id')::uuid AND community_id = comm) THEN
      RAISE EXCEPTION 'onboarding execute: establishment % names a lot outside this community', r->>'key' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM ownership_tenures WHERE property_id = (r->>'property_id')::uuid AND kind = 'owner') THEN
      RAISE EXCEPTION 'onboarding execute: establishment %: the lot already has an owner tenure (a new owner is a transfer)', r->>'key' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin, notes)
    VALUES (comm, (r->>'property_id')::uuid, 'owner', NULL, nullif(r->>'tenure_xref', ''), 'conversion',
            'Initial ownership period established by the conversion from source account ' || (r->>'external_id') || '; start ' || coalesce(r->>'start_basis', 'not established') || ' · ' || prov)
    RETURNING id INTO tid;
    refs := refs || jsonb_build_object(r->>'key', tid); n_est := n_est + 1;
    INSERT INTO conversion_source_identities (community_id, source_system, external_id_kind, external_id, property_id, tenure_id, batch_id, execution_id, detail)
    VALUES (comm, r->>'source_system', r->>'external_id_kind', r->>'external_id', (r->>'property_id')::uuid, tid, p_batch, exec_id,
            jsonb_strip_nulls(jsonb_build_object('owner_as_printed', r->>'owner_as_printed', 'evidence', r->'evidence', 'xref_held_by_legacy_tenure', r->>'xref_held_by_legacy_tenure', 'start_basis', r->>'start_basis')))
    RETURNING id INTO row_id;
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'ownership_tenures', tid, 'insert', 'initial_ownership', r->>'key', jsonb_build_object('property_id', r->>'property_id', 'tenure_xref', r->>'tenure_xref')),
           (exec_id, p_batch, 'conversion_source_identities', row_id, 'insert', 'source_identity', r->>'key', jsonb_build_object('source_system', r->>'source_system', 'external_id', r->>'external_id'));
  END LOOP;
  PERFORM set_config('trusted.onboarding_establish', 'off', true);

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
    -- 536: a row may name a tenure created above (legacy record / initial ownership) by its key.
    tid := (r->>'tenure_id')::uuid;
    IF tid IS NULL AND r ? 'tenure_ref' THEN
      tid := (refs->>(r->>'tenure_ref'))::uuid;
      IF tid IS NULL THEN RAISE EXCEPTION 'onboarding execute: ledger row % names tenure % which was not created', i, r->>'tenure_ref' USING ERRCODE = 'check_violation'; END IF;
    END IF;
    INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, tenure_id, transaction_date,
                                        description, txn_type, charge_category, amount_cents, raw_row_jsonb, notes)
    VALUES (row_id, ar_batch, i, comm, r->>'vantaca_account_id', (r->>'property_id')::uuid, tid, (r->>'transaction_date')::date,
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

  -- ------------------------------------------------- 501: builder assessments at the builder rate
  IF bb IS NOT NULL THEN
    b_je_ref := bb->>'journal_entry_reference';
    IF b_je_ref IS NOT NULL THEN
      SELECT id INTO b_je FROM journal_entries WHERE community_id = comm AND reference = b_je_ref AND status = 'posted';
      IF b_je IS NULL THEN RAISE EXCEPTION 'onboarding execute: the builder entry % was not written', b_je_ref USING ERRCODE = 'check_violation'; END IF;
    END IF;
    IF jsonb_array_length(bb->'rows') > 0 THEN
      b_batch := gen_random_uuid();
      n_brow := (SELECT count(*) FROM jsonb_array_elements(bb->'rows') x WHERE (x->>'ledger_amount_cents')::bigint <> 0);
      INSERT INTO transaction_upload_batches (id, management_company_id, community_id, period_label, as_of_date, source_filename, source_format, row_count, account_count,
                                              total_charges_cents, total_payments_cents, status, uploaded_by, committed_at, min_transaction_date, max_transaction_date, notes)
      VALUES (b_batch, (bb->>'management_company_id')::uuid, comm, bb->>'period_label', cutover, bb->>'key', 'manual', n_brow, n_brow,
              (SELECT coalesce(sum((x->>'ledger_amount_cents')::bigint), 0) FROM jsonb_array_elements(bb->'rows') x WHERE (x->>'ledger_amount_cents')::bigint > 0), 0,
              'committed', bb->>'uploaded_by', now(), cutover, cutover, 'Conversion builder assessments at the builder rate · ' || prov);
      INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
      VALUES (exec_id, p_batch, 'transaction_upload_batches', b_batch, 'insert', 'builder_batch', bb->>'key', jsonb_build_object('row_count', n_brow, 'status', 'committed'));
      i := 0;
      FOR r IN SELECT x FROM jsonb_array_elements(bb->'rows') x LOOP
        txn := NULL;
        IF (r->>'ledger_amount_cents')::bigint <> 0 THEN
          i := i + 1; txn := gen_random_uuid();
          INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number, property_id, tenure_id,
                                              transaction_date, description, txn_type, charge_category, amount_cents, reduction_source, raw_row_jsonb, notes)
          VALUES (txn, b_batch, i, comm, r->>'vantaca_account_id', r->>'account_number', (r->>'property_id')::uuid, (r->>'tenure_id')::uuid,
                  cutover, r->>'description', r->>'txn_type', 'assessment', (r->>'ledger_amount_cents')::bigint,
                  CASE WHEN (r->>'ledger_amount_cents')::bigint < 0 THEN 'correcting_adjustment' END,
                  jsonb_build_object('source', 'conversion_builder', 'batch_code', code, 'kind', r->>'kind', 'covered_from', r->>'covered_from', 'covered_through', r->>'covered_through',
                                     'onboarding', jsonb_build_object('batch_id', p_batch, 'preflight_completion_id', c.id, 'execution_id', exec_id)),
                  'builder ' || (r->>'kind') || ' · ' || prov);
          INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
          VALUES (exec_id, p_batch, 'homeowner_transactions', txn, 'insert', 'builder_row', bb->>'key' || ':' || (r->>'property_id'),
                  jsonb_build_object('property_id', r->>'property_id', 'amount_cents', (r->>'ledger_amount_cents')::bigint, 'kind', r->>'kind'));
        END IF;
        cov_id := gen_random_uuid();
        INSERT INTO builder_assessment_coverage (id, community_id, property_id, account_number, vantaca_account_id, tenure_id, builder_company_id, fiscal_year,
            year_start, year_end, covered_from, covered_through, days, days_in_year, annual_assessment_cents, builder_rate_pct, rate_source, base_amount_cents, rounding_true_up_cents,
            amount_cents, annual_billed_cents, legacy_evidence, source_type, conversion_batch_id, batch_id, homeowner_txn_id, status, created_by)
        VALUES (cov_id, comm, (r->>'property_id')::uuid, r->>'account_number', r->>'vantaca_account_id', (r->>'tenure_id')::uuid, (r->>'builder_company_id')::uuid,
            (r->>'fiscal_year')::int, (r->>'year_start')::date, (r->>'year_end')::date, (r->>'covered_from')::date, (r->>'covered_through')::date, (r->>'days')::int, (r->>'days_in_year')::int,
            (r->>'annual_assessment_cents')::bigint, (r->>'builder_rate_pct')::numeric, coalesce(r->'rate_source', '{}'::jsonb), (r->>'base_amount_cents')::bigint, 0,
            (r->>'base_amount_cents')::bigint, (r->>'annual_billed_cents')::bigint, r->'legacy_evidence', 'conversion', p_batch, b_batch, txn, 'pending', 'conversion:' || code);
        UPDATE builder_assessment_coverage SET status = 'posted', journal_entry_id = b_je, journal_entry_reference = b_je_ref WHERE id = cov_id;
        INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
        VALUES (exec_id, p_batch, 'builder_assessment_coverage', cov_id, 'insert', 'builder_coverage', bb->>'key' || ':coverage:' || (r->>'property_id'),
                jsonb_build_object('from', r->>'covered_from', 'through', r->>'covered_through', 'amount_cents', (r->>'base_amount_cents')::bigint, 'kind', r->>'kind'));
        n_bcov := n_bcov + 1;
      END LOOP;
    END IF;
  END IF;

  -- -------------------------------------------- 501: the deferred-assessment release schedule
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(w->'deferral_schedules', '[]'::jsonb)) x LOOP
    sched_id := gen_random_uuid();
    INSERT INTO recognition_schedules (id, community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents,
        start_month, term_months, monthly_amount_cents, period_start, period_end, status, recognition_method, schedule_basis, source_type, source_id,
        explanation, created_by, approved_by, approved_at, notes)
    VALUES (sched_id, comm, r->>'schedule_type', r->>'description', r->>'balance_account_number', (r->>'recognition_account_id')::uuid, (r->>'recognize_amount_cents')::bigint,
        (r->>'start_month')::date, (r->>'term_months')::int, (r->>'monthly_amount_cents')::bigint, (r->>'period_start')::date, (r->>'period_end')::date,
        'active', r->>'recognition_method', r->>'schedule_basis', 'conversion_balance', p_batch,
        r->>'explanation', 'conversion:' || code, appr_actor, now(), 'Approved with the conversion preflight (approval ' || appr || ') · ' || prov);
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'recognition_schedules', sched_id, 'insert', 'deferral_schedule', code || ':deferral:' || (r->>'balance_account_number'),
            jsonb_build_object('recognize_amount_cents', (r->>'recognize_amount_cents')::bigint, 'term_months', (r->>'term_months')::int, 'start_month', r->>'start_month'));
    n_sched := n_sched + 1;
  END LOOP;

  -- ------------------------------------------------------------- 501: reconciling items
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(w->'reconciling_items', '[]'::jsonb)) x LOOP
    row_id := gen_random_uuid();
    INSERT INTO conversion_reconciling_items (id, batch_id, community_id, execution_id, kind, item_key, account_number, property_id, amount_cents, detail, created_by)
    VALUES (row_id, p_batch, comm, exec_id, r->>'kind', r->>'item_key', r->>'account_number', (r->>'property_id')::uuid, (r->>'amount_cents')::bigint,
            coalesce(r->'detail', '{}'::jsonb) || jsonb_build_object('recorded_by', prov), 'conversion:' || code);
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'conversion_reconciling_items', row_id, 'insert', 'reconciling_item', (r->>'kind') || ':' || (r->>'item_key'),
            jsonb_build_object('amount_cents', (r->>'amount_cents')::bigint));
    n_items := n_items + 1;
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
  -- 501: the builder ledger = the plan = the builder entry's AR lines; every planned lot covered and posted.
  IF bb IS NOT NULL THEN
    SELECT coalesce(sum(amount_cents), 0) INTO b_ledger FROM homeowner_transactions WHERE b_batch IS NOT NULL AND source_batch_id = b_batch;
    -- the entry's receivable lines are the ones that name a lot (income / deferral lines name none)
    SELECT coalesce(sum(jl.debit_cents - jl.credit_cents), 0) INTO b_gl FROM journal_entry_lines jl
     WHERE b_je IS NOT NULL AND jl.journal_entry_id = b_je AND jl.property_id IS NOT NULL;
    IF b_ledger <> (bb->>'ledger_cents')::bigint OR b_gl <> b_ledger THEN
      RAISE EXCEPTION 'onboarding execute: builder ledger % / entry AR % do not equal the plan %', b_ledger, b_gl, bb->>'ledger_cents' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM builder_assessment_coverage WHERE conversion_batch_id = p_batch AND status = 'posted' AND journal_entry_id IS NOT DISTINCT FROM b_je;
    IF n <> jsonb_array_length(bb->'rows') OR n <> n_bcov THEN
      RAISE EXCEPTION 'onboarding execute: % builder coverage periods posted, % planned', n, jsonb_array_length(bb->'rows') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT count(*), coalesce(sum(recognize_amount_cents), 0) INTO n, v FROM recognition_schedules WHERE source_type = 'conversion_balance' AND source_id = p_batch AND status = 'active';
  IF n <> n_sched OR v <> (SELECT coalesce(sum((x->>'recognize_amount_cents')::bigint), 0) FROM jsonb_array_elements(coalesce(w->'deferral_schedules', '[]'::jsonb)) x) THEN
    RAISE EXCEPTION 'onboarding execute: deferral schedules (% totalling %) do not equal the plan', n, v USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO n FROM conversion_reconciling_items WHERE batch_id = p_batch AND status = 'open';
  IF n <> n_items THEN RAISE EXCEPTION 'onboarding execute: % reconciling items recorded, % planned', n, n_items USING ERRCODE = 'check_violation'; END IF;

  -- 536: legacy owners never sit on a lot's owner tenure (the current-owner ledger and portal read
  -- owner tenures only), and every current-owner row is on its lot's current owner tenure.
  SELECT count(*) INTO n FROM homeowner_transactions h JOIN ownership_tenures t ON t.id = h.tenure_id
   WHERE h.source_batch_id = ar_batch AND coalesce((h.raw_row_jsonb->'onboarding'->>'prior_owner')::boolean, false) AND t.kind <> 'legacy';
  IF n <> 0 AND (plan->'summary') ? 'legacy_tenures' THEN RAISE EXCEPTION 'onboarding execute: % prior-owner row(s) are on an owner tenure', n USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO n FROM homeowner_transactions h LEFT JOIN ownership_tenures t ON t.id = h.tenure_id
   WHERE h.source_batch_id = ar_batch AND NOT coalesce((h.raw_row_jsonb->'onboarding'->>'prior_owner')::boolean, false)
     AND (t.id IS NULL OR t.kind <> 'owner' OR t.end_date IS NOT NULL OR t.property_id IS DISTINCT FROM h.property_id);
  IF n <> 0 AND (plan->'summary') ? 'establishments' THEN RAISE EXCEPTION 'onboarding execute: % current-owner row(s) are not on their lot''s current owner tenure', n USING ERRCODE = 'check_violation'; END IF;

  -- 536: the permanent adjustment audit chain: the source position before, the approved lines and
  -- fingerprint, the position after (as approved), and the GL actually measured at the cutoff now.
  FOR r IN SELECT x FROM jsonb_array_elements(coalesce(w->'adjustment_applications', '[]'::jsonb)) x LOOP
    SELECT coalesce(jsonb_object_agg(a.k, coalesce(b.v, 0)), '{}'::jsonb) INTO gl_after
      FROM jsonb_object_keys(r->'after') a(k)
      LEFT JOIN (SELECT coa.account_number AS k, sum(l.debit_cents - l.credit_cents)::bigint AS v
                   FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id JOIN chart_of_accounts coa ON coa.id = l.account_id
                  WHERE j.community_id = comm AND j.posting_date <= cutoff AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))
                  GROUP BY 1) b ON b.k = a.k;
    adj_je := NULL;
    IF r->>'effect' = 'post_opening' THEN
      SELECT id INTO adj_je FROM journal_entries WHERE community_id = comm AND reference = r->>'journal_entry_reference';
      IF adj_je IS NULL THEN RAISE EXCEPTION 'onboarding execute: adjustment entry % was not written', r->>'journal_entry_reference' USING ERRCODE = 'check_violation'; END IF;
    END IF;
    INSERT INTO conversion_adjustment_applications (batch_id, community_id, execution_id, adjustment_id, fingerprint, effect, journal_entry_id, journal_entry_reference, before_balances, lines, after_balances, gl_after_execute)
    VALUES (p_batch, comm, exec_id, (r->>'adjustment_id')::uuid, r->>'fingerprint', r->>'effect', adj_je, r->>'journal_entry_reference', r->'before', r->'lines', r->'after', gl_after)
    RETURNING id INTO row_id;
    INSERT INTO onboarding_execution_writes (execution_id, batch_id, table_name, row_id, action, write_kind, write_key, after)
    VALUES (exec_id, p_batch, 'conversion_adjustment_applications', row_id, 'insert', 'adjustment_application', 'adjustment:' || (r->>'adjustment_no'), jsonb_build_object('fingerprint', r->>'fingerprint'));
    n_app := n_app + 1;
  END LOOP;

  SELECT count(*), coalesce(sum(total_debits_cents), 0) INTO n_post, v FROM journal_entries
   WHERE community_id = comm AND posting_date >= cutover AND left(reference, length(code)) <> code
     AND (status = 'posted' OR (status = 'voided' AND void_reversal_je_id IS NOT NULL));
  IF n_post <> (pre->'post_cutover_entries'->>'count')::bigint OR v <> (pre->'post_cutover_entries'->>'debits_cents')::bigint THEN
    RAISE EXCEPTION 'onboarding execute: post-cutover entries changed during execute' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO n FROM journal_entries WHERE community_id = comm AND left(reference, length(code)) = code;
  IF n <> n_open + n_adj + n_neut + n_repost THEN RAISE EXCEPTION 'onboarding execute: % conversion entries written, % planned', n, n_open + n_adj + n_neut + n_repost USING ERRCODE = 'check_violation'; END IF;
  counts := jsonb_build_object('opening_journal_entries', n_open, 'neutralize_journal_entries', n_neut, 'repost_journal_entries', n_repost,
                               'supersede_journal_entries', n_sup, 'revert_ar_batches', n_rev, 'ar_opening_rows', n_ar, 'ap_opening_invoices', n_ap);
  IF counts IS DISTINCT FROM (SELECT jsonb_build_object('opening_journal_entries', (s->>'opening_journal_entries')::int, 'neutralize_journal_entries', (s->>'neutralize_journal_entries')::int,
        'repost_journal_entries', (s->>'repost_journal_entries')::int, 'supersede_journal_entries', (s->>'supersede_journal_entries')::int, 'revert_ar_batches', (s->>'revert_ar_batches')::int,
        'ar_opening_rows', (s->>'ar_opening_rows')::int, 'ap_opening_invoices', (s->>'ap_opening_invoices')::int) FROM (SELECT plan->'summary' AS s) q) THEN
    RAISE EXCEPTION 'onboarding execute: write counts % do not equal the plan', counts USING ERRCODE = 'check_violation';
  END IF;
  -- 501: the builder counts (a plan without a builder section has none of these keys and writes none of these rows).
  IF (plan->'summary') ? 'builder_coverage_rows' OR n_bcov + n_brow + n_sched + n_items > 0 THEN
    IF jsonb_build_object('builder_coverage_rows', n_bcov, 'builder_ledger_rows', n_brow, 'deferral_schedules', n_sched, 'reconciling_items', n_items)
       IS DISTINCT FROM (SELECT jsonb_build_object('builder_coverage_rows', coalesce((s->>'builder_coverage_rows')::int, 0), 'builder_ledger_rows', coalesce((s->>'builder_ledger_rows')::int, 0),
                                 'deferral_schedules', coalesce((s->>'deferral_schedules')::int, 0), 'reconciling_items', coalesce((s->>'reconciling_items')::int, 0)) FROM (SELECT plan->'summary' AS s) q) THEN
      RAISE EXCEPTION 'onboarding execute: builder write counts (% coverage, % ledger, % schedules, % items) do not equal the plan', n_bcov, n_brow, n_sched, n_items USING ERRCODE = 'check_violation';
    END IF;
    counts := counts || jsonb_build_object('builder_coverage_rows', n_bcov, 'builder_ledger_rows', n_brow, 'deferral_schedules', n_sched, 'reconciling_items', n_items);
  END IF;
  -- 536: the new write counts (a plan without these keys writes none of these rows).
  IF (plan->'summary') ? 'adjustment_journal_entries' OR n_adj + n_app + n_leg + n_est > 0 THEN
    x536 := jsonb_build_object('adjustment_journal_entries', n_adj, 'adjustment_applications', n_app, 'legacy_tenures', n_leg, 'establishments', n_est);
    IF x536 IS DISTINCT FROM (SELECT jsonb_build_object('adjustment_journal_entries', coalesce((s->>'adjustment_journal_entries')::int, 0), 'adjustment_applications', coalesce((s->>'adjustment_applications')::int, 0),
                                 'legacy_tenures', coalesce((s->>'legacy_tenures')::int, 0), 'establishments', coalesce((s->>'establishments')::int, 0)) FROM (SELECT plan->'summary' AS s) q) THEN
      RAISE EXCEPTION 'onboarding execute: conversion-object write counts % do not equal the plan', x536 USING ERRCODE = 'check_violation';
    END IF;
    counts := counts || x536;
  END IF;
  proof := jsonb_build_object('cutoff_trial_balance', 'equal', 'current_trial_balance', 'equal', 'ar_receivable_cents', ar_recv, 'ar_current_owner_prepaid_cents', ar_cur,
                              'ar_prior_owner_credit_cents', ar_prior, 'post_cutover_entries_unchanged', n_post, 'cutover_date', cutover, 'write_counts', counts)
           || CASE WHEN bb IS NOT NULL THEN jsonb_build_object('builder_ledger_cents', b_ledger, 'builder_coverage_rows', n_bcov) ELSE '{}'::jsonb END;
  controls := jsonb_build_array(
    jsonb_build_object('code', 'execute.preconditions_held', 'label', 'Every recorded precondition held against live data at execute time', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.cutoff_tb_equals_source', 'label', 'Trusted TB at the cutoff equals the source TB on every account', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.current_tb_equals_projection', 'label', 'Trusted TB through today equals the projected TB', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.homeowner_ledger_equals_plan', 'label', 'Homeowner ledger receivables / prepaids / prior-owner credits equal the plan', 'status', 'PASS', 'level', 'execute',
                       'left_cents', ar_recv, 'right_cents', (ab->>'receivable_cents')::bigint, 'difference_cents', 0),
    jsonb_build_object('code', 'execute.post_cutover_unchanged', 'label', 'Every post-cutover entry is unchanged', 'status', 'PASS', 'level', 'execute'),
    jsonb_build_object('code', 'execute.write_counts_equal_plan', 'label', 'Exactly the planned rows were written', 'status', 'PASS', 'level', 'execute'))
    || CASE WHEN bb IS NOT NULL THEN jsonb_build_array(
         jsonb_build_object('code', 'execute.builder_coverage_equals_plan', 'label', 'Builder ledger = the plan = the builder entry''s AR lines; every resolved builder lot has its posted conversion coverage', 'status', 'PASS', 'level', 'execute',
                            'left_cents', b_ledger, 'right_cents', (bb->>'ledger_cents')::bigint, 'difference_cents', 0))
       ELSE '[]'::jsonb END;

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

-- ---------------------------------------------------------------------------
-- 5) The capability probe: the service refuses a plan that needs these EXECUTE writes
--    unless this function exists (code deployed before 536 is applied fails closed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION onboarding_execute_capabilities() RETURNS JSONB LANGUAGE sql IMMUTABLE AS $fn$
  SELECT '["conversion_adjustments","adjustment_audit_chain","legacy_owner_records","initial_ownership"]'::jsonb
$fn$;
REVOKE ALL ON FUNCTION onboarding_execute_capabilities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_execute_capabilities() TO service_role;

-- ---------------------------------------------------------------------------
-- 6) Grants
-- ---------------------------------------------------------------------------
ALTER TABLE conversion_source_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_adjustment_applications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON conversion_source_identities, conversion_adjustment_applications TO service_role;

COMMIT;
