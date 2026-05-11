-- ============================================================================
-- 013b_documents_unify_hotfix.sql
-- ----------------------------------------------------------------------------
-- Standalone replacement for 013. Supabase wraps the whole script in a single
-- transaction, so when 013's view creation failed on MIN(uuid), the ALTER
-- TABLE statements above it were rolled back too. This file is the full,
-- corrected version — fully idempotent. Run this once and you're done.
--
-- Strategy unchanged from 013:
--   - WRITES continue going to library_documents (the new system).
--   - READS unify across all three via the API layer + this summary view.
--   - MIGRATION is opt-in per-doc: staff clicks "Categorize" on a legacy row
--     and we promote it into library_documents with extracted metadata.
--
-- Safe to re-run. Purely additive.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) library_documents: add supersession timestamp + source origin
-- ----------------------------------------------------------------------------
ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS source_origin TEXT NOT NULL DEFAULT 'library'
    CHECK (source_origin IN ('library','migrated_from_legacy','migrated_from_help'));

CREATE INDEX IF NOT EXISTS idx_library_docs_superseded
  ON library_documents(management_company_id, superseded_at)
  WHERE superseded_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2) Legacy documents table: tag rows that have been promoted into the new
--    library. ADD COLUMN IF NOT EXISTS is safe on the live askEd table.
-- ----------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS migrated_to_library_id UUID REFERENCES library_documents(id);

CREATE INDEX IF NOT EXISTS idx_legacy_docs_migrated
  ON documents(migrated_to_library_id)
  WHERE migrated_to_library_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) v_legacy_documents_summary — one row per (community, filename)
-- Uses array_agg pattern instead of MIN(uuid) because Postgres has no
-- MIN/MAX aggregate defined on the uuid type.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_legacy_documents_summary;

CREATE VIEW v_legacy_documents_summary AS
SELECT
  'legacy:' || md5(
    COALESCE(metadata->>'community','') || '||' || COALESCE(metadata->>'filename','')
  )                                              AS legacy_id,
  metadata->>'community'                         AS community_name,
  metadata->>'filename'                          AS filename,
  metadata->>'doc_type'                          AS doc_type,
  COUNT(*)                                       AS chunk_count,
  LEFT(MIN(content), 280)                        AS preview,
  BOOL_OR(migrated_to_library_id IS NOT NULL)    AS is_migrated,
  (array_agg(migrated_to_library_id) FILTER (WHERE migrated_to_library_id IS NOT NULL))[1]
                                                 AS migrated_to_library_id
FROM documents
WHERE metadata->>'community' IS NOT NULL
GROUP BY metadata->>'community', metadata->>'filename', metadata->>'doc_type';

GRANT SELECT ON v_legacy_documents_summary TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Helper function — concatenates all chunks of a legacy doc for re-extraction.
-- Used by POST /api/documents/legacy/categorize.
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
-- Verify (run these as separate queries after the script completes):
--
--   SELECT community_name, COUNT(*) AS docs, SUM(chunk_count) AS chunks
--     FROM v_legacy_documents_summary
--    GROUP BY community_name
--    ORDER BY docs DESC;
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'library_documents'
--      AND column_name IN ('superseded_at','source_origin');
--   -- expect 2 rows
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'documents'
--      AND column_name = 'migrated_to_library_id';
--   -- expect 1 row
-- ----------------------------------------------------------------------------
