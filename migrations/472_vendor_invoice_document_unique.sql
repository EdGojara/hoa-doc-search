-- ============================================================================
-- 472_vendor_invoice_document_unique.sql  (Issue #9 step 1, ChatGPT review)
-- ----------------------------------------------------------------------------
-- Canonical AP intake (lib/ap/intake.js commitInvoice → ensureInvoiceDocument)
-- now files every vendor invoice PDF as ONE library_documents row
-- (category 'vendor_invoice'), reused by (community, file hash). The app does
-- SELECT-then-INSERT; this index makes that identity DATABASE-enforced, so two
-- intake runs racing on the same PDF (e.g. the same bill emailed to Emma and
-- uploaded in Payables at the same moment) cannot both insert. The loser gets
-- a unique violation, and ensureInvoiceDocument re-selects the winner.
--
-- Scope is deliberately narrow: ONLY vendor_invoice rows with a hash. Other
-- library categories that happen to share a file hash are untouched.
--
-- Record ownership: library_documents holds association records (vendor
-- invoices are association_record); this migration adds no data.
--
-- Pre-check (production, read-only, 2026-09-29): 6 vendor_invoice rows with a
-- hash, 0 duplicate (community_id, file_hash) groups, 0 with null community.
-- ============================================================================
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_library_documents_vendor_invoice_hash
  ON library_documents (community_id, file_hash)
  WHERE category = 'vendor_invoice' AND file_hash IS NOT NULL;

COMMIT;
