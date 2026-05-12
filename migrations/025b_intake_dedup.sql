-- ============================================================================
-- 025b_intake_dedup.sql
-- ----------------------------------------------------------------------------
-- Adds content hashing, embedding, and supersession links to email_intake
-- so we can detect:
--   1. Exact duplicates (same content_hash)
--   2. Near-duplicates (cosine similarity ≥ 0.95)
--   3. Supersedes relationships (newer thread that contains/extends an older one)
--
-- Apply AFTER 025. Idempotent.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE email_intake
  ADD COLUMN IF NOT EXISTS content_hash       TEXT,
  ADD COLUMN IF NOT EXISTS normalized_excerpt TEXT,         -- first ~500 chars of normalized text, for quick visual dedupe in UI
  ADD COLUMN IF NOT EXISTS embedding          VECTOR(1536), -- embedding of normalized content (for similarity)
  ADD COLUMN IF NOT EXISTS supersedes_id      UUID REFERENCES email_intake(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_id   UUID REFERENCES email_intake(id) ON DELETE SET NULL;

-- Allow 'superseded' status alongside existing pending/extracted/approved/rejected/error
ALTER TABLE email_intake DROP CONSTRAINT IF EXISTS email_intake_extraction_status_check;
ALTER TABLE email_intake
  ADD CONSTRAINT email_intake_extraction_status_check
  CHECK (extraction_status IN ('pending', 'extracted', 'approved', 'rejected', 'error', 'superseded'));

-- One row per (community, content_hash) to enforce exact-duplicate detection.
-- Partial unique on community_id IS NOT NULL: cross-community duplicates allowed
-- (an email about LPF vs Eaglewood that happens to share text — unlikely but safe).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_intake_community_hash
  ON email_intake (management_company_id, community_id, content_hash)
  WHERE community_id IS NOT NULL AND content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_intake_supersedes
  ON email_intake(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_intake_superseded_by
  ON email_intake(superseded_by_id) WHERE superseded_by_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_intake_embedding
  ON email_intake USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
  WHERE embedding IS NOT NULL;

-- RPC: find similar emails for a given community + query embedding.
-- Used by the dedup check on new intakes.
CREATE OR REPLACE FUNCTION match_email_intakes(
  query_embedding   VECTOR(1536),
  community_id_in   UUID,
  match_count       INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.85
)
RETURNS TABLE (
  id                    UUID,
  subject               TEXT,
  extracted_summary     TEXT,
  extraction_status     TEXT,
  ingested_at           TIMESTAMPTZ,
  raw_length            INT,
  similarity            FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT
    ei.id,
    ei.subject,
    ei.extracted_summary,
    ei.extraction_status,
    ei.ingested_at,
    LENGTH(ei.raw_content) AS raw_length,
    1 - (ei.embedding <=> query_embedding) AS similarity
  FROM email_intake ei
  WHERE ei.community_id = community_id_in
    AND ei.embedding IS NOT NULL
    AND ei.extraction_status <> 'superseded'
    AND (1 - (ei.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY ei.embedding <=> query_embedding
  LIMIT match_count;
$$;

COMMIT;

-- Verify:
--   SELECT id, content_hash IS NOT NULL AS has_hash, embedding IS NOT NULL AS has_embed,
--          supersedes_id, superseded_by_id, extraction_status
--   FROM email_intake LIMIT 5;
