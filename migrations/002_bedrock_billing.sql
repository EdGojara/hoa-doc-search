-- ============================================================================
-- 002_bedrock_billing.sql
-- ----------------------------------------------------------------------------
-- Schema for the Bedrock Billing module (lives under "Bedrock Office" in
-- trustEd's nav).
--
-- Three contract tables match the structure surfaced by Waterview's Jan 2025
-- fee schedule:
--   - contract_fixed_items       monthly recurring (mgmt fee, website, onsite)
--   - contract_reimbursables     variable, billed to Association (postage,
--                                 copies, work hours, NSF, event staffing)
--   - contract_owner_charges     billed to Association, collected from Owner
--                                 where legally permissible (certified demand
--                                 letters, payment plans, ARC fees, etc.)
--
-- Two invoice tables match the actual two-invoice cycle:
--   - One "fixed" invoice/month, billed in advance
--   - One "activity" invoice/month, billed in arrears (postage, certified mail,
--     etc., reconciled to a Vantaca activity report)
--
-- invoice_events is event-sourced: status is derived, never mutated. The
-- "UPDATED" suffix on Aug 2025's PDF becomes a clean trail of drafted ->
-- sent -> edited_after_send -> resent.
--
-- Apply AFTER 001_foundation.sql.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ============================================================================
-- contract_fixed_items
-- The "Agreement Terms - Fixed Monthly Fee" section of the fee schedule.
-- E.g., Waterview: $4,102 mgmt + $150 website + $2,460 onsite staff.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contract_fixed_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  monthly_amount  NUMERIC(12,2) NOT NULL CHECK (monthly_amount >= 0),
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_fixed_items_contract
  ON contract_fixed_items(contract_id, sort_order);

-- ============================================================================
-- contract_reimbursables
-- "Reimbursable Supplies and Services" — variable, billed monthly as-used.
--
-- billing_method values:
--   'per_unit'              qty * unit_price (postage @ $0.78/unit)
--   'hourly'                hours * unit_price (work outside mgmt @ $75/hr)
--   'per_lot_plus_postage'  total_lots * unit_price + postage cost
--                           (annual statement billing @ $3/lot + postage)
--   'at_cost'               passthrough; unit_price is the operative rate
--                           or NULL if cost-based with monthly true-up
--
-- vantaca_source: column or report name in the Vantaca activity export
-- where the count for this category is sourced. Used for reconciliation.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contract_reimbursables (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id      UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  category         TEXT NOT NULL,                                 -- 'postage','color_copies','certified_letters_assessment',...
  description      TEXT NOT NULL,                                 -- human-readable; goes on the invoice
  billing_method   TEXT NOT NULL
                   CHECK (billing_method IN ('per_unit','hourly','per_lot_plus_postage','at_cost')),
  unit_price       NUMERIC(12,4),                                 -- NULL if pure at_cost
  vantaca_source   TEXT,                                          -- which Vantaca report column drives count
  notes            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contract_id, category)
);

CREATE INDEX IF NOT EXISTS idx_contract_reimb_contract
  ON contract_reimbursables(contract_id, sort_order);

-- ============================================================================
-- contract_owner_charges
-- "Charges payable by Owners where legally permissible (Billed to Association)"
-- These flow Bedrock -> Association -> Owner. The fee on this table is what
-- Bedrock invoices to the Association.
--
-- This is the table where the Jan 2026 / Aug 2025 leakage was hiding:
--   Invoice billed "Certified Letters" @ $25 (the OLD 2017 rate).
--   Contract Jan 2025 has TWO certified letter rates:
--     - assessment_certified_demand_letter      $50.00
--     - deed_restriction_certified_demand_letter $35.00
--   Once seeded with the right rates, the draft invoice will pull the
--   correct rate by category. The certified letter line on future invoices
--   should split by type (assessment vs. deed restriction) so the right rate
--   applies to each.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contract_owner_charges (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,                                  -- stable enum value
  description     TEXT NOT NULL,                                  -- human-readable
  fee_amount      NUMERIC(12,2) NOT NULL CHECK (fee_amount >= 0),
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contract_id, category)
);

CREATE INDEX IF NOT EXISTS idx_contract_owner_charges_contract
  ON contract_owner_charges(contract_id, sort_order);

-- ============================================================================
-- invoices
-- One row per generated invoice (fixed or activity).
-- contract_version is captured at generation time so historical invoices keep
-- their original rate context even after the contract is amended.
--
-- Status is the *current* state, but it is *derived* from invoice_events,
-- not the source of truth. Don't mutate it directly outside of the API layer
-- that also writes the event row.
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoices (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id),
  contract_id              UUID NOT NULL REFERENCES contracts(id),
  contract_version         INTEGER NOT NULL,
  invoice_number           TEXT NOT NULL,                         -- e.g. '2601WV2'
  invoice_type             TEXT NOT NULL CHECK (invoice_type IN ('fixed','activity')),
  service_period_start     DATE NOT NULL,
  service_period_end       DATE NOT NULL CHECK (service_period_end >= service_period_start),
  invoice_date             DATE NOT NULL,
  due_date                 DATE,
  payment_terms            TEXT,
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','review','approved','sent','paid','past_due','disputed','void')),
  subtotal                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  total                    NUMERIC(12,2) NOT NULL DEFAULT 0,
  recipient_name           TEXT,
  recipient_email          TEXT,
  recipient_address        TEXT,
  pdf_url                  TEXT,
  notes                    TEXT,
  generated_by             UUID,                                  -- nullable until auth
  sent_at                  TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (management_company_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_community_period
  ON invoices(community_id, service_period_start);
CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON invoices(management_company_id, status, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_contract
  ON invoices(contract_id);

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- invoice_line_items
-- The composition of an invoice. Each row is one line.
--
-- source identifies where the line came from:
--   'contract_fixed'   from contract_fixed_items
--   'reimbursable'     from contract_reimbursables (qty driven)
--   'owner_charge'     from contract_owner_charges (qty driven)
--   'adhoc'            free-form, manually added (special events, etc.)
--
-- source_ref_id points back to the originating contract row when applicable,
-- so we can trace each line item to the contract clause that authorized it.
--
-- manual_override + manual_override_reason: when staff edits a unit_price on
-- a line that came from the contract, capture WHY. This is the audit trail
-- for the "the contract is the rate card" enforcement layer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id               UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  source                   TEXT NOT NULL
                           CHECK (source IN ('contract_fixed','reimbursable','owner_charge','adhoc')),
  source_ref_id            UUID,                                  -- references contract_*_items where applicable
  category                 TEXT,                                  -- stable enum from the contract row
  description              TEXT NOT NULL,
  qty                      NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price               NUMERIC(12,4) NOT NULL DEFAULT 0,
  amount                   NUMERIC(12,2) NOT NULL DEFAULT 0,      -- app-computed: qty * unit_price
  vantaca_source_ref       TEXT,                                  -- for reconciliation against activity import
  manual_override          BOOLEAN NOT NULL DEFAULT FALSE,
  manual_override_reason   TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice
  ON invoice_line_items(invoice_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_overrides
  ON invoice_line_items(invoice_id) WHERE manual_override;

-- ============================================================================
-- invoice_events
-- Event-sourced log of everything that happens to an invoice.
-- "kind" enumerates the lifecycle steps. The "UPDATED" suffix on Aug 2025's
-- file gets a real, structured trail: drafted -> sent -> edited_after_send
-- -> resent, with a payload for each.
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id        UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL
                    CHECK (kind IN (
                      'created',
                      'edited',
                      'reviewed',
                      'approved',
                      'sent',
                      'edited_after_send',
                      'resent',
                      'paid',
                      'past_due_marked',
                      'disputed',
                      'voided',
                      'note_added'
                    )),
  actor_user_id     UUID,
  payload           JSONB,                                        -- what changed, why, by whom
  agent_run_id      UUID REFERENCES agent_runs(id),               -- if AI generated/edited the invoice
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice_time
  ON invoice_events(invoice_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_events_kind_time
  ON invoice_events(kind, occurred_at DESC);

-- ============================================================================
-- vantaca_activity_imports
-- Staging table for uploaded Vantaca activity exports. Raw upload first,
-- parse second, reconcile against invoice draft third.
-- ============================================================================
CREATE TABLE IF NOT EXISTS vantaca_activity_imports (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id    UUID NOT NULL REFERENCES communities(id),
  service_period  DATE NOT NULL,                                  -- the month being reported
  file_name       TEXT,
  file_url        TEXT,
  uploaded_by     UUID,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parsed_data     JSONB,                                          -- normalized counts by category
  raw_text        TEXT,                                           -- preserve raw for debugging
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','parsed','reconciled','failed')),
  error           TEXT,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_vantaca_imports_community_period
  ON vantaca_activity_imports(community_id, service_period DESC);

-- ============================================================================
-- Row Level Security
-- Same defensive pattern as foundation: service-role bypasses; authenticated
-- users scoped by management_company_id (resolved through community).
-- ============================================================================
ALTER TABLE contract_fixed_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_reimbursables     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_owner_charges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE vantaca_activity_imports   ENABLE ROW LEVEL SECURITY;

-- Helper: tenant check via contract -> community
DROP POLICY IF EXISTS p_contract_fixed_items_tenant ON contract_fixed_items;
CREATE POLICY p_contract_fixed_items_tenant ON contract_fixed_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts ct
    JOIN communities c ON c.id = ct.community_id
    WHERE ct.id = contract_fixed_items.contract_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_contract_reimb_tenant ON contract_reimbursables;
CREATE POLICY p_contract_reimb_tenant ON contract_reimbursables
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts ct
    JOIN communities c ON c.id = ct.community_id
    WHERE ct.id = contract_reimbursables.contract_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_contract_owner_charges_tenant ON contract_owner_charges;
CREATE POLICY p_contract_owner_charges_tenant ON contract_owner_charges
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts ct
    JOIN communities c ON c.id = ct.community_id
    WHERE ct.id = contract_owner_charges.contract_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_invoices_tenant ON invoices;
CREATE POLICY p_invoices_tenant ON invoices
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_invoice_line_items_tenant ON invoice_line_items;
CREATE POLICY p_invoice_line_items_tenant ON invoice_line_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_line_items.invoice_id
      AND i.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_invoice_events_tenant ON invoice_events;
CREATE POLICY p_invoice_events_tenant ON invoice_events
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_events.invoice_id
      AND i.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_vantaca_imports_tenant ON vantaca_activity_imports;
CREATE POLICY p_vantaca_imports_tenant ON vantaca_activity_imports
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communities c
    WHERE c.id = vantaca_activity_imports.community_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ============================================================================
-- Convenience view: full fee schedule for a contract
-- (Saves three separate queries when drafting an invoice.)
-- ============================================================================
CREATE OR REPLACE VIEW v_contract_fee_schedule AS
SELECT
  contract_id,
  'fixed'         AS section,
  id              AS item_id,
  category        AS category,                 -- NULL for fixed (no enum)
  description,
  monthly_amount  AS amount,
  NULL::TEXT      AS billing_method,
  NULL::NUMERIC   AS unit_price,
  NULL::TEXT      AS vantaca_source,
  sort_order
FROM (
  SELECT id, contract_id, NULL::TEXT AS category, description, monthly_amount, sort_order
  FROM contract_fixed_items
) f

UNION ALL

SELECT
  contract_id,
  'reimbursable'  AS section,
  id              AS item_id,
  category,
  description,
  unit_price      AS amount,
  billing_method,
  unit_price,
  vantaca_source,
  sort_order
FROM contract_reimbursables

UNION ALL

SELECT
  contract_id,
  'owner_charge'  AS section,
  id              AS item_id,
  category,
  description,
  fee_amount      AS amount,
  NULL::TEXT      AS billing_method,
  NULL::NUMERIC   AS unit_price,
  NULL::TEXT      AS vantaca_source,
  sort_order
FROM contract_owner_charges;

-- ============================================================================
-- Done. Verify with:
--   SELECT COUNT(*) FROM contract_fixed_items;          -- expect 0 until 003 seeds
--   SELECT * FROM v_contract_fee_schedule LIMIT 1;      -- expect 0 rows until seeded
-- ============================================================================
