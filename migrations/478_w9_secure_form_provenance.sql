-- ============================================================================
-- 478_w9_secure_form_provenance.sql  (Issue #14, Ed 2026-10-02)
-- ----------------------------------------------------------------------------
-- A W-9 the vendor submits through the secure form becomes the vendor's
-- canonical W-9 document (vendor_documents), with provenance, exactly once.
--
--   vendor_ach_requests.request_kind  'ach' (banking + optional W-9, today's
--       behavior and the default) or 'w9_only' (the same one-time secure link,
--       collecting only the W-9; never collected by email).
--   vendor_documents.source  how the document arrived: 'staff_upload' or
--       'secure_form'. NULL for rows filed before this migration.
--   vendor_documents.vendor_ach_request_id  the secure-form request a W-9 came
--       from (FK, RESTRICT: the request is the document's provenance).
--   vendor_documents_secure_form_provenance  a 'secure_form' document must name
--       its request.
--   uq_vendor_documents_ach_request  one document per secure-form request, so a
--       retried or duplicated submission can never file the W-9 twice.
--
-- Record ownership: unchanged (association_record tables). No row is written;
-- existing requests read 'ach', existing documents keep source NULL. Nothing
-- here sets w9_on_file, a classification or an exemption: a person confirms
-- those (POST /api/vendors/:id/tax-exemption, PATCH w9_on_file).
-- ============================================================================
BEGIN;

ALTER TABLE vendor_ach_requests
  ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'ach';
ALTER TABLE vendor_ach_requests
  DROP CONSTRAINT IF EXISTS vendor_ach_requests_request_kind_check;
ALTER TABLE vendor_ach_requests
  ADD CONSTRAINT vendor_ach_requests_request_kind_check CHECK (request_kind IN ('ach', 'w9_only'));

ALTER TABLE vendor_documents
  ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE vendor_documents
  DROP CONSTRAINT IF EXISTS vendor_documents_source_check;
ALTER TABLE vendor_documents
  ADD CONSTRAINT vendor_documents_source_check CHECK (source IS NULL OR source IN ('staff_upload', 'secure_form'));

ALTER TABLE vendor_documents
  ADD COLUMN IF NOT EXISTS vendor_ach_request_id uuid REFERENCES vendor_ach_requests(id) ON DELETE RESTRICT;

-- A secure-form document always names the request it came from.
ALTER TABLE vendor_documents
  DROP CONSTRAINT IF EXISTS vendor_documents_secure_form_provenance;
ALTER TABLE vendor_documents
  ADD CONSTRAINT vendor_documents_secure_form_provenance CHECK (source IS DISTINCT FROM 'secure_form' OR vendor_ach_request_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_documents_ach_request
  ON vendor_documents (vendor_ach_request_id) WHERE vendor_ach_request_id IS NOT NULL;

COMMIT;
