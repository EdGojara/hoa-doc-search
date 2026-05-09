-- ============================================================================
-- 009_vendor_master.sql
-- ----------------------------------------------------------------------------
-- Vendor master + invoice intake + vendor documents.
--
-- Strategic role:
--   - Sales weapon vs Vantaca: "Vantaca tracks what you spent; Bedrock tracks
--     WHO you spent it with, why, the supporting documents, and whether it
--     should have been spent at all."
--   - Layer-3 audit substrate: vendor benchmarking + fraud-risk-indicator
--     services (the consulting product) read from this data.
--
-- Tables:
--   vendors                  master record per management company (cross-community)
--   vendor_documents         contracts, COIs, W-9s, scope-of-work attachments
--   invoices_received        vendor invoices the community pays (the AP source docs)
--   invoice_gl_matches       (created here, populated by Push 2's matching engine)
--
-- Apply AFTER 001 (foundation). Idempotent.
-- ============================================================================

-- ============================================================================
-- vendors
-- One row per (management_company_id, vendor identity). Cross-community by
-- design — the same landscaping company may serve multiple HOAs in the
-- portfolio, and the vendor master should reflect that.
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendors (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  name                     TEXT NOT NULL,                                -- canonical name (e.g., "Highetech Lawn Services LLC")
  dba                      TEXT,                                         -- doing-business-as / common name
  ein                      TEXT,                                         -- EIN/TIN (encrypted later if needed)
  address                  TEXT,
  phone                    TEXT,
  email                    TEXT,
  website                  TEXT,
  category                 TEXT,                                         -- e.g. "landscaping", "security", "pool", "legal"
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','inactive','blacklisted')),
  w9_on_file               BOOLEAN NOT NULL DEFAULT FALSE,
  w9_uploaded_at           TIMESTAMPTZ,
  notes                    TEXT,
  first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_invoice_at          TIMESTAMPTZ,
  total_invoiced_lifetime  NUMERIC(14,2) NOT NULL DEFAULT 0,             -- denormalized rolling total
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_mgmt_co
  ON vendors(management_company_id, status, name);
CREATE INDEX IF NOT EXISTS idx_vendors_name_search
  ON vendors USING gin (to_tsvector('english', name));

DROP TRIGGER IF EXISTS trg_vendors_updated_at ON vendors;
CREATE TRIGGER trg_vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- vendor_documents
-- Contracts, COIs, W-9s, scope-of-work attachments — the supporting docs
-- that prove vendor relationship and surface compliance risks (insurance
-- expiration, missing W-9 for 1099 readiness).
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_documents (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id                UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  doc_type                 TEXT NOT NULL
                           CHECK (doc_type IN ('contract','coi','w9','scope_of_work','reference','other')),
  file_name                TEXT,
  file_url                 TEXT,
  effective_date           DATE,
  expires_at               DATE,                                         -- critical for COI expiration tracking
  notes                    TEXT,
  uploaded_by              UUID,
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_docs_vendor_type
  ON vendor_documents(vendor_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_vendor_docs_expiring
  ON vendor_documents(expires_at)
  WHERE expires_at IS NOT NULL;

-- ============================================================================
-- invoices_received
-- Vendor invoices the community pays. The AP source documents that vouch GL
-- entries.
--
-- service_period_* drives the matching engine (Push 2) — accrual accounting
-- means a March invoice for February services should match a February GL
-- accrual, so service period is the primary signal, not invoice_date.
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoices_received (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID REFERENCES communities(id),               -- nullable if cross-community / unassigned at intake
  vendor_id                UUID NOT NULL REFERENCES vendors(id),
  invoice_number           TEXT,
  invoice_date             DATE,
  service_period_start     DATE,
  service_period_end       DATE,
  due_date                 DATE,
  total_amount             NUMERIC(14,2),
  currency                 TEXT NOT NULL DEFAULT 'USD',
  line_items               JSONB,                                         -- [{description, qty, unit_price, amount}, ...]
  raw_text                 TEXT,                                          -- preserved for replay/audit
  file_name                TEXT,
  file_url                 TEXT,                                          -- where the source PDF lives (later: Supabase Storage)
  source                   TEXT NOT NULL DEFAULT 'manual_upload'
                           CHECK (source IN ('manual_upload','email_forward','vantaca_export','api')),
  parsed_at                TIMESTAMPTZ,
  parser_model             TEXT,
  parse_confidence         TEXT
                           CHECK (parse_confidence IN ('high','medium','low')),
  status                   TEXT NOT NULL DEFAULT 'received'
                           CHECK (status IN ('received','posted','paid','disputed','voided')),
  gl_match_status          TEXT NOT NULL DEFAULT 'unmatched'
                           CHECK (gl_match_status IN ('unmatched','matched','partial','disputed')),
  notes                    TEXT,
  uploaded_by              UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_recv_mgmt_co_date
  ON invoices_received(management_company_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_recv_vendor
  ON invoices_received(vendor_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_recv_community
  ON invoices_received(community_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_recv_unmatched
  ON invoices_received(management_company_id, gl_match_status)
  WHERE gl_match_status = 'unmatched';

DROP TRIGGER IF EXISTS trg_inv_recv_updated_at ON invoices_received;
CREATE TRIGGER trg_inv_recv_updated_at
  BEFORE UPDATE ON invoices_received
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- invoice_gl_matches
-- Many-to-many between received invoices and GL monthly balances.
-- Created here; populated by Push 2's matching engine. One invoice can
-- split across multiple GL lines (e.g., one bill for landscaping +
-- irrigation each posted to its own account).
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_gl_matches (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id               UUID NOT NULL REFERENCES invoices_received(id) ON DELETE CASCADE,
  gl_balance_id            UUID NOT NULL REFERENCES gl_monthly_balances(id) ON DELETE CASCADE,
  allocated_amount         NUMERIC(14,2) NOT NULL,
  match_method             TEXT NOT NULL DEFAULT 'manual'
                           CHECK (match_method IN ('auto_high','auto_medium','manual')),
  confidence               TEXT
                           CHECK (confidence IN ('high','medium','low')),
  matched_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_by               UUID,
  notes                    TEXT,
  UNIQUE (invoice_id, gl_balance_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_gl_matches_invoice
  ON invoice_gl_matches(invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_gl_matches_gl
  ON invoice_gl_matches(gl_balance_id);

-- ============================================================================
-- Trigger: keep vendors.last_invoice_at and total_invoiced_lifetime in sync
-- with invoices_received insertions.
-- ============================================================================
CREATE OR REPLACE FUNCTION trusted_vendor_invoice_rollup()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE vendors
    SET total_invoiced_lifetime = COALESCE(total_invoiced_lifetime, 0) + COALESCE(NEW.total_amount, 0),
        last_invoice_at = GREATEST(COALESCE(last_invoice_at, '1900-01-01'::timestamptz),
                                   COALESCE(NEW.invoice_date::timestamptz, NEW.created_at))
    WHERE id = NEW.vendor_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE vendors
    SET total_invoiced_lifetime = GREATEST(0, COALESCE(total_invoiced_lifetime, 0) - COALESCE(OLD.total_amount, 0))
    WHERE id = OLD.vendor_id;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Adjust the rollup if the amount changed.
    IF OLD.total_amount IS DISTINCT FROM NEW.total_amount THEN
      UPDATE vendors
      SET total_invoiced_lifetime = COALESCE(total_invoiced_lifetime, 0) + COALESCE(NEW.total_amount, 0) - COALESCE(OLD.total_amount, 0)
      WHERE id = NEW.vendor_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_invoice_rollup ON invoices_received;
CREATE TRIGGER trg_vendor_invoice_rollup
  AFTER INSERT OR UPDATE OR DELETE ON invoices_received
  FOR EACH ROW EXECUTE FUNCTION trusted_vendor_invoice_rollup();

-- ============================================================================
-- Row Level Security (defensive — service-role bypasses)
-- ============================================================================
ALTER TABLE vendors             ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices_received   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_gl_matches  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_vendors_tenant ON vendors;
CREATE POLICY p_vendors_tenant ON vendors
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_vendor_docs_tenant ON vendor_documents;
CREATE POLICY p_vendor_docs_tenant ON vendor_documents
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM vendors v
    WHERE v.id = vendor_documents.vendor_id
      AND v.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_inv_recv_tenant ON invoices_received;
CREATE POLICY p_inv_recv_tenant ON invoices_received
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_inv_gl_matches_tenant ON invoice_gl_matches;
CREATE POLICY p_inv_gl_matches_tenant ON invoice_gl_matches
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM invoices_received ir
    WHERE ir.id = invoice_gl_matches.invoice_id
      AND ir.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ============================================================================
-- API role grants
-- ============================================================================
GRANT ALL ON vendors, vendor_documents, invoices_received, invoice_gl_matches
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  vendors, vendor_documents, invoices_received, invoice_gl_matches
  TO authenticated;

-- ============================================================================
-- Convenience view: vendor with rollups + COI status
-- ============================================================================
CREATE OR REPLACE VIEW v_vendors_with_status AS
SELECT
  v.id,
  v.management_company_id,
  v.name,
  v.dba,
  v.category,
  v.status,
  v.w9_on_file,
  v.last_invoice_at,
  v.total_invoiced_lifetime,
  v.first_seen_at,
  (
    SELECT COUNT(*) FROM invoices_received ir WHERE ir.vendor_id = v.id
  ) AS invoice_count,
  (
    SELECT MIN(d.expires_at) FROM vendor_documents d
    WHERE d.vendor_id = v.id AND d.doc_type = 'coi' AND d.expires_at IS NOT NULL
  ) AS earliest_coi_expiry,
  (
    SELECT MIN(d.expires_at) FROM vendor_documents d
    WHERE d.vendor_id = v.id AND d.doc_type = 'contract' AND d.expires_at IS NOT NULL
  ) AS earliest_contract_expiry
FROM vendors v;

GRANT SELECT ON v_vendors_with_status TO service_role, authenticated;

-- ============================================================================
-- Done. Verify with:
--   SELECT COUNT(*) FROM vendors;            -- expect 0
--   SELECT COUNT(*) FROM invoices_received;  -- expect 0
-- ============================================================================
