-- ============================================================================
-- 013b_documents_unify_hotfix.sql
-- ----------------------------------------------------------------------------
-- Hotfix for 013. The v_legacy_documents_summary view used MIN(uuid) which
-- Postgres doesn't define (UUIDs have no natural ordering). Replacement uses
-- array_agg + index access, which is the standard pattern for "give me any
-- representative uuid from this group."
--
-- Also drops first_chunk_id from the view — it wasn't used by anything and
-- removing it simplifies the aggregate.
--
-- Safe to re-run. Idempotent.
-- ============================================================================

DROP VIEW IF EXISTS v_legacy_documents_summary;

CREATE VIEW v_legacy_documents_summary AS
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
  -- Representative chunk content (truncated) for UI preview. text has natural
  -- ordering so MIN() works fine here.
  LEFT(MIN(content), 280)                        AS preview,
  -- Migration tracking. All chunks of the same logical doc share the same
  -- migrated_to_library_id (we update them as a batch), so picking any one
  -- via array_agg[1] is correct.
  BOOL_OR(migrated_to_library_id IS NOT NULL)    AS is_migrated,
  (array_agg(migrated_to_library_id) FILTER (WHERE migrated_to_library_id IS NOT NULL))[1]
                                                 AS migrated_to_library_id
FROM documents
WHERE metadata->>'community' IS NOT NULL
GROUP BY metadata->>'community', metadata->>'filename', metadata->>'doc_type';

GRANT SELECT ON v_legacy_documents_summary TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Helper function from 013 (didn't execute because the view above it failed).
-- Used by POST /api/documents/legacy/categorize to get the full text of a
-- legacy doc for Claude metadata extraction.
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
-- ----------------------------------------------------------------------------
