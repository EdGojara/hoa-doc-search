-- ============================================================================
-- Migration 056 — governing-doc references on enforcement priorities
-- ----------------------------------------------------------------------------
-- Extends community_enforcement_priorities with the governing-doc section
-- the violation letter should cite (e.g. "DCC&Rs Article IV §4.3 Landscaping").
-- Populated either manually by staff OR auto-extracted by the AI extractor
-- (Phase 7b) that scans the community's loaded CC&Rs / R&Rs and proposes
-- the relevant section for each enforcement category.
--
-- The letter generator looks these up at render time and prints something like:
--   "Specifically, this condition relates to Quail Ridge DCC&Rs Article IV,
--    Section 4.3 (Landscaping Standards), which provides:
--    'Trees shall be maintained so that branches do not encroach on...'"
-- vs. today's generic "your governing documents" phrasing.
--
-- One active reference per (community, category) — same uniqueness contract
-- as the existing priority_weight (enforced by the partial unique index on
-- end_date IS NULL already on this table).
-- ============================================================================

ALTER TABLE community_enforcement_priorities
  ADD COLUMN IF NOT EXISTS governing_doc_reference     TEXT,     -- short citation, e.g. "DCC&Rs Article IV §4.3"
  ADD COLUMN IF NOT EXISTS governing_doc_section_title TEXT,     -- "Landscaping Standards"
  ADD COLUMN IF NOT EXISTS governing_doc_quote         TEXT,     -- 1-2 sentence verbatim quote
  ADD COLUMN IF NOT EXISTS governing_doc_page          INTEGER,  -- page number in the PDF
  ADD COLUMN IF NOT EXISTS governing_doc_library_id    UUID REFERENCES library_documents(id),
  ADD COLUMN IF NOT EXISTS governing_doc_source        TEXT
    CHECK (governing_doc_source IS NULL OR governing_doc_source IN ('manual','ai_extracted','imported')),
  ADD COLUMN IF NOT EXISTS governing_doc_extracted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS governing_doc_reviewed_by   UUID,
  ADD COLUMN IF NOT EXISTS governing_doc_reviewed_at   TIMESTAMPTZ;

-- ============================================================================
-- Per-community letter sender override — so letters can be signed by the
-- actual community manager (Laurie, Ed, etc.) instead of a generic
-- "Bedrock Association Management". Falls back to BAM lockup when NULL.
-- ============================================================================
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS letter_sender_name  TEXT,
  ADD COLUMN IF NOT EXISTS letter_sender_title TEXT;
