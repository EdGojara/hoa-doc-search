-- ============================================================================
-- 476_agent_runs_model_telemetry.sql  (Issue #12)
-- ----------------------------------------------------------------------------
-- Per-call AI model telemetry on the EXISTING trade tape (agent_runs) instead
-- of a parallel table. lib/ai/router.js writes one row per model call with
-- run_kind = 'model_call' (no prompt or response is stored on these rows):
-- workflow, provider, requested vs executed model (agent_runs.model), whether a
-- fallback ran and why, where the routing came from (config / env override /
-- scoped test override), outcome, tokens incl. cache, latency (duration_ms) and
-- estimated cost (cost_usd). Existing trade-tape rows keep run_kind NULL.
--
-- Record ownership: workpaper (Bedrock's operating telemetry, not an
-- association record). No existing row is changed; all new columns are
-- nullable or defaulted.
-- ============================================================================
BEGIN;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS run_kind           TEXT,
  ADD COLUMN IF NOT EXISTS workflow           TEXT,
  ADD COLUMN IF NOT EXISTS provider           TEXT,
  ADD COLUMN IF NOT EXISTS requested_model    TEXT,
  ADD COLUMN IF NOT EXISTS fallback_used      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fallback_reason    TEXT,
  ADD COLUMN IF NOT EXISTS route_source       TEXT,
  ADD COLUMN IF NOT EXISTS ok                 BOOLEAN,
  ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_run_kind_check') THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_kind_check CHECK (run_kind IS NULL OR run_kind IN ('trade_tape', 'model_call'));
  END IF;
  -- A model_call row always names its workflow and says whether it worked.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_model_call_shape') THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_model_call_shape CHECK (run_kind IS DISTINCT FROM 'model_call' OR (workflow IS NOT NULL AND requested_model IS NOT NULL AND ok IS NOT NULL));
  END IF;
  -- A fallback must say why.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_fallback_reason') THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_fallback_reason CHECK (NOT fallback_used OR fallback_reason IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_runs_model_calls ON agent_runs (workflow, created_at) WHERE run_kind = 'model_call';
CREATE INDEX IF NOT EXISTS idx_agent_runs_fallbacks   ON agent_runs (created_at) WHERE fallback_used;

COMMIT;
