-- ============================================================================
-- 027_arc_historical_decisions.sql
-- ----------------------------------------------------------------------------
-- Structured store for historical ARC (Architectural Control Committee)
-- decisions imported from approval/denial letters and meeting-minute excerpts.
--
-- Strategic framing — repeating Ed's direction (see migration 022):
--   - Treated as INFORMATIONAL CONTEXT by the AI assessment engine
--   - NOT binding precedent
--   - Bedrock applies CURRENT governing documents as authority
--   - Past inconsistencies documented but do not perpetuate
--
-- The existing `documents` table (migration 013) already accepts uploads
-- tagged with category='arc_historical_decision' and embeds them for AskEd
-- general retrieval. This NEW table captures STRUCTURED extracted fields
-- (decision type, project type, decided date, conditions, etc.) so the
-- AI assessment engine can do semantic matching against similar past
-- applications and inject decision summaries — not raw chunks — into
-- prompts.
--
-- Apply AFTER 026. Idempotent.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS arc_historical_decisions (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  -- Source — we snapshot the filename + first chars of raw text so we
  -- never lose attribution, regardless of whether the source PDF gets
  -- stored elsewhere in the document library.
  source_filename          TEXT,
  source_excerpt           TEXT,                                  -- short snippet of raw text for review UI

  -- Structured extraction
  property_address         TEXT,
  homeowner_name           TEXT,
  project_type             TEXT,                                  -- 'fence' | 'paint' | 'addition' | 'pool' | 'deck' | 'landscaping' | 'roof' | 'door' | 'window' | 'shed' | 'mailbox' | 'driveway' | 'tree' | 'other'
  project_description      TEXT,

  decision_type            TEXT
                            CHECK (decision_type IS NULL OR decision_type IN
                                   ('approved', 'denied', 'conditional', 'withdrawn', 'pending', 'tabled')),
  decided_at               DATE,
  decided_by               TEXT,                                  -- 'ACC committee' | 'board' | 'manager' | proper name

  conditions               TEXT,                                  -- when decision_type = 'conditional'
  reasoning                TEXT,                                  -- why this decision was reached
  summary                  TEXT,                                  -- 1-2 sentence digest used by AI prompts

  -- Embedding of (project_description + reasoning + summary) for semantic matching
  embedding                VECTOR(1536),

  -- Audit trail
  extracted_by_model       TEXT,
  extraction_confidence    TEXT
                            CHECK (extraction_confidence IS NULL OR
                                   extraction_confidence IN ('high', 'medium', 'low')),
  raw_extraction           JSONB,                                 -- full Claude output

  notes                    TEXT,                                  -- staff free-form annotation
  manually_edited          BOOLEAN NOT NULL DEFAULT FALSE,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arc_history_community
  ON arc_historical_decisions(management_company_id, community_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_arc_history_project
  ON arc_historical_decisions(community_id, project_type, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_arc_history_decision
  ON arc_historical_decisions(community_id, decision_type, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_arc_history_embedding
  ON arc_historical_decisions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
  WHERE embedding IS NOT NULL;

DROP TRIGGER IF EXISTS trg_arc_history_updated_at ON arc_historical_decisions;
CREATE TRIGGER trg_arc_history_updated_at
  BEFORE UPDATE ON arc_historical_decisions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- RPC: semantic match against historical decisions for a given community.
-- Used by the AI assessment engine when reviewing a new application.
CREATE OR REPLACE FUNCTION match_arc_decisions(
  query_embedding         VECTOR(1536),
  community_id_in         UUID,
  match_count             INT DEFAULT 5,
  similarity_threshold    FLOAT DEFAULT 0.65
)
RETURNS TABLE (
  id                      UUID,
  property_address        TEXT,
  homeowner_name          TEXT,
  project_type            TEXT,
  project_description     TEXT,
  decision_type           TEXT,
  decided_at              DATE,
  decided_by              TEXT,
  conditions              TEXT,
  reasoning               TEXT,
  summary                 TEXT,
  similarity              FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT
    d.id,
    d.property_address, d.homeowner_name,
    d.project_type, d.project_description,
    d.decision_type, d.decided_at, d.decided_by,
    d.conditions, d.reasoning, d.summary,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM arc_historical_decisions d
  WHERE d.community_id = community_id_in
    AND d.embedding IS NOT NULL
    AND (1 - (d.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Per-community summary view for the History tab dashboard
CREATE OR REPLACE VIEW v_arc_history_summary AS
SELECT
  community_id,
  COUNT(*)                                                    AS total_decisions,
  COUNT(*) FILTER (WHERE decision_type = 'approved')          AS approved_count,
  COUNT(*) FILTER (WHERE decision_type = 'denied')            AS denied_count,
  COUNT(*) FILTER (WHERE decision_type = 'conditional')       AS conditional_count,
  MIN(decided_at)                                             AS earliest_decision,
  MAX(decided_at)                                             AS latest_decision
FROM arc_historical_decisions
GROUP BY community_id;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT community_id, total_decisions, approved_count, denied_count
--   FROM v_arc_history_summary;
-- ----------------------------------------------------------------------------
