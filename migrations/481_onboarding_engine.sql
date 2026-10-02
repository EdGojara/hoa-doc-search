-- ============================================================================
-- 481_onboarding_engine.sql  (Issue #15, Ed 2026-10-02)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Trusted Onboarding / Conversion Engine, milestone 1 schema. Extends the
-- conversion staging tables from migration 452 (no parallel silo) into a
-- system-agnostic, staged pipeline with hard write gates enforced IN THE
-- DATABASE, mirroring lib/onboarding/stages.js:
--
--   intake -> normalize -> source_controls -> snapshot -> activity_bridge ->
--   preflight -> execute -> post_proof -> complete
--
-- 1. onboarding_artifacts: Stage 0 immutable source intake (original reports
--    and their derived text), with hash, size, provider, report type, period
--    and cutoff, provenance. Append-only: no UPDATE, no DELETE.
-- 2. onboarding_stage_events: append-only audit of every stage completion,
--    advance, control waiver and preflight approval. Advances, waivers and
--    approvals must be made by a HUMAN (CHECK); waivers need a reason;
--    approvals need the preflight sha256.
-- 3. conversion_batches gains onboarding_stage (NULL = legacy batch not run by
--    the engine, e.g. CONV-LPF-20260731), write_locked and
--    approved_preflight_sha256. A guard trigger allows a stage change only one
--    step forward, only with a matching human stage_advanced event, and only
--    into execute with a human approval of the exact preflight hash. The write
--    lock may open only in execute (CHECK).
-- 4. conversion_staged_rows can reference an artifact (canonical rows carry
--    domain, locator and raw source text); conversion_runs gains the stage run
--    kinds; conversion_control_results records level and any declared
--    tolerance (a tolerance without a reason is refused: no plugs).
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

-- 2. Stage events (append-only audit) -----------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_stage_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL CHECK (event_type IN ('stage_completed','stage_advanced','control_waived','preflight_approved')),
  stage             TEXT NOT NULL,
  to_stage          TEXT,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_id          TEXT NOT NULL,
  control_code      TEXT,
  reason            TEXT,
  preflight_sha256  TEXT CHECK (preflight_sha256 IS NULL OR preflight_sha256 ~ '^[0-9a-f]{64}$'),
  result            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT onboarding_events_human_gates CHECK (event_type = 'stage_completed' OR actor_kind = 'human'),
  CONSTRAINT onboarding_events_advance_target CHECK (event_type <> 'stage_advanced' OR to_stage IS NOT NULL),
  CONSTRAINT onboarding_events_waiver_reason CHECK (event_type <> 'control_waived' OR (control_code IS NOT NULL AND length(btrim(coalesce(reason, ''))) >= 10)),
  CONSTRAINT onboarding_events_approval_hash CHECK (event_type <> 'preflight_approved' OR (preflight_sha256 IS NOT NULL AND stage = 'preflight'))
);
CREATE INDEX IF NOT EXISTS idx_onboarding_stage_events_batch ON onboarding_stage_events (batch_id, created_at);
DROP TRIGGER IF EXISTS trg_onboarding_stage_events_append_only ON onboarding_stage_events;
CREATE TRIGGER trg_onboarding_stage_events_append_only BEFORE UPDATE OR DELETE ON onboarding_stage_events
  FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();

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
DECLARE
  stages TEXT[] := ARRAY['intake','normalize','source_controls','snapshot','activity_bridge','preflight','execute','post_proof','complete'];
  i INT;
BEGIN
  -- the approved preflight hash is set once, in preflight, from a human approval event
  IF NEW.approved_preflight_sha256 IS DISTINCT FROM OLD.approved_preflight_sha256 THEN
    IF OLD.approved_preflight_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'approved preflight hash is write-once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.onboarding_stage IS DISTINCT FROM 'preflight' OR NOT EXISTS (
      SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'preflight_approved'
        AND e.actor_kind = 'human' AND e.preflight_sha256 = NEW.approved_preflight_sha256) THEN
      RAISE EXCEPTION 'preflight hash can only be recorded from a human approval in stage preflight' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.onboarding_stage IS NOT DISTINCT FROM OLD.onboarding_stage THEN RETURN NEW; END IF;
  IF OLD.onboarding_stage IS NULL THEN
    -- a legacy batch can be enrolled only at the start
    IF NEW.onboarding_stage <> 'intake' THEN RAISE EXCEPTION 'a batch enters the onboarding engine at intake' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.onboarding_stage IS NULL THEN RAISE EXCEPTION 'onboarding stage cannot be cleared' USING ERRCODE = 'check_violation'; END IF;
  i := array_position(stages, OLD.onboarding_stage);
  IF stages[i + 1] IS DISTINCT FROM NEW.onboarding_stage THEN
    RAISE EXCEPTION 'stage % may only advance to %', OLD.onboarding_stage, stages[i + 1] USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'stage_advanced'
                   AND e.actor_kind = 'human' AND e.stage = OLD.onboarding_stage AND e.to_stage = NEW.onboarding_stage) THEN
    RAISE EXCEPTION 'stage advance needs a human stage_advanced event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.onboarding_stage = 'execute' AND NEW.approved_preflight_sha256 IS NULL THEN
    RAISE EXCEPTION 'execute needs an approved preflight' USING ERRCODE = 'check_violation';
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

ALTER TABLE onboarding_artifacts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_stage_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON onboarding_artifacts, onboarding_stage_events TO service_role;

COMMIT;
