-- ============================================================================
-- 497_onboarding_bridge_refresh_at_preflight.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- A batch in PREFLIGHT could never recover from ordinary new Trusted activity:
-- stages only move forward, a bridge could only be recorded in activity_bridge,
-- and the preflight requires a bridge built on the CURRENT Trusted activity.
-- Canyon Gate (CONV-CGACR-20260731) was stranded minutes after a PASS preflight
-- by a routine post-cutoff Bedrock invoice (2609CG2, $561.72).
--
-- Fix: a refreshed activity-bridge result may be recorded while the batch is in
-- preflight, through onboarding_record_bridge only (same item, snapshot and
-- fingerprint rules). The stage does not move; the preflight is then rebuilt on
-- the refreshed bridge and must be re-approved (the approval binds its hash).
-- Owner decisions carry forward only where they answer the same question about
-- the same transaction (unchanged rule). Nothing else changes.
-- Record ownership: workpaper (unchanged).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION onboarding_record_completion(p_batch UUID, p_stage TEXT, p_status TEXT, p_open JSONB, p_controls JSONB, p_summary JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; derived TEXT; derived_open JSONB; run UUID; ev UUID; c JSONB;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  IF p_stage = 'snapshot' AND coalesce(current_setting('onboarding.snapshot_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'onboarding: a snapshot result must be recorded with its lines (onboarding_record_snapshot)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_stage = 'activity_bridge' AND coalesce(current_setting('onboarding.bridge_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'onboarding: an activity-bridge result must be recorded with its items (onboarding_record_bridge)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  -- 497: a REFRESHED activity-bridge result may be recorded while the batch is in preflight (only through
  -- onboarding_record_bridge, which sets the bridge writer); every other stage result still needs its own stage.
  IF NOT FOUND OR (bt.onboarding_stage IS DISTINCT FROM p_stage
                   AND NOT (p_stage = 'activity_bridge' AND bt.onboarding_stage = 'preflight' AND coalesce(current_setting('onboarding.bridge_writer', true), 'off') = 'on')) THEN
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

CREATE OR REPLACE FUNCTION onboarding_record_bridge(p_batch UUID, p_status TEXT, p_open JSONB, p_controls JSONB, p_summary JSONB, p_items JSONB, p_bridge_sha256 TEXT, p_trusted_fingerprint TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; ev UUID; run UUID; it JSONB; rec TEXT; latest_snap UUID;
BEGIN
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage NOT IN ('activity_bridge', 'preflight') THEN
    RAISE EXCEPTION 'onboarding: a bridge can only be recorded while the batch is in activity_bridge (or refreshed in preflight)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_bridge_sha256 IS NULL OR p_bridge_sha256 !~ '^[0-9a-f]{64}$' OR p_trusted_fingerprint IS NULL OR p_trusted_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'onboarding: bridge sha256 and Trusted activity fingerprint required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.id INTO latest_snap FROM onboarding_stage_events e WHERE e.batch_id = p_batch AND e.event_type = 'stage_completed' AND e.stage = 'snapshot' ORDER BY e.seq DESC LIMIT 1;
  IF latest_snap IS NULL OR (p_summary->>'snapshot_completion_id')::uuid IS DISTINCT FROM latest_snap THEN
    RAISE EXCEPTION 'onboarding: the bridge must be built on the current snapshot result' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'onboarding: bridge items must be an array' USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('onboarding.bridge_writer', 'on', true);
  ev := onboarding_record_completion(p_batch, 'activity_bridge', p_status, p_open, p_controls,
          coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('bridge_sha256', p_bridge_sha256, 'trusted_fingerprint', p_trusted_fingerprint, 'item_count', jsonb_array_length(p_items)),
          p_actor_kind, p_actor_id);
  PERFORM set_config('onboarding.bridge_writer', 'off', true);
  SELECT (result->>'run_id')::uuid INTO run FROM onboarding_stage_events WHERE id = ev;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF it->>'batch_code' IS DISTINCT FROM bt.batch_code OR (it->>'cutoff_date')::date IS DISTINCT FROM bt.as_of_date THEN
      RAISE EXCEPTION 'onboarding: bridge item % identity does not match the batch', it->>'item_no' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO onboarding_bridge_items (batch_id, completion_event_id, run_id, bridge_sha256, trusted_fingerprint, item_no, event_key, kind, classification, method, confidence,
                                         event_date, amount_cents, evidence, structural_issues, batch_code, cutoff_date)
    VALUES (p_batch, ev, run, p_bridge_sha256, p_trusted_fingerprint, (it->>'item_no')::int, it->>'event_key', it->>'kind', it->>'classification', it->>'method', it->>'confidence',
            (it->>'event_date')::date, (it->>'amount_cents')::bigint, coalesce(it->'evidence', '{}'::jsonb), coalesce(it->'structural_issues', '[]'::jsonb), it->>'batch_code', (it->>'cutoff_date')::date);
    FOR rec IN SELECT * FROM jsonb_array_elements_text(it->'records') LOOP
      INSERT INTO onboarding_bridge_records (completion_event_id, item_no, record_table, record_id)
      VALUES (ev, (it->>'item_no')::int, split_part(rec, ':', 1), substr(rec, length(split_part(rec, ':', 1)) + 2));   -- UNIQUE: a record classified twice is refused
    END LOOP;
  END LOOP;
  RETURN ev;
END;
$fn$;

-- Same as 485, plus the 497 exception above.
CREATE OR REPLACE FUNCTION onboarding_stage_events_validate() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE cur TEXT; c onboarding_stage_events%ROWTYPE; why TEXT;
BEGIN
  SELECT onboarding_stage INTO cur FROM conversion_batches WHERE id = NEW.batch_id;
  -- 497: a refreshed activity-bridge RESULT may be recorded while the batch is in preflight, only by
  -- onboarding_record_bridge (bridge writer on). Waivers, advances and approvals still need their own stage.
  IF cur IS NULL OR (cur <> NEW.stage AND NOT (NEW.event_type = 'stage_completed' AND NEW.stage = 'activity_bridge' AND cur = 'preflight'
                                             AND coalesce(current_setting('onboarding.bridge_writer', true), 'off') = 'on')) THEN
    RAISE EXCEPTION 'event for stage % but the batch is in %', NEW.stage, coalesce(cur, '(not enrolled)') USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_type = 'stage_completed' THEN RETURN NEW; END IF;
  SELECT * INTO c FROM onboarding_stage_events WHERE id = NEW.completion_event_id;
  IF NOT FOUND OR c.event_type <> 'stage_completed' OR c.batch_id <> NEW.batch_id OR c.stage <> NEW.stage THEN
    RAISE EXCEPTION 'event must reference a completion of this batch and stage' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM onboarding_stage_events l WHERE l.batch_id = c.batch_id AND l.stage = c.stage AND l.event_type = 'stage_completed' AND l.seq > c.seq) THEN
    RAISE EXCEPTION 'completion is stale: a newer result was recorded for stage %', c.stage USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_type = 'control_waived' THEN
    IF NOT (c.result->'open_controls') ? NEW.control_code THEN
      RAISE EXCEPTION '% is not an open control of that result', NEW.control_code USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM onboarding_stage_events w WHERE w.completion_event_id = c.id AND w.event_type = 'control_waived' AND w.control_code = NEW.control_code) THEN
      RAISE EXCEPTION '% is already waived for that result', NEW.control_code USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'stage_advanced' THEN
    IF NEW.to_stage IS DISTINCT FROM onboarding_next_stage(NEW.stage) THEN
      RAISE EXCEPTION 'stage % may only advance to %', NEW.stage, onboarding_next_stage(NEW.stage) USING ERRCODE = 'check_violation';
    END IF;
    why := onboarding_completion_gate(c.id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'advance refused: %', why USING ERRCODE = 'check_violation'; END IF;
    -- The operator (actor_kind 'system') may advance ONLY on a plain PASS result (never a
    -- waived FAIL/BLOCKED) and only into routine stages; never into execute or beyond.
    IF NEW.actor_kind = 'system' AND (c.result->>'status' IS DISTINCT FROM 'PASS' OR NEW.to_stage NOT IN ('normalize','source_controls','snapshot','activity_bridge','preflight')) THEN
      RAISE EXCEPTION 'operator advance refused: only a PASS result may advance automatically, and never into %', NEW.to_stage USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'preflight_approved' THEN
    why := onboarding_completion_gate(c.id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'approval refused: %', why USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMIT;
