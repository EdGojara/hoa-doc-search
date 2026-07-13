-- ============================================================================
-- 296_billing_pending_items.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- Staging queue for ad-hoc billing charges (reimbursables, community events,
-- one-offs) that accumulate for a community between invoices. Staff email the
-- billing intake address -> Tessa extracts + maps to rate-card categories and
-- stages a row here; a manual "add billing item" form does the same by hand.
-- Pending rows auto-drop onto the community's next draft invoice worksheet and
-- flip to 'billed' (with invoice_id) when that invoice is generated.
--
-- Record ownership: this is a Bedrock production-process STAGING table
-- (workpaper). The charge only becomes an association_record once it lands on an
-- invoice as an invoice_line_items row (see CLAUDE.md record-ownership table).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS billing_pending_items (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id  UUID NOT NULL,
  community_id           UUID REFERENCES communities(id) ON DELETE CASCADE,
  -- Rate-card category key (contract_reimbursables/contract_owner_charges.category);
  -- nullable for a pure free-text ad-hoc charge with its own amount.
  category               TEXT,
  description            TEXT NOT NULL,
  qty                    NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price             NUMERIC(12,4) NOT NULL DEFAULT 0,
  amount                 NUMERIC(12,2) NOT NULL DEFAULT 0,   -- app-computed qty * unit_price
  source                 TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','email')),
  source_ref             TEXT,          -- email graph id (idempotency; NOT unique — one email may stage many items)
  submitted_by           TEXT,          -- staff email / name who requested the charge
  note                   TEXT,          -- original request text / context for the reviewer
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','billed','dismissed')),
  invoice_id             UUID REFERENCES invoices(id) ON DELETE SET NULL,
  billed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bpi_community_status ON billing_pending_items (community_id, status);
CREATE INDEX IF NOT EXISTS idx_bpi_source_ref       ON billing_pending_items (source_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_pending_items TO service_role;
GRANT SELECT                         ON billing_pending_items TO authenticated;

COMMIT;
