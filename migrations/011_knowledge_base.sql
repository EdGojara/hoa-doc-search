-- ============================================================================
-- 011_knowledge_base.sql
-- ----------------------------------------------------------------------------
-- Operational Training Layer foundation. Ingests vendor admin/user guides
-- (HomeWise, Vantaca, etc.), Bedrock-internal SOPs, and any other reference
-- material. Surfaces them through a context-aware "Help" search inside
-- trustEd, so clerks get answers in askEd-template format (Action / Output /
-- Reasoning / Watch Outs) instead of paging through PDFs or waiting a week
-- for HomeWise / Vantaca support to email back.
--
-- Strategic purpose:
--   - Break vendor support-tier extraction (every question answered locally
--     is one less reason to pay upgraded support)
--   - Encode tribal knowledge as it accumulates (resolved questions persist
--     in the knowledge base)
--   - In-context training that survives staff turnover
--   - Foundation for embedded help in every workflow (Resale, Payables, etc.)
--
-- Uses the existing pgvector extension and OpenAI text-embedding-ada-002
-- (1536 dimensions) — same stack as the original askEd document search.
--
-- Apply AFTER 010b. Idempotent.
-- ============================================================================

-- ============================================================================
-- knowledge_documents
-- One row per ingested source document (PDF). Multiple versions of the same
-- doc are supported via supersession (e.g., HomeWise updates their admin
-- guide; old version becomes 'superseded', new one becomes 'active').
-- ============================================================================
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  title                    TEXT NOT NULL,                          -- "HomeWise Account Administrator Guide"
  source_type              TEXT NOT NULL                           -- what KIND of document
                           CHECK (source_type IN (
                             'vendor_admin_guide',                  -- e.g., HomeWise admin guide
                             'vendor_user_guide',                   -- e.g., HomeWise user guide
                             'vendor_agreement',                    -- service agreement / terms
                             'vendor_release_notes',                -- update / changelog
                             'bedrock_sop',                         -- internal procedure
                             'governing_document',                  -- HOA bylaws/CCR/rules
                             'training_material',                   -- onboarding content
                             'other'
                           )),
  vendor                   TEXT,                                   -- 'homewise', 'vantaca', 'bedrock', etc. (NULL for Bedrock-internal)
  file_name                TEXT,                                   -- original upload name
  file_hash                TEXT,                                   -- SHA-256 of source PDF (for dedup)
  page_count               INTEGER,
  chunk_count              INTEGER NOT NULL DEFAULT 0,
  notes                    TEXT,                                   -- admin notes ("supersedes 1.2024", "Bedrock-specific overrides at end")
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','superseded','archived')),
  superseded_by_id         UUID REFERENCES knowledge_documents(id),
  ingested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by              UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kdocs_mgmt_co_status
  ON knowledge_documents(management_company_id, status, vendor);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kdocs_mgmt_co_hash
  ON knowledge_documents(management_company_id, file_hash)
  WHERE file_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_kdocs_updated_at ON knowledge_documents;
CREATE TRIGGER trg_kdocs_updated_at
  BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- knowledge_chunks
-- Each document is chunked into ~500-token segments with overlap. Each chunk
-- has an embedding for semantic search. Page number + section heading let
-- the UI render proper citations ("HomeWise Admin Guide, p. 15, Orders").
-- ============================================================================
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id              UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index              INTEGER NOT NULL,                       -- 0-based sequential within document
  text                     TEXT NOT NULL,
  page_number              INTEGER,                                -- which page this chunk came from
  section_heading          TEXT,                                   -- nearest preceding heading (best-effort)
  token_count              INTEGER,
  embedding                VECTOR(1536),                           -- OpenAI text-embedding-ada-002
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_kchunks_document
  ON knowledge_chunks(document_id, chunk_index);

-- Vector similarity index. IVFFlat is the standard pgvector index for
-- cosine similarity. lists=50 is reasonable for the volume we expect
-- (dozens of guides × ~50 chunks each = a few thousand chunks).
CREATE INDEX IF NOT EXISTS idx_kchunks_embedding
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- ============================================================================
-- Vector search RPC. Returns top-K chunks by cosine similarity, joined to
-- their parent document for citation rendering. Excludes superseded docs.
-- ============================================================================
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding VECTOR(1536),
  mgmt_co_id      UUID,
  match_count     INT DEFAULT 8,
  vendor_filter   TEXT[] DEFAULT NULL,        -- e.g., ARRAY['homewise']
  source_filter   TEXT[] DEFAULT NULL         -- e.g., ARRAY['vendor_admin_guide']
)
RETURNS TABLE (
  chunk_id        UUID,
  document_id     UUID,
  document_title  TEXT,
  vendor          TEXT,
  source_type     TEXT,
  page_number     INTEGER,
  section_heading TEXT,
  text            TEXT,
  similarity      FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id              AS chunk_id,
    d.id              AS document_id,
    d.title           AS document_title,
    d.vendor          AS vendor,
    d.source_type     AS source_type,
    c.page_number     AS page_number,
    c.section_heading AS section_heading,
    c.text            AS text,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id
  WHERE d.management_company_id = mgmt_co_id
    AND d.status = 'active'
    AND (vendor_filter IS NULL OR d.vendor = ANY(vendor_filter))
    AND (source_filter IS NULL OR d.source_type = ANY(source_filter))
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- Row Level Security
-- ============================================================================
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_kdocs_tenant ON knowledge_documents;
CREATE POLICY p_kdocs_tenant ON knowledge_documents
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_kchunks_tenant ON knowledge_chunks;
CREATE POLICY p_kchunks_tenant ON knowledge_chunks
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM knowledge_documents d
    WHERE d.id = knowledge_chunks.document_id
      AND d.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ============================================================================
-- Grants
-- ============================================================================
GRANT ALL ON knowledge_documents, knowledge_chunks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_documents, knowledge_chunks TO authenticated;
GRANT EXECUTE ON FUNCTION match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[]) TO service_role, authenticated;

-- ============================================================================
-- Verify with:
--   SELECT COUNT(*) FROM knowledge_documents;   -- expect 0
--   SELECT COUNT(*) FROM knowledge_chunks;      -- expect 0
--   SELECT * FROM pg_proc WHERE proname = 'match_knowledge_chunks';
-- ============================================================================
