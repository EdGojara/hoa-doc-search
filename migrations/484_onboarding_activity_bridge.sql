-- ============================================================================
-- 484_onboarding_activity_bridge.sql  (Issue #15 Milestone 4, Ed 2026-10-03)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Activity Bridge persistence (read-only comparison of the cutoff position with
-- actual Trusted financial activity; lib/onboarding/bridge.js). NOTHING here
-- posts, corrects, cleans up or changes any Trusted record or balance.
--
-- onboarding_bridge_items    append-only; one row per classified event, bound to
--                            the activity-bridge COMPLETION and run, with the
--                            classification (ALREADY_IN_SOURCE / LEGITIMATE_SUBSEQUENT
--                            / AMBIGUOUS / OUT_OF_SCOPE), method, confidence,
--                            evidence, structural issues, bridge sha256 and the
--                            fingerprint of the Trusted activity it saw.
--                            CHECKs: never ALREADY_IN_SOURCE on an amount-only method, nor
--                            on a generic system entry merely dated in the source period.
-- onboarding_bridge_records  append-only; every Trusted record the event covers.
--                            UNIQUE(completion, table, record): the database
--                            itself refuses a record classified twice in one run.
-- onboarding_record_bridge   ONE transaction: the bridge stage result + items +
--                            records; only in stage activity_bridge; must name the
--                            CURRENT snapshot result it was built on; item identity
--                            must equal the batch.
-- onboarding_record_completion  replaced: as 483, plus an activity-bridge result
--                            can only be recorded together with its items.
-- onboarding_bridge_view     read-only: items + records + totals by classification
--                            (events, records, dollars) + stale flag.
--
-- Requires 483. No rows change. Functions executable by service_role only.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_bridge_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  completion_event_id   UUID NOT NULL REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT,
  run_id                UUID NOT NULL REFERENCES conversion_runs(id) ON DELETE RESTRICT,
  bridge_sha256         TEXT NOT NULL CHECK (bridge_sha256 ~ '^[0-9a-f]{64}$'),
  trusted_fingerprint   TEXT NOT NULL CHECK (trusted_fingerprint ~ '^[0-9a-f]{64}$'),
  item_no               INTEGER NOT NULL CHECK (item_no > 0),
  event_key             TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  classification        TEXT NOT NULL CHECK (classification IN ('ALREADY_IN_SOURCE','LEGITIMATE_SUBSEQUENT','AMBIGUOUS','OUT_OF_SCOPE')),
  method                TEXT NOT NULL,
  confidence            TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  event_date            DATE,
  amount_cents          BIGINT NOT NULL,
  evidence              JSONB NOT NULL,
  structural_issues     JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(structural_issues) = 'array'),
  batch_code            TEXT NOT NULL,
  cutoff_date           DATE NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (completion_event_id, item_no),
  UNIQUE (completion_event_id, event_key),
  CONSTRAINT onboarding_bridge_never_duplicate_on_amount CHECK (classification <> 'ALREADY_IN_SOURCE' OR method NOT LIKE 'amount%'),
  CONSTRAINT onboarding_bridge_never_duplicate_on_system_period CHECK (classification <> 'ALREADY_IN_SOURCE' OR method NOT LIKE 'system_entry%')
);
CREATE INDEX IF NOT EXISTS idx_onboarding_bridge_items_completion ON onboarding_bridge_items (completion_event_id, classification);

CREATE TABLE IF NOT EXISTS onboarding_bridge_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_event_id   UUID NOT NULL REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT,
  item_no               INTEGER NOT NULL,
  record_table          TEXT NOT NULL,
  record_id             TEXT NOT NULL,
  UNIQUE (completion_event_id, record_table, record_id),
  FOREIGN KEY (completion_event_id, item_no) REFERENCES onboarding_bridge_items (completion_event_id, item_no) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_onboarding_bridge_records_item ON onboarding_bridge_records (completion_event_id, item_no);

DROP TRIGGER IF EXISTS trg_onboarding_bridge_items_append_only ON onboarding_bridge_items;
CREATE TRIGGER trg_onboarding_bridge_items_append_only BEFORE UPDATE OR DELETE ON onboarding_bridge_items FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
DROP TRIGGER IF EXISTS trg_onboarding_bridge_records_append_only ON onboarding_bridge_records;
CREATE TRIGGER trg_onboarding_bridge_records_append_only BEFORE UPDATE OR DELETE ON onboarding_bridge_records FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
ALTER TABLE onboarding_bridge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_bridge_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON onboarding_bridge_items, onboarding_bridge_records TO service_role;

-- Same as 483, plus: an activity-bridge result only through onboarding_record_bridge (with its items).
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

CREATE OR REPLACE FUNCTION onboarding_record_bridge(p_batch UUID, p_status TEXT, p_open JSONB, p_controls JSONB, p_summary JSONB, p_items JSONB, p_bridge_sha256 TEXT, p_trusted_fingerprint TEXT, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; ev UUID; run UUID; it JSONB; rec TEXT; latest_snap UUID;
BEGIN
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS DISTINCT FROM 'activity_bridge' THEN
    RAISE EXCEPTION 'onboarding: a bridge can only be recorded while the batch is in activity_bridge' USING ERRCODE = 'check_violation';
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

CREATE OR REPLACE FUNCTION onboarding_bridge_view(p_batch UUID, p_completion UUID DEFAULT NULL) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  WITH latest AS (SELECT e.* FROM onboarding_stage_events e WHERE e.batch_id = p_batch AND e.event_type = 'stage_completed' AND e.stage = 'activity_bridge' ORDER BY e.seq DESC LIMIT 1),
  pick AS (SELECT e.* FROM onboarding_stage_events e WHERE e.batch_id = p_batch AND e.event_type = 'stage_completed' AND e.stage = 'activity_bridge'
             AND e.id = coalesce(p_completion, (SELECT id FROM latest)))
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pick) THEN NULL ELSE (SELECT jsonb_build_object(
    'completion_id', p.id, 'status', p.result->>'status', 'bridge_sha256', p.result->'summary'->>'bridge_sha256',
    'trusted_fingerprint', p.result->'summary'->>'trusted_fingerprint', 'snapshot_completion_id', p.result->'summary'->>'snapshot_completion_id',
    'stale', p.id IS DISTINCT FROM (SELECT id FROM latest), 'recorded_at', p.created_at, 'recorded_by', p.actor_id,
    'totals', coalesce((SELECT jsonb_object_agg(classification, jsonb_build_object('events', n, 'records', r, 'amount_cents', a)) FROM (
        SELECT i.classification, count(*) AS n, sum((SELECT count(*) FROM onboarding_bridge_records x WHERE x.completion_event_id = i.completion_event_id AND x.item_no = i.item_no)) AS r, sum(i.amount_cents) AS a
          FROM onboarding_bridge_items i WHERE i.completion_event_id = p.id GROUP BY i.classification) t), '{}'::jsonb),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('item_no', i.item_no, 'event_key', i.event_key, 'kind', i.kind, 'classification', i.classification, 'method', i.method,
                       'confidence', i.confidence, 'event_date', i.event_date, 'amount_cents', i.amount_cents, 'evidence', i.evidence, 'structural_issues', i.structural_issues,
                       'records', (SELECT jsonb_agg(x.record_table || ':' || x.record_id ORDER BY x.record_table, x.record_id) FROM onboarding_bridge_records x WHERE x.completion_event_id = i.completion_event_id AND x.item_no = i.item_no))
                       ORDER BY i.item_no) FROM onboarding_bridge_items i WHERE i.completion_event_id = p.id), '[]'::jsonb)) FROM pick p) END;
$fn$;

REVOKE ALL ON FUNCTION onboarding_record_bridge(UUID, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, TEXT, TEXT), onboarding_bridge_view(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_record_bridge(UUID, TEXT, JSONB, JSONB, JSONB, JSONB, TEXT, TEXT, TEXT, TEXT), onboarding_bridge_view(UUID, UUID) TO service_role;

COMMIT;
