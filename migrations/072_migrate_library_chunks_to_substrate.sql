-- ============================================================================
-- 072_migrate_library_chunks_to_substrate.sql
-- ----------------------------------------------------------------------------
-- Phase 2 of unified knowledge architecture (project_unified_architecture.md).
-- Migrates chunks from the legacy `documents` table into knowledge_chunks
-- (with knowledge_documents parents tagged source_type='library_doc').
--
-- After this lands, askEd's existing match_knowledge_chunks RPC will
-- transparently return library-doc results — because the chunks now live
-- in the same table the RPC searches. The 'NOT indexed for askEd' problem
-- dissolves for every library doc that's been uploaded.
--
-- Non-destructive: the legacy `documents` table is NOT dropped. Chunks
-- stay there too. This is the 'expand phase' of expand-then-contract —
-- both stores coexist until migration 075 retires the legacy table after
-- all callers (match_documents in api/applications.js, others) have moved
-- to match_knowledge_chunks.
--
-- Idempotent: rows tagged `documents.migrated_to_kdoc_id` are skipped.
-- Safe to re-run if interrupted.
--
-- Apply AFTER 071. Run in Supabase SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tracking column so we can skip already-migrated chunks on re-run.
-- (Migration 013 added `migrated_to_library_id` for a different earlier
-- unification; this is a separate column with explicit purpose.)
-- ----------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS migrated_to_kdoc_id UUID
    REFERENCES knowledge_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_legacy_docs_migrated_kdoc
  ON documents(migrated_to_kdoc_id)
  WHERE migrated_to_kdoc_id IS NOT NULL;

-- ============================================================================
-- PASS 1 — chunks with metadata.library_document_id (post-trustEd uploads).
-- These chunks link cleanly back to a library_documents row, so we get
-- title/community/source_record from there.
-- ============================================================================
DO $$
DECLARE
  rec RECORD;
  parent_id UUID;
  parents_created INT := 0;
  chunks_migrated INT := 0;
  this_chunks INT;
BEGIN
  FOR rec IN
    SELECT DISTINCT (d.metadata->>'library_document_id')::uuid AS lib_doc_id
    FROM documents d
    WHERE d.metadata->>'library_document_id' IS NOT NULL
      AND d.migrated_to_kdoc_id IS NULL
  LOOP
    -- Get or create parent knowledge_documents row, idempotent on
    -- (source_type='library_doc', source_record_id=lib_doc_id::text).
    SELECT id INTO parent_id
    FROM knowledge_documents
    WHERE source_type = 'library_doc'
      AND source_record_id = rec.lib_doc_id::text
    LIMIT 1;

    IF parent_id IS NULL THEN
      INSERT INTO knowledge_documents (
        management_company_id, title, source_type, vendor, file_name,
        community_id, source_record_id, status, ingested_at, model_version,
        access_level
      )
      SELECT
        ld.management_company_id,
        COALESCE(ld.file_name_original, ld.file_name_normalized, 'Untitled') AS title,
        'library_doc',
        NULL,
        ld.file_name_original,
        ld.community_id,
        ld.id::text,
        'active',
        COALESCE(ld.uploaded_at, NOW()),
        'text-embedding-ada-002@v1',
        'staff_internal'
      FROM library_documents ld
      WHERE ld.id = rec.lib_doc_id
      RETURNING id INTO parent_id;

      IF parent_id IS NOT NULL THEN
        parents_created := parents_created + 1;
      END IF;
    END IF;

    -- Orphan library_document_id (no library_documents row) — skip
    IF parent_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Copy chunks. chunk_index is synthesized via row_number; we use the
    -- documents.id ordering so re-runs produce stable indexes.
    WITH inserted AS (
      INSERT INTO knowledge_chunks (
        document_id, chunk_index, text, page_number, section_heading,
        embedding, model_version
      )
      SELECT
        parent_id,
        (ROW_NUMBER() OVER (ORDER BY d.id))::int - 1 AS chunk_index,
        d.content,
        NULLIF(d.metadata->>'page_number', '')::int,
        d.metadata->>'section_heading',
        d.embedding,
        'text-embedding-ada-002@v1'
      FROM documents d
      WHERE (d.metadata->>'library_document_id')::uuid = rec.lib_doc_id
        AND d.migrated_to_kdoc_id IS NULL
      ON CONFLICT (document_id, chunk_index) DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*) INTO this_chunks FROM inserted;
    chunks_migrated := chunks_migrated + this_chunks;

    -- Mark migrated
    UPDATE documents
    SET migrated_to_kdoc_id = parent_id
    WHERE (metadata->>'library_document_id')::uuid = rec.lib_doc_id
      AND migrated_to_kdoc_id IS NULL;
  END LOOP;

  RAISE NOTICE '[072 pass 1] linked chunks: % parents created, % chunks migrated', parents_created, chunks_migrated;
END $$;

-- ============================================================================
-- PASS 2 — orphan chunks (no library_document_id metadata).
-- These predate the library_documents table. We group by (community, filename)
-- and create one synthetic parent per group, using a deterministic
-- source_record_id so the migration is idempotent across runs.
-- ============================================================================
DO $$
DECLARE
  rec RECORD;
  parent_id UUID;
  community_uuid UUID;
  mgmt_co_uuid UUID;
  parents_created INT := 0;
  chunks_migrated INT := 0;
  this_chunks INT;
  synth_key TEXT;
BEGIN
  -- Pull the singleton management_company_id from existing library docs
  SELECT management_company_id INTO mgmt_co_uuid
  FROM library_documents
  LIMIT 1;
  IF mgmt_co_uuid IS NULL THEN
    SELECT id INTO mgmt_co_uuid FROM management_companies LIMIT 1;
  END IF;
  IF mgmt_co_uuid IS NULL THEN
    RAISE NOTICE '[072 pass 2] skipped: no management_company_id available';
    RETURN;
  END IF;

  FOR rec IN
    SELECT
      d.metadata->>'community' AS community_name,
      d.metadata->>'filename'  AS filename
    FROM documents d
    WHERE d.metadata->>'library_document_id' IS NULL
      AND d.migrated_to_kdoc_id IS NULL
      AND d.metadata->>'filename' IS NOT NULL
    GROUP BY d.metadata->>'community', d.metadata->>'filename'
  LOOP
    -- Deterministic synthetic source_record_id for idempotency
    synth_key := 'legacy:' || md5(COALESCE(rec.community_name, '') || '|' || rec.filename);

    SELECT id INTO parent_id
    FROM knowledge_documents
    WHERE source_type = 'library_doc'
      AND source_record_id = synth_key
    LIMIT 1;

    IF parent_id IS NULL THEN
      community_uuid := NULL;
      IF rec.community_name IS NOT NULL THEN
        SELECT id INTO community_uuid
        FROM communities
        WHERE LOWER(name) = LOWER(rec.community_name)
        LIMIT 1;
      END IF;

      INSERT INTO knowledge_documents (
        management_company_id, title, source_type, file_name,
        community_id, source_record_id, status, ingested_at, model_version,
        access_level, notes
      ) VALUES (
        mgmt_co_uuid,
        rec.filename,
        'library_doc',
        rec.filename,
        community_uuid,
        synth_key,
        'active',
        NOW(),
        'text-embedding-ada-002@v1',
        'staff_internal',
        'Migrated from legacy documents table (no library_documents row found at time of migration 072).'
      )
      RETURNING id INTO parent_id;

      parents_created := parents_created + 1;
    END IF;

    WITH inserted AS (
      INSERT INTO knowledge_chunks (
        document_id, chunk_index, text, embedding, model_version
      )
      SELECT
        parent_id,
        (ROW_NUMBER() OVER (ORDER BY d.id))::int - 1 AS chunk_index,
        d.content,
        d.embedding,
        'text-embedding-ada-002@v1'
      FROM documents d
      WHERE d.metadata->>'library_document_id' IS NULL
        AND COALESCE(d.metadata->>'community', '') = COALESCE(rec.community_name, '')
        AND d.metadata->>'filename' = rec.filename
        AND d.migrated_to_kdoc_id IS NULL
      ON CONFLICT (document_id, chunk_index) DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*) INTO this_chunks FROM inserted;
    chunks_migrated := chunks_migrated + this_chunks;

    UPDATE documents
    SET migrated_to_kdoc_id = parent_id
    WHERE metadata->>'library_document_id' IS NULL
      AND COALESCE(metadata->>'community', '') = COALESCE(rec.community_name, '')
      AND metadata->>'filename' = rec.filename
      AND migrated_to_kdoc_id IS NULL;
  END LOOP;

  RAISE NOTICE '[072 pass 2] orphan chunks: % parents created, % chunks migrated', parents_created, chunks_migrated;
END $$;

-- ============================================================================
-- Update chunk_count on parent knowledge_documents (matches what new uploads
-- via indexLibraryDoc maintain going forward).
-- ============================================================================
UPDATE knowledge_documents kd
SET    chunk_count = sub.cnt
FROM (
  SELECT document_id, COUNT(*) AS cnt
  FROM knowledge_chunks
  GROUP BY document_id
) sub
WHERE kd.id = sub.document_id
  AND kd.source_type = 'library_doc';

-- ============================================================================
-- Summary for the operator.
-- ============================================================================
DO $$
DECLARE
  total_parents INT;
  total_chunks INT;
  unmigrated INT;
BEGIN
  SELECT COUNT(*) INTO total_parents
  FROM knowledge_documents
  WHERE source_type = 'library_doc';
  SELECT COALESCE(SUM(chunk_count), 0) INTO total_chunks
  FROM knowledge_documents
  WHERE source_type = 'library_doc';
  SELECT COUNT(*) INTO unmigrated
  FROM documents
  WHERE migrated_to_kdoc_id IS NULL;
  RAISE NOTICE '';
  RAISE NOTICE '=== Migration 072 summary ===';
  RAISE NOTICE 'knowledge_documents (source_type=library_doc): %', total_parents;
  RAISE NOTICE 'knowledge_chunks under those parents:           %', total_chunks;
  RAISE NOTICE 'documents rows still unmigrated:                %', unmigrated;
  RAISE NOTICE '(unmigrated rows are orphan: no filename metadata; left alone deliberately)';
END $$;
