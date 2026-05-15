-- ============================================================================
-- 041_management_agreement.sql
-- ----------------------------------------------------------------------------
-- Management-agreement document module. The existing billing infrastructure
-- (contracts + contract_fixed_items + contract_reimbursables +
-- contract_owner_charges) already stores per-community fee schedules and
-- drives invoicing. This migration adds the layer needed to ALSO generate
-- the customer-facing management agreement document (the thing boards sign):
--
--   1) Per-lot math on the contract — internal only. Monthly management fee
--      can be computed as lot_count * per_lot_monthly_fee, OR set explicitly
--      via monthly_fee_override (for negotiated flat deals). The customer
--      sees only the resulting total on the agreement; the lots/rate math
--      stays in the DB.
--   2) bedrock_contract_defaults — a singleton holding the Bedrock-standard
--      rate sheet (fixed + reimbursables + owner charges) and the legal
--      boilerplate of the management agreement with merge tokens. New
--      community contracts copy from this; subsequent edits to defaults
--      do NOT retroactively change existing executed contracts.
--   3) management_agreement_documents — generated agreement PDFs, one per
--      contract version. Tracks effective date, signed/unsigned state,
--      storage path.
--
-- Apply AFTER 040. Idempotent.
-- ============================================================================

BEGIN;

-- 1) Per-lot pricing math on the contract row. All optional — legacy
--    contracts continue to use flat monthly fees via contract_fixed_items.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS lot_count             INTEGER NULL CHECK (lot_count IS NULL OR lot_count >= 0),
  ADD COLUMN IF NOT EXISTS per_lot_monthly_fee   NUMERIC(10,4) NULL CHECK (per_lot_monthly_fee IS NULL OR per_lot_monthly_fee >= 0),
  ADD COLUMN IF NOT EXISTS monthly_fee_override  NUMERIC(12,2) NULL CHECK (monthly_fee_override IS NULL OR monthly_fee_override >= 0),
  ADD COLUMN IF NOT EXISTS term_months           INTEGER NULL CHECK (term_months IS NULL OR term_months > 0);

COMMENT ON COLUMN contracts.lot_count IS
  'Number of lots in the community at the time of contract execution. INTERNAL ONLY — does not print on the management agreement.';
COMMENT ON COLUMN contracts.per_lot_monthly_fee IS
  'Bedrock''s per-lot monthly management fee for this community. INTERNAL ONLY — does not print on the management agreement. Customer sees only the resulting total.';
COMMENT ON COLUMN contracts.monthly_fee_override IS
  'Optional explicit monthly management fee. When set, overrides the lot_count * per_lot_monthly_fee calculation. Used for negotiated flat-fee deals where the per-lot math doesn''t represent the agreement.';

-- 2) Bedrock-wide defaults singleton. One row, id = 1 always.
CREATE TABLE IF NOT EXISTS bedrock_contract_defaults (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  -- Per-lot default rate Bedrock offers new clients (negotiable per deal).
  default_per_lot_monthly_fee NUMERIC(10,4) NULL,
  default_term_months         INTEGER NULL DEFAULT 12,
  -- The legal boilerplate of the management agreement. Supports merge tokens:
  --   {{community_name}}, {{community_address}}, {{monthly_fee}},
  --   {{effective_date}}, {{term_months}}, {{lot_count_internal}}, etc.
  contract_body_template      TEXT NULL,
  -- Default rate sheet entries new contracts copy in. Each blob is an array
  -- of {category, description, amount, billing_method?, notes?} rows that
  -- get inserted into the contract_*_items tables when a new contract is
  -- created from defaults.
  default_fixed_items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_reimbursables       JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_owner_charges       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by                  TEXT NULL,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the singleton row if it doesn't exist. Ed fills in the actual
-- defaults via the UI; this just guarantees the row exists for upserts.
INSERT INTO bedrock_contract_defaults (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

-- 3) Generated agreement documents — one row per render.
CREATE TABLE IF NOT EXISTS management_agreement_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  community_id        UUID NOT NULL REFERENCES communities(id),
  -- Snapshot at generation time so future edits to the contract don't
  -- silently rewrite the historical document.
  snapshot            JSONB NOT NULL,
  pdf_storage_path    TEXT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','executed','superseded','void')),
  generated_by        TEXT NULL,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ NULL,
  executed_at         TIMESTAMPTZ NULL,
  executed_by         TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mgmt_agreement_contract
  ON management_agreement_documents (contract_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mgmt_agreement_community_status
  ON management_agreement_documents (community_id, status, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock_contract_defaults TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON management_agreement_documents TO service_role;

COMMIT;

-- Verify:
--   SELECT id, lot_count, per_lot_monthly_fee, monthly_fee_override, term_months
--     FROM contracts LIMIT 5;
--   SELECT id, default_per_lot_monthly_fee, default_term_months,
--          jsonb_array_length(default_fixed_items)        AS fixed_count,
--          jsonb_array_length(default_reimbursables)      AS reimb_count,
--          jsonb_array_length(default_owner_charges)      AS owner_count
--     FROM bedrock_contract_defaults;
