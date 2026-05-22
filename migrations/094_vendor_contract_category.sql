-- ============================================================================
-- 094_vendor_contract_category.sql
-- ----------------------------------------------------------------------------
-- Add 'vendor_contract' to document_categories so signed amenity operating
-- contracts (pool management, landscape, security, pest control, etc.) can
-- live in library_documents as a distinct category. Today these would all
-- get filed as 'other' and lose their audit trail.
--
-- This is what the amenities-admin "Extract from contract PDF" flow links
-- to via amenities.management_contract_doc_id.
-- ============================================================================

BEGIN;

INSERT INTO document_categories
  (category, display_name, description, typical_frequency, typical_expiration_months, required_for_resale, sort_order)
VALUES
  ('vendor_contract', 'Vendor Contract',
   'Signed vendor management agreement for an amenity (pool management, landscape, security, etc.). Links to the relevant amenity row via amenities.management_contract_doc_id.',
   'multi_year', 12, FALSE, 245)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description  = EXCLUDED.description;

COMMIT;
