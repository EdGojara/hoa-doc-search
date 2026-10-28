-- ============================================================================
-- 550_vault_documents.sql  (Ed 2026-10-28)
-- ----------------------------------------------------------------------------
-- Documents for the Owner Vault: the company records of Bedrock and Ed's other
-- companies (leases, letters to the city, tax and IRS notices, insurance,
-- contracts, formation papers), kept apart from every association.
--
-- Record ownership: WORKPAPER. These are Bedrock's and Ed's own records, never
-- an HOA record, so they are never in a community export, never in
-- library_documents, and never embedded or searchable by staff or the AI team.
--
-- Access: like every vault table, the server alone (service_role) reaches it,
-- and only through api/vault.js, which admits the owner and nobody else. Row
-- level security is on with no policies, and anon/authenticated are revoked
-- explicitly, so the database API refuses every client role even if a default
-- privilege would have granted it.
--
-- Files keep their exact bytes (sha256 recorded at upload) in the private
-- 'documents' storage bucket under owner-vault/<entity>/documents/. A document
-- is never deleted from here: it can be archived (and restored). The server has
-- no DELETE privilege on this table.
--
-- No existing row changes.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vault_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES vault_entities(id) ON DELETE RESTRICT,
  category           text NOT NULL DEFAULT 'other'
                       CHECK (category IN ('formation','tax','irs_notice','bank','insurance','lease_property',
                                           'contract','government','correspondence','payroll','legal','other')),
  title              text NOT NULL CHECK (length(btrim(title)) > 0),
  filename           text NOT NULL CHECK (length(btrim(filename)) > 0),  -- the filed name (Entity_Document-Type_Date.ext)
  original_filename  text,                                                 -- the name it was uploaded with
  document_date      date,
  tax_year           integer CHECK (tax_year IS NULL OR tax_year BETWEEN 1990 AND 2100),
  notes              text,
  storage_path       text NOT NULL UNIQUE,
  content_type       text,
  size_bytes         bigint NOT NULL CHECK (size_bytes > 0),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archived_at        timestamptz,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The same file is filed once per company; a second upload finds the first.
  CONSTRAINT vault_documents_entity_sha256_key UNIQUE (entity_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_vault_documents_entity_category ON vault_documents (entity_id, category, document_date DESC);

DROP TRIGGER IF EXISTS trg_vault_documents_updated ON vault_documents;
CREATE TRIGGER trg_vault_documents_updated BEFORE UPDATE ON vault_documents
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE vault_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vault_documents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON vault_documents TO service_role;

COMMIT;
