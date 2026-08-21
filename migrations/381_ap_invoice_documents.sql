-- ============================================================================
-- 381 — a bill can have more than one document.
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. A vendor invoice and everything filed
-- with it belong to the HOA, and must come out in a termination export. The
-- community FK is on ap_invoices; this table reaches it through invoice_id.
--
-- Ed 2026-08-21, looking at a bill that already had its PDF: "is there a way to
-- add invoice to this screen so it goes to this invoices?"
--
-- Today a bill can hold exactly ONE document — ap_invoices.source_storage_path,
-- with a single source_document_id beside it. That was fine when the only
-- question was "did the invoice come through", and it is wrong for how bills
-- actually arrive:
--
--   a two-page invoice sent as two files
--   the invoice plus the work order it references
--   the proposal that was approved, filed with the bill that followed it
--   before-and-after photos on a repair
--   a corrected copy the vendor sent after the first
--
-- The attach endpoint I shipped earlier today refused a second document with
-- already_has_document, reasoning that swapping evidence under a posted entry is
-- a silent rewrite. That reasoning holds for REPLACING the primary invoice. It
-- was never an argument against ADDING to the file, which is the ordinary case.
-- Append is not edit.
--
-- The primary invoice stays exactly where it is on ap_invoices, so every
-- existing reader (check runs, the payables list, /invoice-file) is untouched.
-- This table is additive.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ap_invoice_documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: the document is the evidence behind a posted journal
  -- entry. Deleting it out from under the bill is exactly what must not happen.
  library_document_id  UUID REFERENCES library_documents(id) ON DELETE RESTRICT,
  kind                 TEXT NOT NULL DEFAULT 'supporting'
                         CHECK (kind IN ('invoice', 'supporting', 'work_order',
                                         'proposal', 'photo', 'correspondence', 'other')),
  label                TEXT,
  storage_path         TEXT NOT NULL,
  file_name            TEXT,
  file_sha256          TEXT,
  file_size_bytes      BIGINT,
  added_by             TEXT,
  added_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same file must not be filed against the same bill twice. A person
-- clicking upload again because they were not sure it worked should be a no-op,
-- not a duplicate row that makes it look like the vendor sent two.
CREATE UNIQUE INDEX IF NOT EXISTS ap_invoice_documents_no_dupes
  ON ap_invoice_documents (invoice_id, file_sha256)
  WHERE file_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS ap_invoice_documents_invoice_idx
  ON ap_invoice_documents (invoice_id, added_at DESC);

-- Finding every bill that carries a given file — the double-payment question.
CREATE INDEX IF NOT EXISTS ap_invoice_documents_sha_idx
  ON ap_invoice_documents (file_sha256) WHERE file_sha256 IS NOT NULL;

DROP TRIGGER IF EXISTS ap_invoice_documents_updated_at ON ap_invoice_documents;
CREATE TRIGGER ap_invoice_documents_updated_at
  BEFORE UPDATE ON ap_invoice_documents
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Without these the API cannot write the table at all, and the failure arrives
-- deep in a side-effect chain where nobody sees it.
GRANT SELECT, INSERT, UPDATE, DELETE ON ap_invoice_documents TO service_role;
GRANT SELECT                          ON ap_invoice_documents TO authenticated;

COMMENT ON TABLE ap_invoice_documents IS
  'Additional documents filed against an AP bill (second page, work order, proposal, photos). The PRIMARY invoice stays on ap_invoices.source_storage_path. association_record.';
COMMENT ON COLUMN ap_invoice_documents.kind IS
  'invoice = another page or copy of the bill itself; supporting = anything filed with it.';

COMMIT;
