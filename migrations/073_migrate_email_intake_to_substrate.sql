-- ============================================================================
-- 073_migrate_email_intake_to_substrate.sql
-- ----------------------------------------------------------------------------
-- Phase 2 continued (project_unified_architecture.md). Migrates the
-- email_intake silo into the unified knowledge substrate so askEd can
-- retrieve email content alongside library docs.
--
-- BEFORE: emails have embeddings used only for dedup (match_email_intakes).
-- AFTER:  each email lives ALSO as a knowledge_documents/knowledge_chunks
-- pair with source_type='email', so match_knowledge_chunks finds them.
-- "What did we tell the Smiths about their fence last spring" becomes a
-- working query against history.
--
-- IMPORTANT: the original email_intake table stays. Its embedding column
-- continues to power dedup (feature-local concern per feedback_no_new_silos.md
-- legitimate exception #1). The canonical chunk for retrieval lives in the
-- unified substrate.
--
-- Access control: emails default to access_level='staff_internal'. Board
-- portal (project_board_portal.md) will NOT surface these unless an
-- explicit operator action (e.g., redacted summary) re-tags individual rows.
-- This is the safety default until the access-control architecture for the
-- board portal is built out.
--
-- Apply AFTER 072. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tracking column on email_intake so re-runs skip already-migrated rows
-- ----------------------------------------------------------------------------
ALTER TABLE email_intake
  ADD COLUMN IF NOT EXISTS migrated_to_kdoc_id UUID
    REFERENCES knowledge_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_intake_migrated_kdoc
  ON email_intake(migrated_to_kdoc_id)
  WHERE migrated_to_kdoc_id IS NOT NULL;

-- ============================================================================
-- Main migration pass.
-- One parent knowledge_documents per email, one knowledge_chunks per email.
-- ============================================================================
DO $$
DECLARE
  rec RECORD;
  parent_id UUID;
  parents_created INT := 0;
  chunks_migrated INT := 0;
  derived_title TEXT;
  skipped_no_embedding INT := 0;
  skipped_error INT := 0;
  skipped_superseded INT := 0;
BEGIN
  FOR rec IN
    SELECT
      ei.id,
      ei.management_company_id,
      ei.community_id,
      ei.subject,
      ei.raw_content,
      ei.sender_hint,
      ei.source,
      ei.embedding,
      ei.extraction_status,
      ei.extracted_summary,
      ei.ingested_at,
      ei.supersedes_id,
      ei.superseded_by_id
    FROM email_intake ei
    WHERE ei.migrated_to_kdoc_id IS NULL
  LOOP
    -- Skip rows that can't be productively retrieved
    IF rec.embedding IS NULL THEN
      skipped_no_embedding := skipped_no_embedding + 1;
      CONTINUE;
    END IF;
    IF rec.extraction_status = 'error' THEN
      skipped_error := skipped_error + 1;
      CONTINUE;
    END IF;
    -- Superseded emails get migrated but parent.status = 'superseded' so they
    -- don't show in active askEd searches (audit trail preserved).

    -- Idempotency: see if a parent already exists
    SELECT id INTO parent_id
    FROM knowledge_documents
    WHERE source_type = 'email'
      AND source_record_id = rec.id::text
    LIMIT 1;

    -- Derive title — prefer subject, fall back to first 80 chars of body
    derived_title := COALESCE(
      NULLIF(TRIM(rec.subject), ''),
      LEFT(REGEXP_REPLACE(COALESCE(rec.raw_content, ''), '\s+', ' ', 'g'), 80),
      'Email (no subject)'
    );

    IF parent_id IS NULL THEN
      INSERT INTO knowledge_documents (
        management_company_id,
        title,
        source_type,
        community_id,
        source_record_id,
        status,
        ingested_at,
        model_version,
        access_level,
        notes,
        chunk_count
      ) VALUES (
        rec.management_company_id,
        derived_title,
        'email',
        rec.community_id,
        rec.id::text,
        CASE WHEN rec.extraction_status = 'superseded' THEN 'superseded' ELSE 'active' END,
        rec.ingested_at,
        'text-embedding-ada-002@v1',
        'staff_internal',
        CONCAT_WS(' · ',
          NULLIF(rec.sender_hint, ''),
          NULLIF(rec.source, '')
        ),
        1
      )
      RETURNING id INTO parent_id;
      parents_created := parents_created + 1;

      IF rec.extraction_status = 'superseded' THEN
        skipped_superseded := skipped_superseded + 1;
      END IF;
    END IF;

    -- Insert the single chunk for this email (idempotent on conflict)
    INSERT INTO knowledge_chunks (
      document_id,
      chunk_index,
      text,
      embedding,
      model_version
    ) VALUES (
      parent_id,
      0,
      rec.raw_content,
      rec.embedding,
      'text-embedding-ada-002@v1'
    )
    ON CONFLICT (document_id, chunk_index) DO NOTHING;

    chunks_migrated := chunks_migrated + 1;

    UPDATE email_intake
    SET migrated_to_kdoc_id = parent_id
    WHERE id = rec.id;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Migration 073 summary ===';
  RAISE NOTICE 'parents created (new):      %', parents_created;
  RAISE NOTICE '  of which superseded:      %', skipped_superseded;
  RAISE NOTICE 'chunks migrated:            %', chunks_migrated;
  RAISE NOTICE 'skipped (no embedding):     %', skipped_no_embedding;
  RAISE NOTICE 'skipped (extraction error): %', skipped_error;
END $$;

-- ============================================================================
-- Sanity: count emails now in the substrate.
-- ============================================================================
DO $$
DECLARE
  email_parents INT;
  email_chunks INT;
BEGIN
  SELECT COUNT(*) INTO email_parents
  FROM knowledge_documents
  WHERE source_type = 'email';
  SELECT COUNT(*) INTO email_chunks
  FROM knowledge_chunks kc
  JOIN knowledge_documents kd ON kd.id = kc.document_id
  WHERE kd.source_type = 'email';
  RAISE NOTICE '';
  RAISE NOTICE 'Total in substrate now: % email parents, % email chunks', email_parents, email_chunks;
END $$;
