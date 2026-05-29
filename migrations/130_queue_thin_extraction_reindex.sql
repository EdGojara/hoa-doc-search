-- ============================================================================
-- 130_queue_thin_extraction_reindex.sql
-- ----------------------------------------------------------------------------
-- Backlog catch-up function for the existing OCR pipeline.
--
-- BACKGROUND:
--   The OCR pipeline (lib/ocr_pdf.js + lib/library_reindex.js) was added
--   AFTER many older governing docs were already uploaded. Migration 104's
--   backfill marked every library_documents row that had ANY chunks in the
--   `documents` table as index_status='indexed' — including docs uploaded
--   pre-OCR where pdf-parse extracted only header noise from a scanned PDF.
--
--   Symptom Ed caught 2026-05-29: Quail Ridge Resolutions & Policies (2019
--   and 2021) are scanned-image PDFs. They appear "indexed" in
--   library_documents.index_status, but askEd can't find their content
--   because the only chunks stored are pdf-parse junk (or zero chunks).
--
-- WHAT THIS FUNCTION DOES:
--   Finds library_documents that are marked 'indexed' but whose actual
--   chunk presence in the `documents` table is suspiciously thin. Resets
--   those rows to index_status='pending' so the existing reindex queue +
--   /api/documents/reindex-all + the auto-reindex scheduler will pick
--   them up and re-process through the OCR fallback path
--   (extractFullTextFromFile → pdf-parse first, then ocrPdfWithAi).
--
--   Single-query aggregation via CTE — handles 100+ docs in one round
--   trip vs. N+1 from JS.
--
-- THRESHOLDS (caller can override):
--   min_chunk_count  — below this, treat as "no real text extracted"
--   min_total_chars  — sum of content length across chunks, below this same
--   max_requeue      — safety cap per call so a runaway query can't blow up
--                      the reindex queue
--
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION queue_thin_extraction_reindex(
  min_chunk_count INTEGER DEFAULT 5,
  min_total_chars INTEGER DEFAULT 1000,
  max_requeue     INTEGER DEFAULT 500
)
RETURNS TABLE (
  requeued_count INTEGER,
  sample_ids     UUID[],
  sample_titles  TEXT[],
  threshold_chunks INTEGER,
  threshold_chars  INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
  v_ids UUID[];
  v_titles TEXT[];
BEGIN
  WITH chunk_stats AS (
    -- One row per library_document_id with chunk count + summed content length.
    -- Library doc id lives in documents.metadata->>'library_document_id'.
    SELECT
      (d.metadata->>'library_document_id')::uuid AS library_doc_id,
      COUNT(*)               AS chunk_count,
      SUM(LENGTH(d.content)) AS total_chars
    FROM documents d
    WHERE d.metadata ? 'library_document_id'
    GROUP BY (d.metadata->>'library_document_id')::uuid
  ),
  thin_docs AS (
    -- library_documents that are 'indexed' but have either no chunks at all
    -- (cs row is NULL via LEFT JOIN) or below the threshold counts.
    SELECT ld.id, COALESCE(ld.title, ld.file_name_normalized, '(untitled)') AS display_title
    FROM library_documents ld
    LEFT JOIN chunk_stats cs ON cs.library_doc_id = ld.id
    WHERE ld.index_status = 'indexed'
      AND ld.file_path IS NOT NULL
      AND ld.file_path <> ''
      AND ld.management_company_id = '00000000-0000-0000-0000-000000000001'
      AND (
        cs.library_doc_id IS NULL
        OR cs.chunk_count  < min_chunk_count
        OR cs.total_chars  < min_total_chars
      )
    ORDER BY ld.uploaded_at NULLS FIRST   -- oldest first; pre-OCR docs first
    LIMIT max_requeue
  ),
  updated AS (
    UPDATE library_documents ld
    SET
      index_status     = 'pending',
      last_index_error = 'Auto-requeued ' || to_char(NOW(), 'YYYY-MM-DD HH24:MI')
                         || ': thin extraction (pre-OCR upload suspected)',
      index_attempt_count = 0           -- reset so 'failed_permanent' caps don't bite
    WHERE ld.id IN (SELECT id FROM thin_docs)
    RETURNING ld.id, COALESCE(ld.title, ld.file_name_normalized, '(untitled)') AS display_title
  )
  SELECT
    COUNT(*)::INTEGER,
    (ARRAY_AGG(id))[1:10],
    (ARRAY_AGG(display_title))[1:10]
  INTO v_count, v_ids, v_titles
  FROM updated;

  RETURN QUERY SELECT
    COALESCE(v_count, 0),
    COALESCE(v_ids, ARRAY[]::UUID[]),
    COALESCE(v_titles, ARRAY[]::TEXT[]),
    min_chunk_count,
    min_total_chars;
END;
$$;

GRANT EXECUTE ON FUNCTION queue_thin_extraction_reindex(INTEGER, INTEGER, INTEGER)
  TO service_role;

COMMIT;

-- ============================================================================
-- USAGE (Supabase SQL editor or RPC from Node)
-- ============================================================================
-- -- Default thresholds (5 chunks / 1000 chars / max 500 docs requeued):
-- SELECT * FROM queue_thin_extraction_reindex();
--
-- -- More aggressive (catches docs with up to 10 chunks but tiny content):
-- SELECT * FROM queue_thin_extraction_reindex(10, 2000, 500);
--
-- -- Dry-run equivalent (count only, no UPDATE) — preview before requeuing:
-- WITH chunk_stats AS (
--   SELECT (d.metadata->>'library_document_id')::uuid AS library_doc_id,
--          COUNT(*) AS chunk_count, SUM(LENGTH(d.content)) AS total_chars
--   FROM documents d WHERE d.metadata ? 'library_document_id'
--   GROUP BY (d.metadata->>'library_document_id')::uuid
-- )
-- SELECT c.name AS community, ld.title, cs.chunk_count, cs.total_chars
-- FROM library_documents ld
-- LEFT JOIN chunk_stats cs ON cs.library_doc_id = ld.id
-- LEFT JOIN communities c ON c.id = ld.community_id
-- WHERE ld.index_status = 'indexed'
--   AND ld.file_path IS NOT NULL
--   AND (cs.library_doc_id IS NULL OR cs.chunk_count < 5 OR cs.total_chars < 1000)
-- ORDER BY c.name, ld.title;
