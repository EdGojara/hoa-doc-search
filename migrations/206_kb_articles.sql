-- ============================================================================
-- 206_kb_articles.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Knowledge Base for Claire + Ed (Phase 1 of the
-- encode-Ed memory layer for legal/regulatory reference).
--
-- THESIS: Make Claire and Ed smarter than the industry by retrieving the
-- applicable law / regulation / commentary when answering homeowners and
-- boards. Article goes in once, becomes retrievable forever, across both
-- voice (Claire) and chat (askEd) surfaces.
--
-- DESIGN:
--   - kb_articles holds the rich metadata (source URL, jurisdiction,
--     topics, source quality) that only KB articles need.
--   - Chunks are written into the existing unified substrate
--     (knowledge_documents + knowledge_chunks + documents) using
--     source_type='kb_article' — NO new vector silo. The hybrid retriever
--     (lib/hybrid_retrieval.js) finds them automatically through the
--     existing read path against the `documents` table.
--   - kb_articles.parent_knowledge_doc_id links to the knowledge_documents
--     parent so chunk cascade-delete works via the standard pattern.
--
-- SOURCE QUALITY TIERS (drives Claire's citation rigor):
--   primary_statute   — text of TX Property Code, US Code, etc. Quotable.
--   court_opinion     — Texas appellate decision / federal opinion. Citable
--                       to attorneys, paraphrase to homeowners.
--   regulator_guidance — Texas Comptroller, HUD, CFPB official guidance.
--   attorney_alert    — RMWBH client alert / firm publication. Authoritative
--                       framing, not verbatim quote-able to homeowners.
--   commentary        — Third-party explainers (LegalClarity, Nolo, etc.).
--                       Useful for framework, never cite as authority.
--   internal          — Bedrock-authored summary / SOP. Use as policy.
--
-- TOPIC TAGS (free-form text[], curated below for consistency):
--   lien_priority, foreclosure, bankruptcy, homestead, property_tax,
--   stay_362, sec_209, sec_82, sec_204, sec_205, sec_207, drv,
--   acc_arc, payment_plan, escrow, redemption, fdcpa, fair_housing,
--   open_meetings, board_governance, insurance, reserves, ada,
--   short_term_rentals, solar, flag_display, gun_storage,
--   ev_charging, audit, taxes_federal, taxes_state.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Allow 'kb_article' as a knowledge_documents source_type
-- ----------------------------------------------------------------------------
ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_source_type_check;

ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_source_type_check
  CHECK (source_type IN (
    'vendor_admin_guide',
    'vendor_user_guide',
    'vendor_agreement',
    'vendor_release_notes',
    'bedrock_sop',
    'governing_document',
    'training_material',
    'legal_reference',
    'library_doc',
    'email',
    'arc_decision',
    'board_packet_section',
    'inspection_note',
    'interaction',
    'vendor_proposal',
    'contract_clause',
    'meeting_transcript',
    'kb_article',                  -- NEW: knowledge base article (legal / regulatory / policy reference)
    'other'
  ));

-- ----------------------------------------------------------------------------
-- 2) kb_articles — rich metadata table for legal/regulatory references.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_articles (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                     TEXT NOT NULL,
  source_url                TEXT,
  source_publisher          TEXT,                       -- 'LegalClarity', 'RMWBH', 'CAI', 'Texas Comptroller', 'Bedrock Internal'
  jurisdiction              TEXT NOT NULL DEFAULT 'TX'  -- 'TX', 'federal', 'multi_state', 'other'
                            CHECK (jurisdiction IN ('TX','federal','multi_state','other')),
  source_quality            TEXT NOT NULL               -- determines Claire's citation rigor; see above
                            CHECK (source_quality IN (
                              'primary_statute',
                              'court_opinion',
                              'regulator_guidance',
                              'attorney_alert',
                              'commentary',
                              'internal'
                            )),
  topics                    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  summary                   TEXT,                       -- 1-3 sentence Bedrock-authored "what this article is for" note
  content_md                TEXT NOT NULL,              -- full article body (markdown or plain text)
  content_hash              TEXT,                       -- SHA-256 of content_md for dedup
  published_at              DATE,                       -- when the source published it (best-effort)
  ingested_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by               TEXT,                       -- operator email
  parent_knowledge_doc_id   UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  chunk_count               INTEGER NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','archived','superseded')),
  archived_at               TIMESTAMPTZ,
  archived_reason           TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_articles_status_jurisdiction
  ON kb_articles(status, jurisdiction);
CREATE INDEX IF NOT EXISTS idx_kb_articles_topics
  ON kb_articles USING GIN (topics);
CREATE UNIQUE INDEX IF NOT EXISTS ux_kb_articles_content_hash
  ON kb_articles(content_hash)
  WHERE content_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_kb_articles_updated_at ON kb_articles;
CREATE TRIGGER trg_kb_articles_updated_at
  BEFORE UPDATE ON kb_articles
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE kb_articles IS
  'Knowledge base articles — legal, regulatory, and policy references that inform Claire and askEd. Chunks live in the unified knowledge_chunks + documents tables via parent_knowledge_doc_id for retrieval.';

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_articles TO service_role;
GRANT SELECT ON kb_articles TO authenticated;

COMMIT;
