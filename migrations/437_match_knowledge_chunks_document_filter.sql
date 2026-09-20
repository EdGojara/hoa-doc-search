-- 437_match_knowledge_chunks_document_filter.sql
-- ----------------------------------------------------------------------------
-- Add an ADDITIVE optional `document_filter UUID[] DEFAULT NULL` to the canonical
-- retrieval RPC match_knowledge_chunks, so a caller can restrict vector retrieval
-- to a specific set of knowledge_documents AT QUERY TIME (not by post-filtering).
-- This is what lets Partner Ask CLMA retrieve relevance-ranked evidence from ONLY
-- the documents a Partner Association is entitled to, so the model never receives
-- content from a document outside that entitlement, and late-in-document evidence
-- surfaces by relevance instead of being lost to a sequential character cap.
-- (Ed 2026-09-20, Partner Portal retrieval correctness.)
--
-- SAFETY / behavior preservation:
--   * The body is migration 075's body verbatim, plus ONE clause:
--       AND (document_filter IS NULL OR d.id = ANY(document_filter))
--     So when document_filter IS NULL (every existing caller), the WHERE is
--     IDENTICAL to 075 and results are unchanged.
--   * The signature evolved across 011 (5-arg) / 071 (8-arg) / 075 (10-arg) as
--     separate overloads. To avoid resolution ambiguity we DROP each known
--     signature (IF EXISTS) and CREATE the single 11-arg function. Every current
--     caller passes a subset of named args (verified: governing_doc_lookup,
--     api/enforcement, api/help) and reads results by column name, so they
--     resolve to the one function with defaults and read the same columns.
--   * GRANTs are re-issued (DROP loses them).
-- Transactional + idempotent-safe.
BEGIN;

DROP FUNCTION IF EXISTS match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[]);
DROP FUNCTION IF EXISTS match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[], UUID, DATE, TEXT[]);
DROP FUNCTION IF EXISTS match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[], UUID, DATE, TEXT[], UUID, UUID);

CREATE FUNCTION match_knowledge_chunks(
  query_embedding   VECTOR(1536),
  mgmt_co_id        UUID,
  match_count       INT     DEFAULT 8,
  vendor_filter     TEXT[]  DEFAULT NULL,
  source_filter     TEXT[]  DEFAULT NULL,
  community_filter  UUID    DEFAULT NULL,
  as_of_date        DATE    DEFAULT NULL,
  access_filter     TEXT[]  DEFAULT NULL,
  property_filter   UUID    DEFAULT NULL,
  contact_filter    UUID    DEFAULT NULL,
  document_filter   UUID[]  DEFAULT NULL
)
RETURNS TABLE (
  chunk_id          UUID,
  document_id       UUID,
  document_title    TEXT,
  vendor            TEXT,
  source_type       TEXT,
  community_id      UUID,
  property_id       UUID,
  contact_id        UUID,
  effective_date    DATE,
  page_number       INTEGER,
  section_heading   TEXT,
  text              TEXT,
  similarity        FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id                                       AS chunk_id,
    d.id                                       AS document_id,
    d.title                                    AS document_title,
    d.vendor                                   AS vendor,
    d.source_type                              AS source_type,
    d.community_id                             AS community_id,
    d.property_id                              AS property_id,
    d.contact_id                               AS contact_id,
    d.effective_date                           AS effective_date,
    c.page_number                              AS page_number,
    c.section_heading                          AS section_heading,
    c.text                                     AS text,
    1 - (c.embedding <=> query_embedding)      AS similarity
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id
  WHERE d.management_company_id = mgmt_co_id
    AND d.status = 'active'
    AND (vendor_filter    IS NULL OR d.vendor       = ANY(vendor_filter))
    AND (source_filter    IS NULL OR d.source_type  = ANY(source_filter))
    AND (community_filter IS NULL OR d.community_id = community_filter)
    AND (property_filter  IS NULL OR d.property_id  = property_filter)
    AND (contact_filter   IS NULL OR d.contact_id   = contact_filter)
    AND (access_filter    IS NULL OR d.access_level = ANY(access_filter))
    AND (
      as_of_date IS NULL
      OR (
        (d.valid_from IS NULL OR d.valid_from <= (as_of_date + INTERVAL '1 day'))
        AND (d.valid_to IS NULL OR d.valid_to > as_of_date)
      )
    )
    -- NEW: restrict retrieval to an explicit set of knowledge_documents.
    AND (document_filter IS NULL OR d.id = ANY(document_filter))
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_knowledge_chunks(
  VECTOR(1536), UUID, INT, TEXT[], TEXT[], UUID, DATE, TEXT[], UUID, UUID, UUID[]
) TO service_role, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
