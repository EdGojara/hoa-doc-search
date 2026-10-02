-- ============================================================================
-- 477_vendor_tax_reporting_status.sql  (Issue #14, Ed 2026-10-02)
-- ----------------------------------------------------------------------------
-- 1099 W-9 compliance: whether a vendor is reportable is STORED vendor-master
-- data with provenance, never guessed at payment time (lib/tax/info_reporting).
--
--   tax_reporting_status   unknown (default) | reportable | exempt_verified
--   tax_exemption_basis    corporation | government | tax_exempt_org |
--                          foreign_person | other            (exempt only)
--   tax_exemption_source   w9_document | irs_document |
--                          government_entity_record | manual_review
--   tax_exemption_document_id  the vendor_documents row that proves it
--   tax_exemption_verified_by / _at / tax_exemption_note
--   is_medical_provider    medical/health-care payments stay reportable even
--                          to a corporation (like is_legal_counsel for attorneys)
--
-- 'exempt_verified' REQUIRES basis + source + verified_by + verified_at (CHECK).
-- Every change to these fields (and to w9_on_file / tax_classification /
-- is_legal_counsel, and to kind / reimbursee_contact_id, so relabeling a payee
-- as an expense reimbursement leaves a trail) is written to
-- vendor_tax_status_events by a trigger, so an exemption always has an audit trail.
--
-- Record ownership: workpaper (Bedrock's vendor master and its tax review). The
-- 1099 filings produced from it are association records, made per community.
-- No existing row's values change: every vendor starts 'unknown' (= potentially
-- reportable), the conservative state. No exemption is backfilled here.
-- ============================================================================
BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS tax_reporting_status      TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS tax_exemption_basis       TEXT,
  ADD COLUMN IF NOT EXISTS tax_exemption_source      TEXT,
  ADD COLUMN IF NOT EXISTS tax_exemption_document_id UUID REFERENCES vendor_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS tax_exemption_verified_by TEXT,
  ADD COLUMN IF NOT EXISTS tax_exemption_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tax_exemption_note        TEXT,
  ADD COLUMN IF NOT EXISTS is_medical_provider       BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_tax_reporting_status_check') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_tax_reporting_status_check CHECK (tax_reporting_status IN ('unknown', 'reportable', 'exempt_verified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_tax_exemption_basis_check') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_tax_exemption_basis_check CHECK (tax_exemption_basis IS NULL OR tax_exemption_basis IN ('corporation', 'government', 'tax_exempt_org', 'foreign_person', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_tax_exemption_source_check') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_tax_exemption_source_check CHECK (tax_exemption_source IS NULL OR tax_exemption_source IN ('w9_document', 'irs_document', 'government_entity_record', 'manual_review'));
  END IF;
  -- An exemption is only real with its provenance.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_tax_exempt_provenance') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_tax_exempt_provenance CHECK (
      tax_reporting_status <> 'exempt_verified'
      OR (tax_exemption_basis IS NOT NULL AND tax_exemption_source IS NOT NULL
          AND tax_exemption_verified_by IS NOT NULL AND tax_exemption_verified_at IS NOT NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vendor_tax_status_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by  TEXT,
  before      JSONB NOT NULL,
  after       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_tax_status_events_vendor ON vendor_tax_status_events (vendor_id, changed_at);
GRANT SELECT, INSERT ON vendor_tax_status_events TO service_role;
GRANT SELECT ON vendor_tax_status_events TO authenticated;

CREATE OR REPLACE FUNCTION vendor_tax_status_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; a jsonb;
BEGIN
  b := jsonb_build_object('tax_reporting_status', OLD.tax_reporting_status, 'tax_exemption_basis', OLD.tax_exemption_basis,
    'tax_exemption_source', OLD.tax_exemption_source, 'tax_exemption_document_id', OLD.tax_exemption_document_id,
    'tax_exemption_verified_by', OLD.tax_exemption_verified_by, 'tax_exemption_verified_at', OLD.tax_exemption_verified_at,
    'tax_exemption_note', OLD.tax_exemption_note, 'is_medical_provider', OLD.is_medical_provider,
    'is_legal_counsel', OLD.is_legal_counsel, 'w9_on_file', OLD.w9_on_file, 'tax_classification', OLD.tax_classification,
    'kind', OLD.kind, 'reimbursee_contact_id', OLD.reimbursee_contact_id);
  a := jsonb_build_object('tax_reporting_status', NEW.tax_reporting_status, 'tax_exemption_basis', NEW.tax_exemption_basis,
    'tax_exemption_source', NEW.tax_exemption_source, 'tax_exemption_document_id', NEW.tax_exemption_document_id,
    'tax_exemption_verified_by', NEW.tax_exemption_verified_by, 'tax_exemption_verified_at', NEW.tax_exemption_verified_at,
    'tax_exemption_note', NEW.tax_exemption_note, 'is_medical_provider', NEW.is_medical_provider,
    'is_legal_counsel', NEW.is_legal_counsel, 'w9_on_file', NEW.w9_on_file, 'tax_classification', NEW.tax_classification,
    'kind', NEW.kind, 'reimbursee_contact_id', NEW.reimbursee_contact_id);
  IF a IS DISTINCT FROM b THEN
    INSERT INTO vendor_tax_status_events (vendor_id, changed_by, before, after)
      VALUES (NEW.id, COALESCE(NEW.tax_exemption_verified_by, current_user), b, a);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vendor_tax_status_audit ON vendors;
CREATE TRIGGER trg_vendor_tax_status_audit AFTER UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendor_tax_status_audit();

COMMIT;
