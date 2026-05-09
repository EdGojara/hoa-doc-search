-- ============================================================================
-- 001_foundation.sql
-- ----------------------------------------------------------------------------
-- Foundation tables for trustEd. Everything that comes after (Bedrock Billing,
-- HOA Financial Review, Board Packet, DRV) builds on top of this.
--
-- Establishes:
--   - management_companies   tenancy root (Bedrock today; licensees later)
--   - communities            HOA communities the management company manages
--   - contracts              versioned management agreements per community
--   - agent_runs             "trade tape" — every AI call persisted (P3 from priorities)
--   - kill_switches          per-module / per-community pause control with reason
--   - RLS scaffolding        policies are defensive; service-role bypasses,
--                            so current server.js behavior is preserved
--
-- Idempotent: safe to re-run.
--
-- Apply via Supabase SQL editor, or `psql $SUPABASE_CONN < 001_foundation.sql`.
-- ============================================================================

-- Required extensions ------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- updated_at trigger helper ------------------------------------------------
CREATE OR REPLACE FUNCTION trusted_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- management_companies
-- The tenancy root. Bedrock is the only row today; licensees later.
-- The Bedrock UUID is hardcoded in server.js as BEDROCK_MGMT_CO_ID.
-- ============================================================================
CREATE TABLE IF NOT EXISTS management_companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  legal_name      TEXT,
  ein             TEXT,                       -- federal tax id, encrypted later if needed
  contact_email   TEXT,
  contact_phone   TEXT,
  address         TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defensive: if management_companies already exists with an older schema
-- (e.g., from prior multi-tenancy work), bring it to spec without dropping.
-- ADD COLUMN IF NOT EXISTS is idempotent and non-destructive.
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS legal_name    TEXT;
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS ein           TEXT;
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS active        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE management_companies ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS trg_mgmt_co_updated_at ON management_companies;
CREATE TRIGGER trg_mgmt_co_updated_at
  BEFORE UPDATE ON management_companies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Seed Bedrock with the UUID server.js already uses.
INSERT INTO management_companies (id, name, legal_name, contact_email, contact_phone, address)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Bedrock Association Management',
  'Bedrock Association Management, LLC',
  'info@bedrocktx.com',
  '(832) 588-2485',
  '12808 W Airport Blvd, Sugar Land, TX 77478'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      legal_name = EXCLUDED.legal_name,
      contact_email = EXCLUDED.contact_email,
      contact_phone = EXCLUDED.contact_phone,
      address = EXCLUDED.address;

-- ============================================================================
-- communities
-- HOA communities the management company manages. Multi-tenant from day one.
-- vantaca_code is the short suffix used in invoice numbers (e.g. "WV" for
-- Waterview Estates, producing 2510WV / 2601WV2 patterns).
-- ============================================================================
CREATE TABLE IF NOT EXISTS communities (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  name                     TEXT NOT NULL,
  legal_name               TEXT,
  vantaca_code             TEXT,                          -- short code for invoice numbering
  vantaca_account_id       TEXT,                          -- Vantaca's stable id, when known
  county                   TEXT,
  state                    TEXT DEFAULT 'TX',
  total_lots               INTEGER,                       -- platted-lot count, used for $/lot fees
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (management_company_id, vantaca_code)
);

CREATE INDEX IF NOT EXISTS idx_communities_mgmt_co
  ON communities(management_company_id) WHERE active;

DROP TRIGGER IF EXISTS trg_communities_updated_at ON communities;
CREATE TRIGGER trg_communities_updated_at
  BEFORE UPDATE ON communities
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- contracts
-- The management agreement between the management company and a community.
-- Versioned: when the fee schedule or terms change, a new version is created
-- and the old one is marked superseded. Historical invoices keep their original
-- contract_version reference for audit integrity.
--
-- Escalator: Waterview's contract Article V allows max(CPI%, 5%) annually.
--   escalator_kind  = 'max_cpi_or_pct'
--   escalator_pct   = 5.00
-- Other supported kinds: 'fixed_pct', 'cpi_only', 'none'.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contracts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id        UUID NOT NULL REFERENCES communities(id),
  version             INTEGER NOT NULL DEFAULT 1,
  effective_date      DATE NOT NULL,
  end_date            DATE,                                -- NULL = open-ended (auto-renewing)
  signed_date         DATE,
  signatories         JSONB,                               -- {community: "...", agent: "..."}
  notice_address      TEXT,                                -- contract Article VI notices clause
  escalator_kind      TEXT NOT NULL DEFAULT 'none'
                      CHECK (escalator_kind IN ('max_cpi_or_pct','fixed_pct','cpi_only','none')),
  escalator_pct       NUMERIC(5,2),                        -- e.g. 5.00 for 5%
  payment_terms       TEXT DEFAULT 'Net 30',
  pdf_url             TEXT,                                -- link to scanned executed PDF
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','superseded','terminated','draft')),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, version)
);

CREATE INDEX IF NOT EXISTS idx_contracts_community_active
  ON contracts(community_id) WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_contracts_updated_at ON contracts;
CREATE TRIGGER trg_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- agent_runs
-- The "trade tape" — every AI call persisted with full context.
-- Required reading when sued by a homeowner, when validating a model upgrade,
-- and when running the daily/weekly postmortem.
--
-- Schema captures:
--   - input the call was made with
--   - retrieved context (playbook entries, doc chunks, GL data, etc.)
--   - the prompt actually sent to the model
--   - the model + version that produced the output
--   - the output
--   - downstream action (was it sent? edited? rejected?)
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_runs (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID REFERENCES communities(id),  -- nullable: cross-community ops
  module                   TEXT NOT NULL,                    -- 'billing','financial_review','ask_ed','acc_review',...
  endpoint                 TEXT,                             -- the route that triggered the run
  user_id                  UUID,                             -- nullable until auth lands
  request_input            JSONB,                            -- what the caller asked for
  retrieved_context        JSONB,                            -- playbook ids, doc chunks, GL refs
  prompt                   TEXT,                             -- the full prompt sent to the model
  model                    TEXT,                             -- 'claude-sonnet-4-6', etc.
  prompt_version           TEXT,                             -- internal version string
  playbook_version         TEXT,                             -- internal version string
  response                 JSONB,                            -- model output (text or structured)
  input_tokens             INTEGER,
  output_tokens            INTEGER,
  cost_usd                 NUMERIC(10,6),
  duration_ms              INTEGER,
  downstream_action        JSONB,                            -- {sent: true, edited: false, reviewer: ...}
  error                    TEXT,                             -- if the call failed, what happened
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_mgmt_co_created
  ON agent_runs(management_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_community_module
  ON agent_runs(community_id, module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_module_created
  ON agent_runs(module, created_at DESC);

-- ============================================================================
-- kill_switches
-- Per-module, optionally per-community, pause control. When a module is
-- "killed" for a scope, the API rejects new AI calls in that scope and
-- returns a status code with the reason. Resumption requires a row update
-- (eventually, a privileged user; for now, anyone with DB access).
--
-- Mental model: HFT incident protocol. Trader hits stop, desk reviews,
-- supervisor greenlights resume.
-- ============================================================================
CREATE TABLE IF NOT EXISTS kill_switches (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID REFERENCES communities(id),  -- NULL = applies cross-community
  module                   TEXT NOT NULL,                    -- 'billing','financial_review',...
  paused_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_by                UUID,                             -- nullable until auth
  reason                   TEXT NOT NULL,                    -- required: WHY are we halting
  resumed_at               TIMESTAMPTZ,
  resumed_by               UUID,
  resume_note              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A scope (mgmt_co + community + module) can have at most one active halt.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_killswitch_scope
  ON kill_switches(management_company_id, COALESCE(community_id, '00000000-0000-0000-0000-000000000000'::uuid), module)
  WHERE resumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_kill_switches_active
  ON kill_switches(management_company_id, module) WHERE resumed_at IS NULL;

-- ============================================================================
-- Row Level Security (defensive)
-- Service role bypasses RLS, so current server.js behavior is unchanged.
-- These policies activate when authenticated users (browser sessions) start
-- hitting the DB directly — at which point P1 + P2 are landing.
-- ============================================================================
ALTER TABLE management_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE kill_switches        ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS by default. These policies cover the
-- "authenticated" role that browser sessions will eventually use.
-- The expected JWT claim is "management_company_id".

DROP POLICY IF EXISTS p_mgmt_co_self ON management_companies;
CREATE POLICY p_mgmt_co_self ON management_companies
  FOR ALL TO authenticated
  USING (id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_communities_tenant ON communities;
CREATE POLICY p_communities_tenant ON communities
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_contracts_tenant ON contracts;
CREATE POLICY p_contracts_tenant ON contracts
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communities c
    WHERE c.id = contracts.community_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_agent_runs_tenant ON agent_runs;
CREATE POLICY p_agent_runs_tenant ON agent_runs
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_kill_switches_tenant ON kill_switches;
CREATE POLICY p_kill_switches_tenant ON kill_switches
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

-- ============================================================================
-- Convenience view: active contract per community
-- (Saves a CASE/JOIN on every billing-draft endpoint.)
-- ============================================================================
CREATE OR REPLACE VIEW v_active_contracts AS
SELECT
  c.community_id,
  c.id AS contract_id,
  c.version AS contract_version,
  c.effective_date,
  c.end_date,
  c.escalator_kind,
  c.escalator_pct,
  c.payment_terms,
  comm.management_company_id,
  comm.name AS community_name,
  comm.vantaca_code
FROM contracts c
JOIN communities comm ON comm.id = c.community_id
WHERE c.status = 'active'
  AND comm.active = TRUE;

-- ============================================================================
-- Done. Verify with:
--   SELECT name FROM management_companies;            -- expect Bedrock
--   SELECT COUNT(*) FROM communities;                 -- expect 0 (seed comes in 003)
--   SELECT COUNT(*) FROM agent_runs;                  -- expect 0
-- ============================================================================
