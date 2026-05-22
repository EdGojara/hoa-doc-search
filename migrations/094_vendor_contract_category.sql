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

-- typical_frequency CHECK constraint allows: 'one_time','annual','quarterly',
-- 'monthly','event_driven','perpetual'. Vendor contracts most commonly renew
-- annually (pool, landscape, security all run year-to-year), so 'annual'.
INSERT INTO document_categories
  (category, display_name, description, typical_frequency, typical_expiration_months, required_for_resale, sort_order)
VALUES
  ('vendor_contract', 'Vendor Contract',
   'Signed vendor management agreement for an amenity (pool management, landscape, security, etc.). Links to the relevant amenity row via amenities.management_contract_doc_id.',
   'annual', 12, FALSE, 245)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description  = EXCLUDED.description;

COMMIT;
