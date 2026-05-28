-- ============================================================================
-- 125_vantaca_preview_jobs.sql
-- ----------------------------------------------------------------------------
-- Persists the Vantaca violation import preview-job state in Postgres so
-- in-flight imports survive Render deploys + Node process restarts + idle
-- timeouts. Previously the job state lived in an in-memory Map on the
-- enforcement router; any process restart wiped all running jobs, leaving
-- the operator's UI stuck polling against a job that no longer existed.
--
-- This is operational infrastructure (workpaper) — not part of the
-- enforcement timeline itself. Old jobs auto-cleanup after 24 hours via
-- app-level pruning at job creation time.
--
-- Apply AFTER 124. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS vantaca_preview_jobs (
  id              TEXT PRIMARY KEY,          -- hex string job_id allocated by the router
  community_id    UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'complete', 'error')),
  progress        TEXT,                       -- human-readable progress text shown in the UI
  result          JSONB,                      -- the preview-shape payload once status=complete
  cached_rows     JSONB,                      -- raw extracted rows so re-resolve can run without re-extracting the PDF
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vvpj_created
  ON vantaca_preview_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vvpj_community
  ON vantaca_preview_jobs (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vvpj_running
  ON vantaca_preview_jobs (status, created_at DESC)
  WHERE status = 'running';

DROP TRIGGER IF EXISTS trg_vvpj_updated_at ON vantaca_preview_jobs;
CREATE TRIGGER trg_vvpj_updated_at
  BEFORE UPDATE ON vantaca_preview_jobs
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE vantaca_preview_jobs IS
  'Workpaper. Preview-job state for the Vantaca violation import workflow. Persists across Render restarts so in-flight extractions survive deploys. Auto-pruned at >24h by the router on new job creation.';

GRANT INSERT, SELECT, UPDATE, DELETE ON vantaca_preview_jobs TO service_role;
GRANT SELECT ON vantaca_preview_jobs TO authenticated;

COMMIT;
