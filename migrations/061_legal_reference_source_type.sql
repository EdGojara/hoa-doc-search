-- Add 'legal_reference' as a knowledge_documents source_type and the
-- legal-specific metadata that lets us scope by jurisdiction, statute
-- version, and community type.
--
-- Strategic purpose: the platform now encodes the legal lens alongside
-- CC&Rs / SOPs / vendor docs. askEd can triangulate across them — when a
-- legal-flavored question lands, it pulls from these references and cites
-- the section. Lays the foundation for the compliance engine: future
-- modules check every enforcement action against the statute store before
-- it leaves the platform.

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
    'other'
  ));

-- Legal-reference metadata. NULL for non-legal docs.
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS jurisdiction           TEXT NULL,            -- 'TX', 'TX-municipal', etc.
  ADD COLUMN IF NOT EXISTS effective_year_start   INTEGER NULL,         -- 2025 = 89th Legislature
  ADD COLUMN IF NOT EXISTS effective_year_end     INTEGER NULL,         -- 2027 = until 90th supersedes
  ADD COLUMN IF NOT EXISTS community_type         TEXT NULL             -- which kinds of communities this applies to
    CHECK (community_type IS NULL OR community_type IN (
      'single_family', 'townhome', 'condo', 'master_planned', 'mixed'
    )),
  ADD COLUMN IF NOT EXISTS publisher              TEXT NULL;            -- 'RMWBH', 'Texas Legislature', etc.

CREATE INDEX IF NOT EXISTS idx_kdocs_legal_lookup
  ON knowledge_documents(source_type, jurisdiction, effective_year_end DESC)
  WHERE source_type = 'legal_reference';

-- Section-aware chunk metadata. Statute books are chunked by Sec. X.YYY
-- boundaries (not 500-token windows) so citations always resolve to a
-- specific section. Existing knowledge_chunks rows aren't affected.
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS chapter_number         TEXT NULL,            -- '209', '202', etc.
  ADD COLUMN IF NOT EXISTS section_number         TEXT NULL,            -- '209.006', '202.010', etc.
  ADD COLUMN IF NOT EXISTS statute_citation       TEXT NULL;            -- 'Tex. Prop. Code § 209.006'

CREATE INDEX IF NOT EXISTS idx_kchunks_section
  ON knowledge_chunks(section_number)
  WHERE section_number IS NOT NULL;
