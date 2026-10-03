-- ============================================================================
-- 483_onboarding_snapshot.sql  (Issue #15 Milestone 3, Ed 2026-10-03)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Conversion Snapshot persistence: the read-only proposed opening position at
-- the cutoff, produced by the snapshot stage (lib/onboarding/snapshot.js) from
-- the validated source. NOTHING here posts to the GL, AR, AP or any live table.
--
-- onboarding_snapshot_lines   append-only; every proposed row bound to the
--                             snapshot stage COMPLETION (and its run) that
--                             produced it, with batch code, cutoff, source
--                             provenance and the snapshot sha256. A re-run is a
--                             new completion with new lines; earlier lines stay
--                             as history and are stale (481 binding).
--                             An unsupported_detail row can never name a
--                             homeowner (CHECK): missing detail is reported,
--                             never assigned.
-- onboarding_record_snapshot  ONE transaction: the snapshot stage result (via
--                             onboarding_record_completion) + every line; line
--                             identity must equal the batch's code and cutoff.
-- onboarding_record_completion  replaced: identical, except a snapshot-stage
--                             result can only be recorded together with its
--                             lines (through onboarding_record_snapshot).
-- onboarding_snapshot_view    read-only; lines + components + stale flag.
-- onboarding_batch_view       replaced: latest_by_stage also carries each
--                             result's summary (the snapshot reads the roles
--                             the source-controls stage was run with).
--
-- Requires 482. No rows change. Functions executable by service_role only.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_snapshot_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  completion_event_id   UUID NOT NULL REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT,
  run_id                UUID NOT NULL REFERENCES conversion_runs(id) ON DELETE RESTRICT,
  snapshot_sha256       TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  line_no               INTEGER NOT NULL CHECK (line_no > 0),
  kind                  TEXT NOT NULL CHECK (kind IN ('gl_opening_balance','ar_detail','ar_aging_item','prepaid_detail','ap_detail','unsupported_detail')),
  component             TEXT NOT NULL,
  account_code          TEXT,
  fund_code             TEXT,
  source_account_key    TEXT,
  amount_cents          BIGINT NOT NULL,
  detail                JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance            JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'array' AND jsonb_array_length(provenance) > 0),
  batch_code            TEXT NOT NULL,
  cutoff_date           DATE NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (completion_event_id, line_no),
  CONSTRAINT onboarding_snapshot_unsupported_never_assigned CHECK (kind <> 'unsupported_detail' OR source_account_key IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_onboarding_snapshot_lines_completion ON onboarding_snapshot_lines (completion_event_id, line_no);
CREATE INDEX IF NOT EXISTS idx_onboarding_snapshot_lines_batch ON onboarding_snapshot_lines (batch_id);
DROP TRIGGER IF EXISTS trg_onboarding_snapshot_lines_append_only ON onboarding_snapshot_lines;
CREATE TRIGGER trg_onboarding_snapshot_lines_append_only BEFORE UPDATE OR DELETE ON onboarding_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
ALTER TABLE onboarding_snapshot_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON onboarding_snapshot_lines TO service_role;

-- Same as 482, plus: a snapshot-stage result only through onboarding_record_snapshot (with its lines).
CREATE OR REPLACE FUNCTION onboarding_record_completion(p_batch UUID, p_stage TEXT, p_status TEXT, p_open JSONB, p_controls JSONB, p_summary JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; derived TEXT; derived_open JSONB; run UUID; ev UUID; c JSONB;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  IF p_stage = 'snapshot' AND coalesce(current_setting('onboarding.snapshot_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'onboarding: a snapshot result must be recorded with its lines (onboarding_record_snapshot)' USING ERRCODE = 'check_violation';
  END IF;
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

CREATE OR REPLACE FUNCTION onboarding_record_snapshot(p_batch UUID, p_status TEXT, p_open JSONB, p_controls JSONB, p_summary JSONB, p_lines JSONB, p_snapshot_sha256 TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; ev UUID; run UUID; l JSONB; n INT := 0;
BEGIN
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS DISTINCT FROM 'snapshot' THEN
    RAISE EXCEPTION 'onboarding: a snapshot can only be recorded while the batch is in snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF p_snapshot_sha256 IS NULL OR p_snapshot_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'onboarding: snapshot sha256 required' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'onboarding: snapshot lines must be an array' USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('onboarding.snapshot_writer', 'on', true);
  ev := onboarding_record_completion(p_batch, 'snapshot', p_status, p_open, p_controls,
          coalesce(p_summary, '{}'::jsonb) || jsonb_build_object('snapshot_sha256', p_snapshot_sha256, 'line_count', jsonb_array_length(p_lines)),
          p_actor_kind, p_actor_id);
  PERFORM set_config('onboarding.snapshot_writer', 'off', true);
  SELECT (result->>'run_id')::uuid INTO run FROM onboarding_stage_events WHERE id = ev;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF l->>'batch_code' IS DISTINCT FROM bt.batch_code OR (l->>'cutoff_date')::date IS DISTINCT FROM bt.as_of_date THEN
      RAISE EXCEPTION 'onboarding: snapshot line % identity (%, %) does not match the batch (%, %)', l->>'line_no', l->>'batch_code', l->>'cutoff_date', bt.batch_code, bt.as_of_date USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO onboarding_snapshot_lines (batch_id, completion_event_id, run_id, snapshot_sha256, line_no, kind, component, account_code, fund_code, source_account_key,
                                           amount_cents, detail, provenance, batch_code, cutoff_date)
    VALUES (p_batch, ev, run, p_snapshot_sha256, (l->>'line_no')::int, l->>'kind', l->>'component', l->>'account_code', l->>'fund_code', l->>'source_account_key',
            (l->>'amount_cents')::bigint, coalesce(l->'detail', '{}'::jsonb), l->'provenance', l->>'batch_code', (l->>'cutoff_date')::date);
    n := n + 1;
  END LOOP;
  RETURN ev;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_snapshot_view(p_batch UUID, p_completion UUID DEFAULT NULL) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  WITH latest AS (SELECT e.* FROM onboarding_stage_events e WHERE e.batch_id = p_batch AND e.event_type = 'stage_completed' AND e.stage = 'snapshot' ORDER BY e.seq DESC LIMIT 1),
  pick AS (SELECT e.* FROM onboarding_stage_events e WHERE e.batch_id = p_batch AND e.event_type = 'stage_completed' AND e.stage = 'snapshot'
             AND e.id = coalesce(p_completion, (SELECT id FROM latest)))
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pick) THEN NULL ELSE (SELECT jsonb_build_object(
    'completion_id', p.id, 'status', p.result->>'status', 'snapshot_sha256', p.result->'summary'->>'snapshot_sha256',
    'components', p.result->'summary'->'components', 'stale', p.id IS DISTINCT FROM (SELECT id FROM latest), 'recorded_at', p.created_at, 'recorded_by', p.actor_id,
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('line_no', s.line_no, 'kind', s.kind, 'component', s.component, 'account_code', s.account_code, 'fund_code', s.fund_code,
                       'source_account_key', s.source_account_key, 'amount_cents', s.amount_cents, 'detail', s.detail, 'provenance', s.provenance) ORDER BY s.line_no)
                       FROM onboarding_snapshot_lines s WHERE s.completion_event_id = p.id), '[]'::jsonb)) FROM pick p) END;
$fn$;

-- Same as 482, plus each latest result carries its summary.
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
                                        'run_id', l.result->>'run_id', 'summary', l.result->'summary', 'by', l.actor_id, 'actor_kind', l.actor_kind, 'at', l.created_at)) FROM latest l), '{}'::jsonb),
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

REVOKE ALL ON FUNCTION onboarding_record_snapshot(UUID, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, TEXT), onboarding_snapshot_view(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_record_snapshot(UUID, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, TEXT), onboarding_snapshot_view(UUID, UUID) TO service_role;

COMMIT;
