-- ============================================================================
-- 481_onboarding_engine.sql  (Issue #15, Ed 2026-10-02)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Trusted Onboarding / Conversion Engine, milestone 1 schema. Extends the
-- conversion staging tables from migration 452 (no parallel silo) into a
-- system-agnostic, staged pipeline with hard write gates enforced IN THE
-- DATABASE, with the same substance as lib/onboarding/stages.js:
--
--   intake -> normalize -> source_controls -> snapshot -> activity_bridge ->
--   preflight -> execute -> post_proof -> complete
--
-- 1. onboarding_artifacts: Stage 0 immutable source intake (original reports
--    and their derived text), with hash, size, provider, report type, period
--    and cutoff, provenance. Append-only: no UPDATE, no DELETE.
-- 2. onboarding_stage_events: append-only, totally ordered (seq) audit of every
--    stage completion, control waiver, preflight approval and stage advance.
--      - A completion records the stage result: status PASS / FAIL / BLOCKED
--        and its open controls (none for PASS, at least one otherwise).
--      - Waivers, approvals and advances must be HUMAN and must reference the
--        completion they rely on, which must be the LATEST completion of the
--        batch's CURRENT stage. A waiver covers one OPEN control of that
--        completion, once, with a reason. An advance is accepted only if that
--        completion is PASS or every one of its open controls has a human
--        waiver bound to it. Re-running a stage (a new completion) makes every
--        earlier waiver, approval and advance stale: they cannot authorize the
--        new result. Checked when the event is inserted (insert trigger).
-- 3. conversion_batches gains onboarding_stage (NULL = legacy batch not run by
--    the engine, e.g. CONV-LPF-20260731), write_locked and
--    approved_preflight_sha256. The guard trigger RE-PROVES the gate when the
--    stage changes: one step forward; the latest human advance event for that
--    step; its completion still the latest for the stage; PASS or every open
--    control waived for that completion. Into execute additionally: the
--    approved preflight hash, from a human approval bound to that same
--    completion. The write lock may open only in execute (CHECK) and re-locks
--    on leaving it.
-- 4. conversion_staged_rows can reference an artifact (canonical rows carry
--    domain, locator and raw source text); conversion_runs gains the stage run
--    kinds; conversion_control_results records level, any declared tolerance
--    (needs a reason: no plugs) and a WAIVED disposition that never changes the
--    control's status: a waived FAIL stays FAIL, with who / why / when and the
--    waiver event.
--
-- Record ownership (CLAUDE.md): artifacts are the association's source
-- records (association_record); stage events, runs and results are Bedrock
-- working papers (workpaper). All community-scoped via conversion_batches.
-- Purely additive except relaxing conversion_staged_rows.source_file_id to
-- nullable (an artifact row may stand in for it) and widening one CHECK.
-- No rows change.
-- ============================================================================
BEGIN;

-- 1. Immutable source intake -------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_artifacts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  source_system        TEXT NOT NULL,
  artifact_type        TEXT NOT NULL,
  filename             TEXT NOT NULL,
  version_label        TEXT,
  period_start         DATE,
  period_end           DATE,
  cutoff_date          DATE NOT NULL,
  sha256               TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes                BIGINT NOT NULL CHECK (bytes >= 0),
  storage_path         TEXT,
  derived_from_sha256  TEXT CHECK (derived_from_sha256 IS NULL OR derived_from_sha256 ~ '^[0-9a-f]{64}$'),
  supplied_by          TEXT,
  provenance           JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_ownership     TEXT NOT NULL DEFAULT 'association_record' CHECK (record_ownership = 'association_record'),
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_onboarding_artifacts_batch ON onboarding_artifacts (batch_id, artifact_type);

CREATE OR REPLACE FUNCTION onboarding_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only (onboarding record)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$fn$;
DROP TRIGGER IF EXISTS trg_onboarding_artifacts_append_only ON onboarding_artifacts;
CREATE TRIGGER trg_onboarding_artifacts_append_only BEFORE UPDATE OR DELETE ON onboarding_artifacts
  FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();

-- 2. Stage events (append-only, ordered audit) ---------------------------------
CREATE TABLE IF NOT EXISTS onboarding_stage_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                  BIGINT GENERATED ALWAYS AS IDENTITY,       -- total order; "latest" is by seq, never by clock
  batch_id             UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  event_type           TEXT NOT NULL CHECK (event_type IN ('stage_completed','control_waived','preflight_approved','stage_advanced')),
  stage                TEXT NOT NULL,
  to_stage             TEXT,
  completion_event_id  UUID REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_id             TEXT NOT NULL,
  control_code         TEXT,
  reason               TEXT,
  preflight_sha256     TEXT CHECK (preflight_sha256 IS NULL OR preflight_sha256 ~ '^[0-9a-f]{64}$'),
  result               JSONB NOT NULL DEFAULT '{}'::jsonb,       -- completion: { status, open_controls: [codes], ... }
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seq),
  CONSTRAINT onboarding_events_human_gates CHECK (event_type = 'stage_completed' OR actor_kind = 'human'),
  CONSTRAINT onboarding_events_bound_to_completion CHECK ((event_type = 'stage_completed') = (completion_event_id IS NULL)),
  CONSTRAINT onboarding_events_completion_result CHECK (event_type <> 'stage_completed' OR (
    result->>'status' IN ('PASS','FAIL','BLOCKED')
    AND jsonb_typeof(result->'open_controls') = 'array'
    AND ((result->>'status' = 'PASS') = (jsonb_array_length(result->'open_controls') = 0)))),
  CONSTRAINT onboarding_events_advance_target CHECK (event_type <> 'stage_advanced' OR to_stage IS NOT NULL),
  CONSTRAINT onboarding_events_waiver_reason CHECK (event_type <> 'control_waived' OR (control_code IS NOT NULL AND length(btrim(coalesce(reason, ''))) >= 10)),
  CONSTRAINT onboarding_events_approval_hash CHECK (event_type <> 'preflight_approved' OR (preflight_sha256 IS NOT NULL AND stage = 'preflight'))
);
CREATE INDEX IF NOT EXISTS idx_onboarding_stage_events_batch ON onboarding_stage_events (batch_id, stage, event_type, seq);
DROP TRIGGER IF EXISTS trg_onboarding_stage_events_append_only ON onboarding_stage_events;
CREATE TRIGGER trg_onboarding_stage_events_append_only BEFORE UPDATE OR DELETE ON onboarding_stage_events
  FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();

-- Next stage after s (NULL at the end).
CREATE OR REPLACE FUNCTION onboarding_next_stage(s TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (ARRAY['intake','normalize','source_controls','snapshot','activity_bridge','preflight','execute','post_proof','complete'])
         [array_position(ARRAY['intake','normalize','source_controls','snapshot','activity_bridge','preflight','execute','post_proof','complete'], s) + 1];
$fn$;

-- Is completion c the latest completion of its stage, and is it PASS or fully human-waived?
-- Returns NULL when the gate holds, otherwise the reason it does not.
CREATE OR REPLACE FUNCTION onboarding_completion_gate(c_id UUID) RETURNS TEXT LANGUAGE plpgsql STABLE AS $fn$
DECLARE c onboarding_stage_events%ROWTYPE; unwaived TEXT;
BEGIN
  SELECT * INTO c FROM onboarding_stage_events WHERE id = c_id;
  IF NOT FOUND OR c.event_type <> 'stage_completed' THEN RETURN 'not a stage completion'; END IF;
  IF EXISTS (SELECT 1 FROM onboarding_stage_events l WHERE l.batch_id = c.batch_id AND l.stage = c.stage
               AND l.event_type = 'stage_completed' AND l.seq > c.seq) THEN
    RETURN 'a newer result was recorded for stage ' || c.stage;
  END IF;
  IF c.result->>'status' = 'PASS' THEN RETURN NULL; END IF;
  SELECT string_agg(code, ', ') INTO unwaived
    FROM jsonb_array_elements_text(c.result->'open_controls') AS code
   WHERE NOT EXISTS (SELECT 1 FROM onboarding_stage_events w WHERE w.completion_event_id = c.id
                       AND w.event_type = 'control_waived' AND w.actor_kind = 'human' AND w.control_code = code);
  IF unwaived IS NOT NULL THEN RETURN 'stage ' || c.stage || ' is ' || (c.result->>'status') || '; not waived: ' || unwaived; END IF;
  RETURN NULL;
END;
$fn$;

-- Every event is validated against the batch's CURRENT stage and the completion it relies on.
CREATE OR REPLACE FUNCTION onboarding_stage_events_validate() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE cur TEXT; c onboarding_stage_events%ROWTYPE; why TEXT;
BEGIN
  SELECT onboarding_stage INTO cur FROM conversion_batches WHERE id = NEW.batch_id;
  IF cur IS NULL OR cur <> NEW.stage THEN
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
  ELSIF NEW.event_type = 'preflight_approved' THEN
    why := onboarding_completion_gate(c.id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'approval refused: %', why USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_onboarding_stage_events_validate ON onboarding_stage_events;
CREATE TRIGGER trg_onboarding_stage_events_validate BEFORE INSERT ON onboarding_stage_events
  FOR EACH ROW EXECUTE FUNCTION onboarding_stage_events_validate();

-- 3. Batch stage + write gate --------------------------------------------------
ALTER TABLE conversion_batches ADD COLUMN IF NOT EXISTS onboarding_stage TEXT;
ALTER TABLE conversion_batches ADD COLUMN IF NOT EXISTS write_locked BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE conversion_batches ADD COLUMN IF NOT EXISTS approved_preflight_sha256 TEXT;
ALTER TABLE conversion_batches DROP CONSTRAINT IF EXISTS conversion_batches_onboarding_stage_check;
ALTER TABLE conversion_batches ADD CONSTRAINT conversion_batches_onboarding_stage_check
  CHECK (onboarding_stage IS NULL OR onboarding_stage IN ('intake','normalize','source_controls','snapshot','activity_bridge','preflight','execute','post_proof','complete'));
ALTER TABLE conversion_batches DROP CONSTRAINT IF EXISTS conversion_batches_write_lock_only_in_execute;
ALTER TABLE conversion_batches ADD CONSTRAINT conversion_batches_write_lock_only_in_execute
  CHECK (write_locked OR onboarding_stage = 'execute');

CREATE OR REPLACE FUNCTION conversion_batches_onboarding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE adv onboarding_stage_events%ROWTYPE; why TEXT;
BEGIN
  -- The approved preflight hash is set once, in preflight, from a human approval
  -- bound to the CURRENT (latest) preflight result.
  IF NEW.approved_preflight_sha256 IS DISTINCT FROM OLD.approved_preflight_sha256 THEN
    IF OLD.approved_preflight_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'approved preflight hash is write-once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.onboarding_stage IS DISTINCT FROM 'preflight' OR NOT EXISTS (
      SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'preflight_approved'
        AND e.actor_kind = 'human' AND e.preflight_sha256 = NEW.approved_preflight_sha256
        AND onboarding_completion_gate(e.completion_event_id) IS NULL) THEN
      RAISE EXCEPTION 'preflight hash can only be recorded from a human approval of the current preflight result' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.onboarding_stage IS NOT DISTINCT FROM OLD.onboarding_stage THEN RETURN NEW; END IF;
  IF OLD.onboarding_stage IS NULL THEN
    -- a legacy batch can be enrolled only at the start
    IF NEW.onboarding_stage <> 'intake' THEN RAISE EXCEPTION 'a batch enters the onboarding engine at intake' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.onboarding_stage IS NULL THEN RAISE EXCEPTION 'onboarding stage cannot be cleared' USING ERRCODE = 'check_violation'; END IF;
  IF onboarding_next_stage(OLD.onboarding_stage) IS DISTINCT FROM NEW.onboarding_stage THEN
    RAISE EXCEPTION 'stage % may only advance to %', OLD.onboarding_stage, onboarding_next_stage(OLD.onboarding_stage) USING ERRCODE = 'check_violation';
  END IF;
  -- The latest human advance event for this step, re-proved now (its completion must
  -- still be the latest result, and PASS or fully human-waived).
  SELECT * INTO adv FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'stage_advanced'
     AND e.actor_kind = 'human' AND e.stage = OLD.onboarding_stage AND e.to_stage = NEW.onboarding_stage
   ORDER BY e.seq DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'stage advance needs a human stage_advanced event' USING ERRCODE = 'check_violation'; END IF;
  why := onboarding_completion_gate(adv.completion_event_id);
  IF why IS NOT NULL THEN RAISE EXCEPTION 'stage advance refused: %', why USING ERRCODE = 'check_violation'; END IF;
  IF NEW.onboarding_stage = 'execute' THEN
    IF NEW.approved_preflight_sha256 IS NULL OR NOT EXISTS (
      SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'preflight_approved' AND e.actor_kind = 'human'
        AND e.preflight_sha256 = NEW.approved_preflight_sha256 AND e.completion_event_id = adv.completion_event_id) THEN
      RAISE EXCEPTION 'execute needs an approved preflight for the current preflight result' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.onboarding_stage <> 'execute' THEN NEW.write_locked := TRUE; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_conversion_batches_onboarding_guard ON conversion_batches;
CREATE TRIGGER trg_conversion_batches_onboarding_guard BEFORE UPDATE ON conversion_batches
  FOR EACH ROW EXECUTE FUNCTION conversion_batches_onboarding_guard();

-- 4. Canonical staged rows, stage runs, control results ------------------------
ALTER TABLE conversion_staged_rows ADD COLUMN IF NOT EXISTS artifact_id UUID REFERENCES onboarding_artifacts(id) ON DELETE RESTRICT;
ALTER TABLE conversion_staged_rows ADD COLUMN IF NOT EXISTS canonical_domain TEXT;
ALTER TABLE conversion_staged_rows ADD COLUMN IF NOT EXISTS source_locator JSONB;
ALTER TABLE conversion_staged_rows ADD COLUMN IF NOT EXISTS raw_source TEXT;
ALTER TABLE conversion_staged_rows ALTER COLUMN source_file_id DROP NOT NULL;
ALTER TABLE conversion_staged_rows DROP CONSTRAINT IF EXISTS conversion_staged_rows_has_source;
ALTER TABLE conversion_staged_rows ADD CONSTRAINT conversion_staged_rows_has_source
  CHECK (source_file_id IS NOT NULL OR (artifact_id IS NOT NULL AND canonical_domain IS NOT NULL AND source_locator IS NOT NULL AND raw_source IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_conversion_staged_rows_artifact ON conversion_staged_rows (artifact_id) WHERE artifact_id IS NOT NULL;

ALTER TABLE conversion_runs DROP CONSTRAINT IF EXISTS conversion_runs_run_kind_check;
ALTER TABLE conversion_runs ADD CONSTRAINT conversion_runs_run_kind_check
  CHECK (run_kind IN ('dry_run','normalize','source_controls','snapshot','activity_bridge','preflight','post_proof'));

ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS level TEXT;
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS tolerance_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS tolerance_reason TEXT;
ALTER TABLE conversion_control_results DROP CONSTRAINT IF EXISTS conversion_control_results_tolerance_declared;
ALTER TABLE conversion_control_results ADD CONSTRAINT conversion_control_results_tolerance_declared
  CHECK (tolerance_cents = 0 OR length(btrim(coalesce(tolerance_reason, ''))) > 0);
-- Waiver disposition: recorded NEXT TO the result; status / amounts / difference stay as computed.
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS disposition TEXT;
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS waived_by TEXT;
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS waiver_reason TEXT;
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ;
ALTER TABLE conversion_control_results ADD COLUMN IF NOT EXISTS waiver_event_id UUID REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT;
ALTER TABLE conversion_control_results DROP CONSTRAINT IF EXISTS conversion_control_results_waiver_disposition;
ALTER TABLE conversion_control_results ADD CONSTRAINT conversion_control_results_waiver_disposition
  CHECK (disposition IS NULL OR (disposition = 'WAIVED' AND status IN ('FAIL','BLOCKED') AND waived_by IS NOT NULL
         AND length(btrim(coalesce(waiver_reason, ''))) >= 10 AND waived_at IS NOT NULL AND waiver_event_id IS NOT NULL));

ALTER TABLE onboarding_artifacts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_stage_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON onboarding_artifacts, onboarding_stage_events TO service_role;

COMMIT;
