-- ============================================================================
-- 279_builder_arc_invoices.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- Builder ARC invoicing: Bedrock invoices the BUILDER (Lennar at Still Creek,
-- DRB at August Meadows) for their new-home ARC submissions — $150 per
-- submission received in the period (communities.builder_arc_fee_cents).
--
-- Reuses the invoices table (one billing system, one PDF/numbering/void flow).
-- A builder invoice is invoice_type='builder_arc' with builder_company_id set;
-- the recipient (billed-to) is the builder via recipient_name/recipient_address.
-- Its community_id is the community whose ARC activity it covers.
--
-- Builder ARC is billed to the builder, NOT the association — so it never
-- belongs on the HOA activity invoice (the report break-out enforces that).
-- ============================================================================
BEGIN;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS builder_company_id UUID REFERENCES builder_companies(id) ON DELETE SET NULL;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type IN ('fixed', 'activity', 'builder_arc'));

CREATE INDEX IF NOT EXISTS idx_invoices_builder
  ON invoices (builder_company_id, service_period_start) WHERE builder_company_id IS NOT NULL;

COMMIT;
