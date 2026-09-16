-- ============================================================================
-- 430_vendor_ach_esign_upload.sql  (Ed 2026-09-16)
-- ----------------------------------------------------------------------------
-- Extends the secure vendor ACH enrollment (migration 429) so the vendor can
-- E-SIGN the authorization online and/or UPLOAD a supporting document (a voided
-- check or their own signed ACH form). On submit the server generates a signed
-- ACH Authorization PDF and files it (plus any upload) into the community's
-- document library, so a real record ends up in the association's file.
--
-- E-sign capture follows the ESIGN Act shape: intent (checkbox), consent, and
-- attribution (typed legal name + timestamp + IP + user agent), retained as the
-- generated PDF.
-- ============================================================================
BEGIN;

ALTER TABLE vendor_ach_requests
  ADD COLUMN IF NOT EXISTS signer_name           text,
  ADD COLUMN IF NOT EXISTS signer_title          text,
  ADD COLUMN IF NOT EXISTS authorization_agreed  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signed_at             timestamptz,
  ADD COLUMN IF NOT EXISTS signer_user_agent     text,
  -- Vendor-uploaded corroboration (voided check / their own signed ACH form)
  ADD COLUMN IF NOT EXISTS supporting_doc_path   text,
  ADD COLUMN IF NOT EXISTS supporting_doc_name   text,
  ADD COLUMN IF NOT EXISTS supporting_doc_mime   text,
  -- Server-generated signed authorization PDF (the retained record)
  ADD COLUMN IF NOT EXISTS authorization_pdf_path text,
  -- Link to the community document-library entry for the authorization
  ADD COLUMN IF NOT EXISTS library_document_id   uuid REFERENCES library_documents(id) ON DELETE SET NULL;

COMMIT;
