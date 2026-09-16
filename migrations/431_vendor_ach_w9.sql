-- ============================================================================
-- 431_vendor_ach_w9.sql  (Ed 2026-09-16)
-- ----------------------------------------------------------------------------
-- Collect the vendor's W-9 in the SAME secure enrollment step as their banking
-- + ACH authorization (migrations 429, 430). The vendor is already in the
-- secure form, so capturing the W-9 here closes the "1099 vendor missing W-9"
-- gap the Vendor 360 flags. Stored + filed to the community document library as
-- a 'w9' record; never collected by email.
-- ============================================================================
BEGIN;

ALTER TABLE vendor_ach_requests
  ADD COLUMN IF NOT EXISTS w9_doc_path            text,
  ADD COLUMN IF NOT EXISTS w9_doc_name            text,
  ADD COLUMN IF NOT EXISTS w9_doc_mime            text,
  ADD COLUMN IF NOT EXISTS w9_library_document_id uuid REFERENCES library_documents(id) ON DELETE SET NULL;

COMMIT;
