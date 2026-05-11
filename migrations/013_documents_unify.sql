-- ============================================================================
-- 013_documents_unify.sql
-- ----------------------------------------------------------------------------
-- Unify the three document repositories under one read surface, without
-- forcing a big-bang migration.
--
-- The three repositories today:
--   1. library_documents         — new Documents Tracker (categorized, extracted)
--   2. knowledge_documents       — Help layer (HomeWise admin guide chunks)
--   3. documents                 — legacy askEd (chunked PDF/DOCX, no category)
--
-- Strategy:
--   - WRITES continue going to library_documents (the new system).
--   - READS unify across all three via the API layer + this summary view.
--   - MIGRATION is opt-in per-doc: staff clicks "Categorize" on a legacy row
--     and we promote it into library_documents with extracted metadata.
--   - Supersession tracking lets new uploads retire legacy versions cleanly.
--
-- This migration is purely additive. Safe to re-run. Does NOT modify any
-- existing chunks, embeddings, or library rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) library_documents: add supersession timestamp (column for superseded_by_id
--    already exists). When a new doc replaces an old one, we set
--    superseded_at + superseded_by_id and flip status='superseded'.
-- ----------------------------------------------------------------------------
ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS source_origin TEXT NOT NULL DEFAULT 'library'
    CHECK (source_origin IN ('library','migrated_from_legacy','migrated_from_help'));

CREATE INDEX IF NOT EXISTS idx_library_docs_superseded
  ON library_documents(management_company_id, superseded_at)
  WHERE superseded_at IS NULL;  -- partial index: fast "show me active docs only"

-- ----------------------------------------------------------------------------
-- 2) Legacy documents table: tag rows that have been promoted into the new
--    library so we can hide them in the unified view (or show them as
--    "migrated"). The legacy table has no migration file because it predates
--    trustEd — schema is (id, content, metadata jsonb, embedding vector).
--    ADD COLUMN IF NOT EXISTS is safe on a live table.
-- ----------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS migrated_to_library_id UUID REFERENCES library_documents(id);

CREATE INDEX IF NOT EXISTS idx_legacy_docs_migrated
  ON documents(migrated_to_library_id)
  WHERE migrated_to_library_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) v_legacy_documents_summary
-- Roll up the chunked legacy table into one row per (community, filename).
-- This is what the Documents tab UI renders for legacy docs — a clean list,
-- not 6-10 chunks per doc.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_legacy_documents_summary AS
SELECT
  -- Stable synthetic id: encodes community+filename so the UI can pass it back
  -- without needing a real per-doc row. Format: 'legacy:' + md5(community||filename)
  'legacy:' || md5(
    COALESCE(metadata->>'community','') || '||' || COALESCE(metadata->>'filename','')
  )                                              AS legacy_id,
  metadata->>'community'                         AS community_name,
  metadata->>'filename'                          AS filename,
  metadata->>'doc_type'                          AS doc_type,    -- almost always NULL
  COUNT(*)                                       AS chunk_count,
  MIN(id)                                        AS first_chunk_id,  -- representative chunk
  -- One representative chunk's content (truncated) so the UI can preview without
  -- fetching all chunks
  LEFT(MIN(content), 280)                        AS preview,
  -- migration tracking
  BOOL_OR(migrated_to_library_id IS NOT NULL)    AS is_migrated,
  MIN(migrated_to_library_id)                    AS migrated_to_library_id
FROM documents
WHERE metadata->>'community' IS NOT NULL
GROUP BY metadata->>'community', metadata->>'filename', metadata->>'doc_type';

GRANT SELECT ON v_legacy_documents_summary TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Helper function: fetch full concatenated text of a legacy doc by
--    community+filename. Used by "Categorize" workflow when staff clicks to
--    promote a legacy doc into library_documents — we ask Claude to extract
--    metadata from the rolled-up text.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legacy_document_text(p_community TEXT, p_filename TEXT)
RETURNS TEXT
LANGUAGE SQL STABLE
AS $$
  SELECT string_agg(content, E'\n\n' ORDER BY id)
  FROM documents
  WHERE metadata->>'community' = p_community
    AND metadata->>'filename'  = p_filename;
$$;

GRANT EXECUTE ON FUNCTION legacy_document_text(TEXT, TEXT) TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT community_name, COUNT(*) AS docs, SUM(chunk_count) AS chunks
--     FROM v_legacy_documents_summary
--    GROUP BY community_name
--    ORDER BY docs DESC;
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'library_documents'
--      AND column_name IN ('superseded_at','source_origin');
--   -- expect 2 rows
-- ----------------------------------------------------------------------------
