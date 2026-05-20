-- ============================================================================
-- 074_migrate_arc_decisions_to_substrate.sql
-- ----------------------------------------------------------------------------
-- Phase 2 final silo (project_unified_architecture.md). Migrates the
-- arc_historical_decisions silo into the unified substrate.
--
-- ARC decisions are the highest signal-density silo in the system:
--   - Every row is a real judgment with reasoning attached
--   - The embedding was made from summary+reasoning (curated text),
--     not raw email noise — retrieval quality is excellent
--   - These ARE the precedents the AI assessment engine cites when a
--     new application comes in
--
-- After this lands, askEd's match_knowledge_chunks RPC will surface ARC
-- precedents alongside library docs and emails. Operator asking
-- "have we ever approved a 7-foot fence in LPF" gets answered directly
-- from the unified substrate — not by manually walking the ACC archive.
--
-- IMPORTANT: the original arc_historical_decisions table stays. Its
-- embedding column continues to power the AI assessment engine's
-- precedent-finding flow via match_arc_decisions (feature-local exception
-- per feedback_no_new_silos.md — the assessment engine needs the
-- structured fields like project_type + decision_type as filters, which
-- the unified substrate doesn't carry as first-class columns).
--
-- Access control: ARC decisions default to access_level='staff_internal'.
-- The board portal (project_board_portal.md) will eventually filter to
-- decisions for the board's own community. The homeowner portal will
-- filter further to decisions on the homeowner's own property.
--
-- Apply AFTER 073. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tracking column on arc_historical_decisions for re-run safety
-- ----------------------------------------------------------------------------
ALTER TABLE arc_historical_decisions
  ADD COLUMN IF NOT EXISTS migrated_to_kdoc_id UUID
    REFERENCES knowledge_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_arc_decisions_migrated_kdoc
  ON arc_historical_decisions(migrated_to_kdoc_id)
  WHERE migrated_to_kdoc_id IS NOT NULL;

-- ============================================================================
-- Main migration: one parent + one chunk per ARC decision.
-- ============================================================================
DO $$
DECLARE
  rec RECORD;
  parent_id UUID;
  parents_created INT := 0;
  chunks_migrated INT := 0;
  derived_title TEXT;
  embed_text TEXT;
  skipped_no_embedding INT := 0;
BEGIN
  FOR rec IN
    SELECT
      ahd.id,
      ahd.management_company_id,
      ahd.community_id,
      ahd.property_address,
      ahd.homeowner_name,
      ahd.project_type,
      ahd.project_description,
      ahd.decision_type,
      ahd.decided_at,
      ahd.decided_by,
      ahd.conditions,
      ahd.reasoning,
      ahd.summary,
      ahd.embedding,
      ahd.source_filename,
      ahd.created_at,
      ahd.extraction_confidence
    FROM arc_historical_decisions ahd
    WHERE ahd.migrated_to_kdoc_id IS NULL
  LOOP
    IF rec.embedding IS NULL THEN
      skipped_no_embedding := skipped_no_embedding + 1;
      CONTINUE;
    END IF;

    -- Idempotency check
    SELECT id INTO parent_id
    FROM knowledge_documents
    WHERE source_type = 'arc_decision'
      AND source_record_id = rec.id::text
    LIMIT 1;

    -- Title format: "<address> — <project_type> — <decision_type>"
    --   e.g., "123 Forest Lane — Fence — Approved"
    derived_title := CONCAT_WS(' — ',
      NULLIF(TRIM(rec.property_address), ''),
      INITCAP(NULLIF(TRIM(rec.project_type), '')),
      INITCAP(NULLIF(TRIM(rec.decision_type), ''))
    );
    IF derived_title IS NULL OR TRIM(derived_title) = '' THEN
      derived_title := 'ARC decision ' || COALESCE(rec.decided_at::text, rec.created_at::date::text);
    END IF;

    -- Chunk text matches the source of the embedding (summary + reasoning +
    -- conditions + project context). This is what the embedding "means" — so
    -- retrieving by similarity returns the same content the embedding was
    -- computed from.
    embed_text := ARRAY_TO_STRING(
      ARRAY(
        SELECT v FROM (VALUES
          ('Project: ' || COALESCE(rec.project_type, 'unspecified')),
          (CASE WHEN rec.property_address IS NOT NULL THEN 'Property: ' || rec.property_address END),
          (CASE WHEN rec.homeowner_name IS NOT NULL THEN 'Homeowner: ' || rec.homeowner_name END),
          (CASE WHEN rec.decided_at IS NOT NULL THEN 'Decided: ' || rec.decided_at::text END),
          (CASE WHEN rec.decision_type IS NOT NULL THEN 'Outcome: ' || rec.decision_type END),
          (CASE WHEN rec.decided_by IS NOT NULL THEN 'Decided by: ' || rec.decided_by END),
          (CASE WHEN rec.project_description IS NOT NULL THEN E'\nDescription: ' || rec.project_description END),
          (CASE WHEN rec.summary IS NOT NULL THEN E'\nSummary: ' || rec.summary END),
          (CASE WHEN rec.conditions IS NOT NULL THEN E'\nConditions: ' || rec.conditions END),
          (CASE WHEN rec.reasoning IS NOT NULL THEN E'\nReasoning: ' || rec.reasoning END)
        ) AS t(v)
        WHERE v IS NOT NULL
      ),
      E'\n'
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
        effective_date,
        model_version,
        access_level,
        notes,
        chunk_count,
        file_name
      ) VALUES (
        rec.management_company_id,
        derived_title,
        'arc_decision',
        rec.community_id,
        rec.id::text,
        'active',
        rec.created_at,
        rec.decided_at,
        'text-embedding-ada-002@v1',
        'staff_internal',
        CONCAT_WS(' · ',
          NULLIF(rec.source_filename, ''),
          CASE WHEN rec.extraction_confidence IS NOT NULL
               THEN 'extraction:' || rec.extraction_confidence END
        ),
        1,
        rec.source_filename
      )
      RETURNING id INTO parent_id;
      parents_created := parents_created + 1;
    END IF;

    INSERT INTO knowledge_chunks (
      document_id,
      chunk_index,
      text,
      embedding,
      model_version
    ) VALUES (
      parent_id,
      0,
      embed_text,
      rec.embedding,
      'text-embedding-ada-002@v1'
    )
    ON CONFLICT (document_id, chunk_index) DO NOTHING;

    chunks_migrated := chunks_migrated + 1;

    UPDATE arc_historical_decisions
    SET migrated_to_kdoc_id = parent_id
    WHERE id = rec.id;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Migration 074 summary ===';
  RAISE NOTICE 'parents created (new):     %', parents_created;
  RAISE NOTICE 'chunks migrated:           %', chunks_migrated;
  RAISE NOTICE 'skipped (no embedding):    %', skipped_no_embedding;
END $$;

-- ============================================================================
-- Substrate totals across all source types so far.
-- ============================================================================
DO $$
DECLARE
  rec RECORD;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'Substrate totals by source_type:';
  FOR rec IN
    SELECT source_type, COUNT(*) AS docs, COALESCE(SUM(chunk_count), 0) AS chunks
    FROM knowledge_documents
    GROUP BY source_type
    ORDER BY docs DESC
  LOOP
    RAISE NOTICE '  % : % docs, % chunks', RPAD(rec.source_type, 22), LPAD(rec.docs::text, 5), LPAD(rec.chunks::text, 6);
  END LOOP;
END $$;
