-- ============================================================================
-- 071_unified_knowledge_substrate_foundation.sql
-- ----------------------------------------------------------------------------
-- Phase 1 of the 5-phase unified knowledge architecture
-- (memory: project_unified_architecture.md).
--
-- Goal: extend the existing knowledge_documents + knowledge_chunks substrate
-- so every embedded data source in the system — library docs, emails, ARC
-- decisions, inspection notes, board packet sections, future interactions —
-- can write into ONE table and be retrieved by ONE search RPC.
--
-- What this migration does (purely additive, zero-breakage):
--   1. Broadens knowledge_documents.source_type CHECK to allow new source
--      types (email, arc_decision, library_doc, board_packet_section,
--      inspection_note, interaction, vendor_proposal, etc.)
--   2. Adds the time + multi-tenant + provenance columns that every later
--      phase depends on:
--        - community_id           — multi-tenant filter
--        - effective_date         — when the fact became true
--        - valid_from / valid_to  — temporal versioning window
--        - superseded_by_id       — already exists; keeps working
--        - model_version          — embedding model used (upgrade-path)
--        - access_level           — board_facing / staff_internal / homeowner
--        - source_record_id       — pointer back to the originating row
--                                   (email_intake.id, arc_decision.id, etc.)
--   3. Extends match_knowledge_chunks RPC to accept community_filter and
--      as_of_date params. Existing callers (positional or named args without
--      these) keep working — both new params default to NULL.
--   4. Adds the indexes the new filters need so the RPC stays fast as the
--      corpus grows past today's few-thousand-chunks scale.
--
-- What this migration does NOT do (subsequent migrations handle):
--   - 072 will migrate the legacy `documents` table chunks into
--     knowledge_chunks with source_type='library_doc' (existing migration
--     013 already started the unification; this finishes it).
--   - 073 will migrate email_intake embeddings into knowledge_chunks with
--     source_type='email'.
--   - 074 will migrate arc_decisions embeddings into knowledge_chunks with
--     source_type='arc_decision'.
--   - 075 will drop the deprecated match_email_intakes /
--     match_arc_decisions / match_documents RPCs once all callers have
--     migrated to match_knowledge_chunks.
--
-- Safe to run after 070. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Broaden source_type to include every category we'll house going forward.
--    Existing values stay valid; this is purely additive.
-- ----------------------------------------------------------------------------
ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_source_type_check;

ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_source_type_check
  CHECK (source_type IN (
    -- Original values (preserved):
    'vendor_admin_guide',
    'vendor_user_guide',
    'vendor_agreement',
    'vendor_release_notes',
    'bedrock_sop',
    'governing_document',
    'training_material',
    'legal_reference',                      -- added in 061
    -- New values for Phase 1 unification:
    'library_doc',                          -- categorized community-specific doc (was: documents tab uploads)
    'email',                                -- ingested correspondence (was: email_intake silo)
    'arc_decision',                         -- ARC decision precedent (was: arc_decisions silo)
    'board_packet_section',                 -- rendered packet content (agenda / minutes / financials / DRV)
    'inspection_note',                      -- DRV walkthrough observation / common-area assessment
    'interaction',                          -- operator-action capture (memory layer, project_memory_layer.md)
    'vendor_proposal',                      -- bid / RFP / quote from a vendor
    'contract_clause',                      -- extracted contract clause for search
    'meeting_transcript',                   -- recorded meeting audio → transcript
    'other'
  ));

-- ----------------------------------------------------------------------------
-- 2) Multi-tenant + temporal + provenance columns.
--    All nullable so existing rows are unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS community_id      UUID REFERENCES communities(id) ON DELETE SET NULL;

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS effective_date    DATE;

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS valid_from        TIMESTAMPTZ;

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS valid_to          TIMESTAMPTZ;

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS model_version     TEXT
    DEFAULT 'text-embedding-ada-002@v1';

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS access_level      TEXT NOT NULL DEFAULT 'staff_internal'
    CHECK (access_level IN ('board_facing','staff_internal','homeowner_visible','operator_only'));

-- source_record_id lets us link a chunk back to its originating row in the
-- module's own table (e.g., email_intake.id, arc_decision.id, library_doc.id).
-- Stored as text so we can hold UUIDs OR composite keys without per-source
-- foreign-key plumbing — the discipline is in the application layer.
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS source_record_id  TEXT;

-- The same model_version column on chunks too, so we can re-embed a single
-- chunk without rewriting the parent doc row.
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS model_version     TEXT
    DEFAULT 'text-embedding-ada-002@v1';

-- ----------------------------------------------------------------------------
-- 3) Indexes for the new filters. Without these the RPC slows down as the
--    corpus grows; with them, community + as-of queries stay sub-100ms.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_kdocs_source_type
  ON knowledge_documents(source_type, status);

CREATE INDEX IF NOT EXISTS idx_kdocs_community
  ON knowledge_documents(management_company_id, community_id, status)
  WHERE community_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kdocs_effective_date
  ON knowledge_documents(management_company_id, effective_date)
  WHERE effective_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kdocs_source_record
  ON knowledge_documents(source_type, source_record_id)
  WHERE source_record_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4) Extended match_knowledge_chunks RPC.
--    New params: community_filter (UUID), as_of_date (DATE).
--    Backwards compatible: callers using the old 5-arg form keep working.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding   VECTOR(1536),
  mgmt_co_id        UUID,
  match_count       INT     DEFAULT 8,
  vendor_filter     TEXT[]  DEFAULT NULL,
  source_filter     TEXT[]  DEFAULT NULL,
  community_filter  UUID    DEFAULT NULL,
  as_of_date        DATE    DEFAULT NULL,
  access_filter     TEXT[]  DEFAULT NULL
)
RETURNS TABLE (
  chunk_id          UUID,
  document_id       UUID,
  document_title    TEXT,
  vendor            TEXT,
  source_type       TEXT,
  community_id      UUID,
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
    AND (access_filter    IS NULL OR d.access_level = ANY(access_filter))
    -- Temporal: when as_of_date is supplied, only return facts that were
    -- valid on that date. NULL valid_from = always-on; NULL valid_to = current.
    AND (
      as_of_date IS NULL
      OR (
        (d.valid_from IS NULL OR d.valid_from <= (as_of_date + INTERVAL '1 day'))
        AND (d.valid_to IS NULL OR d.valid_to > as_of_date)
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[], UUID, DATE, TEXT[])
  TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 5) Document the migration intent in a comment so future readers can find
--    the roadmap context without digging through git history.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE knowledge_documents IS
  'Unified knowledge substrate (per project_unified_architecture.md). All embedded data sources — library docs, emails, ARC decisions, inspections, interactions, board packet sections — live here with a source_type discriminator. Single search RPC is match_knowledge_chunks. Subsequent migrations (072-075) move legacy silos into this table.';

COMMENT ON COLUMN knowledge_documents.source_type IS
  'Discriminator for the unified substrate. See migration 071 CHECK constraint for the canonical list. Adding new types requires a CHECK extension migration.';

COMMENT ON COLUMN knowledge_documents.community_id IS
  'Multi-tenant scope. NULL = platform-wide knowledge (Texas Property Code, vendor manuals). Set = community-specific knowledge (community emails, ARC decisions, board minutes).';

COMMENT ON COLUMN knowledge_documents.effective_date IS
  'When the fact in this document became true. Different from ingested_at (when we received it). Used for temporal queries: "as of date X, what was our policy?"';

COMMENT ON COLUMN knowledge_documents.model_version IS
  'Embedding model used to produce this chunk. Format: model-name@version. When upgrading embedding models, set new chunks to the new version and back-fill old chunks in batches.';
