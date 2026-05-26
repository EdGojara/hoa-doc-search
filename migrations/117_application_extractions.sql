-- ============================================================================
-- 117_application_extractions.sql
-- ----------------------------------------------------------------------------
-- Persists the typed, provenance-tagged Application object produced by the
-- new lib/applications/extraction module. Sits between the existing
-- community_applications (raw submission + JSONB application_data) and the
-- forthcoming rules engine (brief 02).
--
-- One row per extraction RUN. Re-extracting a submission appends a new row
-- so the audit trail is preserved — the latest row per application is the
-- canonical view.
--
-- Record ownership: `mixed`. The source PDFs in application_attachments are
-- association_record (homeowner-delivered). The typed JSON + validation
-- flags + AI provenance are workpaper (Bedrock IP). Export tooling filters
-- accordingly per CLAUDE.md three-bucket discipline.
--
-- Apply AFTER 116. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS application_extractions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  community_id                UUID NOT NULL REFERENCES communities(id),

  -- The typed Application object (full schema from brief 01)
  application_json            JSONB NOT NULL,

  -- Denormalized fields for fast query without unpacking the full blob
  request_type                TEXT,                    -- from application_json.request.requestType.value
  unit_match_status           TEXT NOT NULL
                                CHECK (unit_match_status IN ('matched','mismatch','not_found')),
  extraction_confidence       NUMERIC(4, 3) CHECK (extraction_confidence BETWEEN 0 AND 1),
  ready_for_evaluation        BOOLEAN NOT NULL,

  -- Validation flags surfaced as an array of {code, severity, message} so the
  -- queue UI can filter "show me applications with block-severity flags"
  validation_flags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  block_flag_count            INTEGER NOT NULL DEFAULT 0,
  warn_flag_count             INTEGER NOT NULL DEFAULT 0,

  -- Attachments-present rollup (also queryable via application_json but
  -- denormalized for fast queue filtering: "show me apps missing a survey")
  attachments_present         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- AI runtime metadata (for cost + perf tracking)
  ai_model                    TEXT,
  ai_total_input_tokens       INTEGER,
  ai_total_output_tokens      INTEGER,
  ai_total_duration_ms        INTEGER,
  documents_processed         INTEGER NOT NULL DEFAULT 0,

  -- Provenance + audit
  triggered_by                TEXT NOT NULL DEFAULT 'submit'
                                CHECK (triggered_by IN ('submit','manual_re_extract','revision','scheduled')),
  triggered_by_user           TEXT,
  extractor_version           TEXT NOT NULL DEFAULT 'v1',
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Latest extraction per application" is the common read pattern
CREATE INDEX IF NOT EXISTS idx_application_extractions_latest
  ON application_extractions (application_id, created_at DESC);

-- Queue-side filters: pending review with block flags, by community
CREATE INDEX IF NOT EXISTS idx_application_extractions_block_queue
  ON application_extractions (community_id, ready_for_evaluation, created_at DESC)
  WHERE ready_for_evaluation = FALSE;

CREATE INDEX IF NOT EXISTS idx_application_extractions_unit_mismatch
  ON application_extractions (community_id, unit_match_status, created_at DESC)
  WHERE unit_match_status <> 'matched';

-- Convenience view: latest extraction per application
DROP VIEW IF EXISTS v_latest_application_extraction CASCADE;
CREATE VIEW v_latest_application_extraction AS
SELECT DISTINCT ON (application_id)
  application_id, id AS extraction_id, community_id,
  application_json, request_type, unit_match_status, extraction_confidence,
  ready_for_evaluation, validation_flags, block_flag_count, warn_flag_count,
  attachments_present, ai_model, ai_total_input_tokens, ai_total_output_tokens,
  ai_total_duration_ms, documents_processed, triggered_by, extractor_version,
  created_at
FROM application_extractions
ORDER BY application_id, created_at DESC;

GRANT SELECT ON v_latest_application_extraction TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_extractions TO service_role;

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'application_extractions' ORDER BY ordinal_position;
--   -- expect ~17 rows
--   SELECT COUNT(*) FROM v_latest_application_extraction;
--   -- 0 until first extraction runs
