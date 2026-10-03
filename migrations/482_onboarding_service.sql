-- ============================================================================
-- 482_onboarding_service.sql  (Issue #15 Milestone 2, Ed 2026-10-02)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- The single guarded service path for the Trusted Onboarding Engine. Every
-- onboarding read and write the app makes goes through these functions (the
-- API calls them with supabase.rpc; nothing writes the onboarding tables
-- directly). Each write function is ONE transaction and lands on the
-- migration-481 triggers, so the database gates apply no matter who calls:
--
--   onboarding_create_batch       human; new engine batch at intake
--   onboarding_register_artifact  batch must be in intake; immutable artifact row
--   onboarding_record_completion  stage result + its run + every control result,
--                                 atomically; the stage status and open controls
--                                 must be exactly what the controls say (a
--                                 caller cannot record PASS over a FAIL)
--   onboarding_waive              human waiver of ONE open control of the latest
--                                 result, plus the WAIVED disposition on that
--                                 control result (status untouched)
--   onboarding_approve            human approval of a preflight hash bound to the
--                                 current preflight result
--   onboarding_advance            human advance event + stage change, re-proved by
--                                 the 481 guard; EXECUTE is not reachable in this
--                                 milestone (no execute behavior exists yet)
--   onboarding_batch_view / onboarding_batches   read-only views (jsonb)
--
-- Also: control results of onboarding runs become immutable except for the
-- one-time WAIVED disposition (status, amounts and difference can never change;
-- no delete), and conversion_runs.run_kind allows intake / execute.
--
-- The actor kind and id are supplied by the SERVER from the authenticated
-- user (never from a request body); human-only gates are re-checked here and
-- again by the 481 CHECKs and triggers. Functions are executable by
-- service_role only. Requires 481. No rows change.
-- ============================================================================
BEGIN;

ALTER TABLE conversion_runs DROP CONSTRAINT IF EXISTS conversion_runs_run_kind_check;
ALTER TABLE conversion_runs ADD CONSTRAINT conversion_runs_run_kind_check
  CHECK (run_kind IN ('dry_run','intake','normalize','source_controls','snapshot','activity_bridge','preflight','execute','post_proof'));

CREATE OR REPLACE FUNCTION onboarding_assert_actor(p_kind TEXT, p_id TEXT, p_human_only BOOLEAN) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('human','agent','system') OR length(btrim(coalesce(p_id, ''))) = 0 THEN
    RAISE EXCEPTION 'onboarding: actor kind and id are required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_human_only AND p_kind <> 'human' THEN
    RAISE EXCEPTION 'onboarding: only a human may do this' USING ERRCODE = 'check_violation';
  END IF;
END;
$fn$;

-- Control results of onboarding runs are immutable; the only permitted change
-- is setting the WAIVED disposition once, from a matching human waiver event.
CREATE OR REPLACE FUNCTION conversion_control_results_onboarding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE kind TEXT;
BEGIN
  SELECT run_kind INTO kind FROM conversion_runs WHERE id = OLD.run_id;
  IF kind IS NULL OR kind = 'dry_run' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;   -- legacy (452) runs untouched
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'onboarding control results cannot be deleted' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.run_id, NEW.rule_code, NEW.status, NEW.left_cents, NEW.right_cents, NEW.left_expr, NEW.right_expr, NEW.note, NEW.detail, NEW.level, NEW.tolerance_cents, NEW.tolerance_reason)
     IS DISTINCT FROM (OLD.run_id, OLD.rule_code, OLD.status, OLD.left_cents, OLD.right_cents, OLD.left_expr, OLD.right_expr, OLD.note, OLD.detail, OLD.level, OLD.tolerance_cents, OLD.tolerance_reason) THEN
    RAISE EXCEPTION 'onboarding control results are immutable (status, amounts and difference never change)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.disposition IS NOT NULL THEN RAISE EXCEPTION 'the waiver disposition is write-once' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.disposition IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM onboarding_stage_events w JOIN onboarding_stage_events c ON c.id = w.completion_event_id
        WHERE w.id = NEW.waiver_event_id AND w.event_type = 'control_waived' AND w.actor_kind = 'human'
          AND w.control_code = NEW.rule_code AND (c.result->>'run_id')::uuid = NEW.run_id
          AND w.actor_id = NEW.waived_by AND w.reason = NEW.waiver_reason) THEN
    RAISE EXCEPTION 'a WAIVED disposition must come from the matching human waiver event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_conversion_control_results_onboarding_guard ON conversion_control_results;
CREATE TRIGGER trg_conversion_control_results_onboarding_guard BEFORE UPDATE OR DELETE ON conversion_control_results
  FOR EACH ROW EXECUTE FUNCTION conversion_control_results_onboarding_guard();

CREATE OR REPLACE FUNCTION onboarding_create_batch(p_community UUID, p_batch_code TEXT, p_as_of DATE, p_source_system TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE b UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, TRUE);
  IF length(btrim(coalesce(p_batch_code, ''))) = 0 OR p_as_of IS NULL OR length(btrim(coalesce(p_source_system, ''))) = 0 THEN
    RAISE EXCEPTION 'onboarding: batch code, cutoff date and source system are required' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO conversion_batches (community_id, batch_code, as_of_date, source_system, status, onboarding_stage, created_by)
  VALUES (p_community, btrim(p_batch_code), p_as_of, lower(btrim(p_source_system)), 'draft', 'intake', p_actor_id) RETURNING id INTO b;
  RETURN b;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_register_artifact(p_batch UUID, p_artifact JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; a UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS DISTINCT FROM 'intake' THEN
    RAISE EXCEPTION 'onboarding: artifacts can only be registered while the batch is in intake' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO onboarding_artifacts (batch_id, community_id, source_system, artifact_type, filename, version_label, period_start, period_end, cutoff_date,
                                    sha256, bytes, storage_path, derived_from_sha256, supplied_by, provenance)
  VALUES (p_batch, bt.community_id, bt.source_system, p_artifact->>'artifact_type', p_artifact->>'filename', p_artifact->>'version_label',
          (p_artifact->>'period_start')::date, (p_artifact->>'period_end')::date, coalesce((p_artifact->>'cutoff_date')::date, bt.as_of_date),
          p_artifact->>'sha256', (p_artifact->>'bytes')::bigint, p_artifact->>'storage_path', p_artifact->>'derived_from_sha256', p_actor_id,
          coalesce(p_artifact->'provenance', '{}'::jsonb) || jsonb_build_object('registered_by_kind', p_actor_kind))
  RETURNING id INTO a;
  RETURN a;
END;
$fn$;

-- p_controls: [{ code, label, level, status, left_label, right_label, left_cents, right_cents, difference_cents,
--               tolerance_cents, tolerance_reason, failures, reason, needs }]
CREATE OR REPLACE FUNCTION onboarding_record_completion(p_batch UUID, p_stage TEXT, p_status TEXT, p_open JSONB, p_controls JSONB, p_summary JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; derived TEXT; derived_open JSONB; run UUID; ev UUID; c JSONB;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS DISTINCT FROM p_stage THEN
    RAISE EXCEPTION 'onboarding: result for stage % but the batch is in %', p_stage, coalesce(bt.onboarding_stage, '(not enrolled)') USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_controls) <> 'array' OR jsonb_array_length(p_controls) = 0 THEN
    RAISE EXCEPTION 'onboarding: a stage result must carry its control results' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_controls) x WHERE x->>'status' NOT IN ('PASS','FAIL','BLOCKED') OR length(btrim(coalesce(x->>'code', ''))) = 0) THEN
    RAISE EXCEPTION 'onboarding: every control needs a code and a PASS/FAIL/BLOCKED status' USING ERRCODE = 'check_violation';
  END IF;
  -- The stage status and open controls are DERIVED from the controls; a caller cannot claim otherwise.
  SELECT CASE WHEN bool_or(x->>'status' = 'FAIL') THEN 'FAIL' WHEN bool_or(x->>'status' = 'BLOCKED') THEN 'BLOCKED' ELSE 'PASS' END,
         coalesce(jsonb_agg(x->>'code' ORDER BY x->>'code') FILTER (WHERE x->>'status' <> 'PASS'), '[]'::jsonb)
    INTO derived, derived_open FROM jsonb_array_elements(p_controls) x;
  IF p_status IS DISTINCT FROM derived OR (SELECT coalesce(jsonb_agg(v ORDER BY v), '[]'::jsonb) FROM jsonb_array_elements_text(coalesce(p_open, '[]'::jsonb)) v) IS DISTINCT FROM
     (SELECT coalesce(jsonb_agg(v ORDER BY v), '[]'::jsonb) FROM jsonb_array_elements_text(derived_open) v) THEN
    RAISE EXCEPTION 'onboarding: stage status/open controls (% %) do not match the control results (% %)', p_status, p_open, derived, derived_open USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO conversion_runs (batch_id, run_kind, source_file_ids, counts, staged_rows, all_pass, report, run_by)
  VALUES (p_batch, p_stage, '{}', jsonb_build_object('PASS', (SELECT count(*) FROM jsonb_array_elements(p_controls) x WHERE x->>'status' = 'PASS'),
                                                   'FAIL', (SELECT count(*) FROM jsonb_array_elements(p_controls) x WHERE x->>'status' = 'FAIL'),
                                                   'BLOCKED', (SELECT count(*) FROM jsonb_array_elements(p_controls) x WHERE x->>'status' = 'BLOCKED')),
          '{}'::jsonb, derived = 'PASS', coalesce(p_summary, '{}'::jsonb), p_actor_id)
  RETURNING id INTO run;
  FOR c IN SELECT * FROM jsonb_array_elements(p_controls) LOOP
    INSERT INTO conversion_control_results (run_id, rule_code, note, status, left_expr, right_expr, left_cents, right_cents, level, tolerance_cents, tolerance_reason, detail)
    VALUES (run, c->>'code', c->>'label', c->>'status', c->>'left_label', c->>'right_label', (c->>'left_cents')::bigint, (c->>'right_cents')::bigint,
            c->>'level', coalesce((c->>'tolerance_cents')::bigint, 0), c->>'tolerance_reason',
            jsonb_strip_nulls(jsonb_build_object('difference_cents', c->'difference_cents', 'failures', c->'failures', 'reason', c->'reason', 'needs', c->'needs')));
  END LOOP;
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, actor_kind, actor_id, result)
  VALUES (p_batch, 'stage_completed', p_stage, p_actor_kind, p_actor_id,
          jsonb_build_object('status', derived, 'open_controls', derived_open, 'run_id', run, 'summary', coalesce(p_summary, '{}'::jsonb)))
  RETURNING id INTO ev;
  RETURN ev;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_waive(p_batch UUID, p_completion UUID, p_code TEXT, p_reason TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; ev UUID; run UUID; n INT;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, TRUE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: no such batch' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, control_code, reason, actor_kind, actor_id)
  VALUES (p_batch, 'control_waived', bt.onboarding_stage, p_completion, p_code, btrim(p_reason), p_actor_kind, p_actor_id)   -- 481 trigger: latest result, open control, once, reason
  RETURNING id INTO ev;
  SELECT (result->>'run_id')::uuid INTO run FROM onboarding_stage_events WHERE id = p_completion;
  UPDATE conversion_control_results SET disposition = 'WAIVED', waived_by = p_actor_id, waiver_reason = btrim(p_reason), waived_at = now(), waiver_event_id = ev
   WHERE run_id = run AND rule_code = p_code;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'onboarding: waived control % has no recorded result', p_code USING ERRCODE = 'check_violation'; END IF;
  RETURN ev;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_approve(p_batch UUID, p_completion UUID, p_preflight_sha256 TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE ev UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, TRUE);
  PERFORM 1 FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, preflight_sha256, actor_kind, actor_id)
  VALUES (p_batch, 'preflight_approved', 'preflight', p_completion, p_preflight_sha256, p_actor_kind, p_actor_id)
  RETURNING id INTO ev;
  UPDATE conversion_batches SET approved_preflight_sha256 = p_preflight_sha256, approved_by = p_actor_id, approved_at = now() WHERE id = p_batch;
  RETURN ev;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_advance(p_batch UUID, p_completion UUID, p_to TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; ev UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, TRUE);
  IF p_to = 'execute' THEN
    RAISE EXCEPTION 'onboarding: EXECUTE is not available yet (no execute behavior exists in this milestone)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: no such batch' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id)
  VALUES (p_batch, 'stage_advanced', bt.onboarding_stage, p_to, p_completion, p_actor_kind, p_actor_id)    -- 481 trigger: next stage, latest result, PASS or fully waived
  RETURNING id INTO ev;
  UPDATE conversion_batches SET onboarding_stage = p_to WHERE id = p_batch;                                -- 481 guard re-proves the gate
  RETURN ev;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_batch_view(p_batch UUID) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  WITH b AS (SELECT * FROM conversion_batches WHERE id = p_batch AND onboarding_stage IS NOT NULL),
  latest AS (
    SELECT DISTINCT ON (e.stage) e.* FROM onboarding_stage_events e
     WHERE e.batch_id = p_batch AND e.event_type = 'stage_completed' ORDER BY e.stage, e.seq DESC),
  cur AS (SELECT l.* FROM latest l JOIN b ON b.onboarding_stage = l.stage)
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM b) THEN NULL ELSE jsonb_build_object(
    'batch', (SELECT jsonb_build_object('id', id, 'community_id', community_id, 'batch_code', batch_code, 'as_of_date', as_of_date, 'source_system', source_system,
                                        'stage', onboarding_stage, 'write_locked', write_locked, 'approved_preflight_sha256', approved_preflight_sha256,
                                        'created_by', created_by, 'created_at', created_at) FROM b),
    'artifacts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'artifact_type', a.artifact_type, 'filename', a.filename, 'sha256', a.sha256, 'bytes', a.bytes,
                                        'storage_path', a.storage_path, 'derived_from_sha256', a.derived_from_sha256, 'cutoff_date', a.cutoff_date,
                                        'supplied_by', a.supplied_by, 'received_at', a.received_at) ORDER BY a.received_at, a.filename)
                           FROM onboarding_artifacts a WHERE a.batch_id = p_batch), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'seq', e.seq, 'type', e.event_type, 'stage', e.stage, 'to_stage', e.to_stage,
                                        'completion_id', e.completion_event_id, 'actor_kind', e.actor_kind, 'actor_id', e.actor_id, 'control_code', e.control_code,
                                        'reason', e.reason, 'preflight_sha256', e.preflight_sha256, 'status', e.result->>'status',
                                        'open_controls', e.result->'open_controls', 'at', e.created_at) ORDER BY e.seq)
                        FROM onboarding_stage_events e WHERE e.batch_id = p_batch), '[]'::jsonb),
    'latest_by_stage', coalesce((SELECT jsonb_object_agg(l.stage, jsonb_build_object('completion_id', l.id, 'status', l.result->>'status', 'open_controls', l.result->'open_controls',
                                        'run_id', l.result->>'run_id', 'by', l.actor_id, 'actor_kind', l.actor_kind, 'at', l.created_at)) FROM latest l), '{}'::jsonb),
    'current', (SELECT jsonb_build_object(
        'completion_id', c.id, 'status', c.result->>'status', 'open_controls', c.result->'open_controls', 'summary', c.result->'summary',
        'controls', coalesce((SELECT jsonb_agg(jsonb_build_object('code', r.rule_code, 'label', r.note, 'level', r.level, 'status', r.status,
                                   'left_label', r.left_expr, 'right_label', r.right_expr, 'left_cents', r.left_cents, 'right_cents', r.right_cents,
                                   'difference_cents', r.detail->'difference_cents', 'failures', r.detail->'failures', 'reason', r.detail->'reason', 'needs', r.detail->'needs',
                                   'tolerance_cents', r.tolerance_cents, 'tolerance_reason', r.tolerance_reason,
                                   'disposition', CASE WHEN r.disposition IS NULL THEN NULL ELSE jsonb_build_object('disposition', r.disposition, 'waived_by', r.waived_by,
                                                  'reason', r.waiver_reason, 'waived_at', r.waived_at, 'waiver_event_id', r.waiver_event_id) END)
                                   ORDER BY CASE r.status WHEN 'FAIL' THEN 0 WHEN 'BLOCKED' THEN 1 ELSE 2 END, r.rule_code)
                              FROM conversion_control_results r WHERE r.run_id = (c.result->>'run_id')::uuid), '[]'::jsonb),
        'waivers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'code', w.control_code, 'by', w.actor_id, 'reason', w.reason, 'at', w.created_at) ORDER BY w.seq)
                             FROM onboarding_stage_events w WHERE w.completion_event_id = c.id AND w.event_type = 'control_waived'), '[]'::jsonb),
        'gate', onboarding_completion_gate(c.id)) FROM cur c)
  ) END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_batches(p_community UUID DEFAULT NULL) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'batch_code', b.batch_code, 'community_id', b.community_id, 'as_of_date', b.as_of_date,
                                               'source_system', b.source_system, 'stage', b.onboarding_stage, 'write_locked', b.write_locked,
                                               'current_status', (SELECT e.result->>'status' FROM onboarding_stage_events e WHERE e.batch_id = b.id AND e.event_type = 'stage_completed'
                                                                   AND e.stage = b.onboarding_stage ORDER BY e.seq DESC LIMIT 1),
                                               'created_at', b.created_at) ORDER BY b.created_at DESC), '[]'::jsonb)
    FROM conversion_batches b WHERE b.onboarding_stage IS NOT NULL AND (p_community IS NULL OR b.community_id = p_community);
$fn$;

REVOKE ALL ON FUNCTION onboarding_assert_actor(TEXT, TEXT, BOOLEAN), onboarding_create_batch(UUID, TEXT, DATE, TEXT, TEXT, TEXT),
  onboarding_register_artifact(UUID, JSONB, TEXT, TEXT), onboarding_record_completion(UUID, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT),
  onboarding_waive(UUID, UUID, TEXT, TEXT, TEXT, TEXT), onboarding_approve(UUID, UUID, TEXT, TEXT, TEXT), onboarding_advance(UUID, UUID, TEXT, TEXT, TEXT),
  onboarding_batch_view(UUID), onboarding_batches(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_assert_actor(TEXT, TEXT, BOOLEAN), onboarding_create_batch(UUID, TEXT, DATE, TEXT, TEXT, TEXT), onboarding_register_artifact(UUID, JSONB, TEXT, TEXT),
  onboarding_record_completion(UUID, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT), onboarding_waive(UUID, UUID, TEXT, TEXT, TEXT, TEXT),
  onboarding_approve(UUID, UUID, TEXT, TEXT, TEXT), onboarding_advance(UUID, UUID, TEXT, TEXT, TEXT),
  onboarding_batch_view(UUID), onboarding_batches(UUID) TO service_role;

COMMIT;
