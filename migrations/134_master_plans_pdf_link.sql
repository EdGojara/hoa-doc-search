-- ============================================================================
-- 134_master_plans_pdf_link.sql
-- ----------------------------------------------------------------------------
-- Adds library_document_id to master_plans so each registered plan can link
-- to its source PDF in library_documents. Required for the direct admin
-- master-plan upload flow (staff registers DRB's plans without going through
-- the submission → approve → promote workflow).
--
-- Why FK to library_documents instead of a raw storage path:
--   • library_documents is the canonical home for PDFs (CLAUDE.md single
--     source of truth)
--   • OCR pipeline already runs on library_documents uploads, so the master
--     plan PDF becomes searchable to askEd automatically
--   • PDFs uploaded to library_documents get the indexing + retrieval +
--     re-OCR backlog handling we already built — no parallel storage path
--
-- ON DELETE SET NULL: if the PDF is later removed, the master_plans row
-- stays (with structured fields intact) so historical references don't
-- break. The PDF link just becomes null.
--
-- Record ownership: master_plans is 'workpaper' (Bedrock's institutional
-- intelligence — which plans we've approved where), so this column is too.
-- The PDF in library_documents is 'mixed' as usual.
--
-- Apply after 133. Idempotent via IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE master_plans
  ADD COLUMN IF NOT EXISTS library_document_id UUID
    REFERENCES library_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_master_plans_library_doc
  ON master_plans(library_document_id)
  WHERE library_document_id IS NOT NULL;

COMMENT ON COLUMN master_plans.library_document_id IS
  'FK to library_documents row holding this plan''s PDF. NULL = no PDF on file (legacy or admin-registered without PDF). Set on direct-admin uploads (post-2026-05-29) and on promote-to-master flows that capture the original submission''s plan PDF.';

COMMIT;
