-- ============================================================================
-- 075_entity_graph_linkage_columns.sql
-- ----------------------------------------------------------------------------
-- Phase 3 of unified knowledge architecture (project_unified_architecture.md).
-- Connects the four unified knowledge silos (post-071/072/073/074) to the
-- existing entity-graph spine built by migration 049 (properties + contacts +
-- property_ownerships + property_residencies).
--
-- Strategic outcome: the board portal (project_board_portal.md) becomes
-- buildable. Today: ARC decisions store a text address with no link to any
-- property record. After this phase: every ARC decision links to its
-- property and homeowner, queries like "show me everything we know about
-- 123 Forest Lane" return ownership + residency + ARC history + violations
-- + emails as one navigable structure.
--
-- WHAT THIS MIGRATION DOES:
-- Adds nullable foreign-key columns to the knowledge silos:
--   arc_historical_decisions.property_id  (→ properties.id)
--   arc_historical_decisions.contact_id   (→ contacts.id, the homeowner)
--   email_intake.property_id              (→ properties.id, when mentioned)
--   email_intake.contact_id               (→ contacts.id, the sender)
-- Plus indexes so the new joins are fast.
--
-- WHAT THIS MIGRATION DOES NOT DO:
-- - No backfill. Existing rows keep their text address / name fields and
--   leave the new FK columns NULL until the entity resolver (next commit)
--   walks the data and matches addresses to properties.
-- - No code changes. The next commit adds find-or-create logic to the
--   save paths so NEW arc_decisions / emails populate the FKs at write time.
-- - No table renames. The text address / name columns stay as denormalized
--   facts (matches the source data) — the FKs are the *normalized* layer.
--
-- All columns nullable; this is a purely additive migration. Safe to run
-- after 074. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) arc_historical_decisions: link to property + contact
-- ----------------------------------------------------------------------------
ALTER TABLE arc_historical_decisions
  ADD COLUMN IF NOT EXISTS property_id UUID
    REFERENCES properties(id) ON DELETE SET NULL;

ALTER TABLE arc_historical_decisions
  ADD COLUMN IF NOT EXISTS contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_arc_decisions_property
  ON arc_historical_decisions(property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_arc_decisions_contact
  ON arc_historical_decisions(contact_id)
  WHERE contact_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) email_intake: link to property + contact (sender)
-- ----------------------------------------------------------------------------
ALTER TABLE email_intake
  ADD COLUMN IF NOT EXISTS property_id UUID
    REFERENCES properties(id) ON DELETE SET NULL;

ALTER TABLE email_intake
  ADD COLUMN IF NOT EXISTS contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_intake_property
  ON email_intake(property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_intake_contact
  ON email_intake(contact_id)
  WHERE contact_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) Also surface property_id / contact_id on knowledge_documents itself —
--    when the substrate parent already knows the entity, askEd can filter
--    by property without re-resolving from the source table.
-- ----------------------------------------------------------------------------
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS property_id UUID
    REFERENCES properties(id) ON DELETE SET NULL;

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kdocs_property
  ON knowledge_documents(property_id)
  WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kdocs_contact
  ON knowledge_documents(contact_id)
  WHERE contact_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4) Extend match_knowledge_chunks to accept property_filter + contact_filter
--    so askEd can answer questions scoped to a single property or person.
--    Backwards compatible — both new params default to NULL.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[], UUID, DATE, TEXT[]);

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding   VECTOR(1536),
  mgmt_co_id        UUID,
  match_count       INT     DEFAULT 8,
  vendor_filter     TEXT[]  DEFAULT NULL,
  source_filter     TEXT[]  DEFAULT NULL,
  community_filter  UUID    DEFAULT NULL,
  as_of_date        DATE    DEFAULT NULL,
  access_filter     TEXT[]  DEFAULT NULL,
  property_filter   UUID    DEFAULT NULL,
  contact_filter    UUID    DEFAULT NULL
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
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_knowledge_chunks(VECTOR(1536), UUID, INT, TEXT[], TEXT[], UUID, DATE, TEXT[], UUID, UUID)
  TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Documentation
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN arc_historical_decisions.property_id IS
  'FK to properties.id. Resolved from property_address text via the entity resolver in next commit. NULL until backfilled.';
COMMENT ON COLUMN arc_historical_decisions.contact_id IS
  'FK to contacts.id (homeowner). Resolved from homeowner_name text via the entity resolver. NULL until backfilled.';
COMMENT ON COLUMN email_intake.property_id IS
  'FK to properties.id when the email mentions a specific property. NULL when not property-scoped or not yet resolved.';
COMMENT ON COLUMN email_intake.contact_id IS
  'FK to contacts.id for the email sender. Resolved from sender_hint via the entity resolver. NULL until resolved.';
COMMENT ON COLUMN knowledge_documents.property_id IS
  'Substrate-level property scope. Mirrors the FK from the source row (arc_historical_decisions.property_id, etc.). Lets askEd filter retrieval to a specific property without re-resolving from source.';
COMMENT ON COLUMN knowledge_documents.contact_id IS
  'Substrate-level contact scope. Mirrors the FK from the source row. Lets askEd filter retrieval to a specific person.';
