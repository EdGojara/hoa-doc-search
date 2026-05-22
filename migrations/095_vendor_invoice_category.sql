-- ============================================================================
-- 095_vendor_invoice_category.sql
-- ----------------------------------------------------------------------------
-- Vendor invoice PDFs (the ones we drop on the reserve invoice review queue)
-- now live as a distinct document_categories type. Also adds an intake_
-- document_id column on reserve_invoice_intake so the invoice PDF links to
-- its library_documents row, and that doc_id flows through to
-- reserve_expenditures.invoice_doc_id at match time.
-- ============================================================================

BEGIN;

INSERT INTO document_categories
  (category, display_name, description, typical_frequency, typical_expiration_months, required_for_resale, sort_order)
VALUES
  ('vendor_invoice', 'Vendor Invoice',
   'Vendor invoice PDFs ingested into the reserve invoice review queue. Linked to reserve_invoice_intake.intake_document_id; flows to reserve_expenditures.invoice_doc_id on match.',
   'event_driven', NULL, FALSE, 246)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description  = EXCLUDED.description;

-- Link the intake row to its source PDF (library_documents row)
ALTER TABLE reserve_invoice_intake
  ADD COLUMN IF NOT EXISTS intake_document_id UUID
    REFERENCES library_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reserve_invoice_intake_document
  ON reserve_invoice_intake(intake_document_id)
  WHERE intake_document_id IS NOT NULL;

COMMIT;
