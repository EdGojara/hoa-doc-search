-- 163: Insurance Comparison module — board-facing tool for evaluating
-- 2-4 carrier quotes side-by-side at renewal. Lives under the Vendors tab.
--
-- Record ownership (per CLAUDE.md):
--   - insurance_comparisons: 'mixed' — the synthesis_text + side-by-side
--     comparison table delivered to the board is association_record;
--     the multi-lens reasoning workpaper behind it is Bedrock's IP.
--   - insurance_quotes: 'mixed' — the source PDF (library_documents) is
--     association_record (received on behalf of the HOA); the extracted
--     structured JSON + extraction warnings are workpaper (Bedrock's
--     extraction quality, not the carrier's data).
--
-- Single source of truth (per CLAUDE.md):
--   - Quote PDFs live in library_documents (category='insurance_quote').
--     insurance_quotes.library_document_id is the FK back. We mirror the
--     structured extraction here for fast side-by-side queries.
--
-- NOT building decision-binding policy purchasing — Bedrock compares,
-- the licensed agent binds. The synthesis text frames quotes for the
-- board's fiduciary decision, never asserts coverage adequacy as a
-- legal position.

BEGIN;

-- ---------------------------------------------------------------------------
-- insurance_comparisons — one row per "compare these N quotes" exercise
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insurance_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  policy_type text NOT NULL CHECK (policy_type IN (
    'property_master',     -- master building / property policy
    'general_liability',
    'd_and_o',             -- directors & officers
    'fidelity_crime',
    'umbrella',
    'workers_comp',
    'cyber',
    'flood',
    'package'              -- bundled (most common HOA case)
  )),
  title text,                       -- e.g. "2026 Master Policy Renewal"
  policy_year integer,
  effective_date date,              -- target effective date for the new policy
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'synthesized', 'presented_to_board', 'decided', 'archived'
  )),
  selected_quote_id uuid,           -- set when board picks one (FK added below — circular)
  board_decision_date date,
  board_decision_notes text,
  synthesis_text text,              -- the Bedrock recommendation paragraph
  synthesis_model text,             -- model name used (audit)
  synthesis_generated_at timestamptz,
  record_ownership text NOT NULL DEFAULT 'mixed'
    CHECK (record_ownership IN ('association_record','workpaper','mixed')),
  created_by uuid,                  -- user_profiles.id; no FK to avoid coupling
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_comparisons_community
  ON insurance_comparisons(community_id, status);
CREATE INDEX IF NOT EXISTS idx_insurance_comparisons_year
  ON insurance_comparisons(community_id, policy_year DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_insurance_comparisons_updated_at ON insurance_comparisons;
CREATE TRIGGER trg_insurance_comparisons_updated_at
  BEFORE UPDATE ON insurance_comparisons
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- insurance_quotes — one row per carrier quote within a comparison
-- ---------------------------------------------------------------------------
-- All money fields are in CENTS to match the rest of the codebase
-- (reserve, owner-AR, vendor invoices all use cents). UI converts.
CREATE TABLE IF NOT EXISTS insurance_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL REFERENCES insurance_comparisons(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  library_document_id uuid REFERENCES library_documents(id) ON DELETE SET NULL,

  -- Carrier + agent
  carrier_name text,
  agent_name text,
  agent_email text,
  agent_phone text,
  policy_number text,               -- if provided on quote
  quote_number text,                -- carrier's reference

  -- Dates + premium
  annual_premium_cents bigint,
  effective_date date,
  expiration_date date,

  -- Carrier financial rating
  am_best_rating text,              -- "A+", "A", "A-", "B++" — stored as text

  -- Coverage limits (universal subset; specific types use the relevant ones)
  deductible_cents bigint,
  per_occurrence_limit_cents bigint,
  aggregate_limit_cents bigint,
  property_limit_cents bigint,      -- for property/master policies
  liability_limit_cents bigint,
  d_and_o_limit_cents bigint,
  fidelity_limit_cents bigint,
  umbrella_limit_cents bigint,
  flood_limit_cents bigint,

  -- Structural attributes
  coinsurance_pct numeric(5,2),
  replacement_cost boolean,         -- vs. actual cash value
  blanket_limit boolean,            -- aggregated across buildings
  wind_hail_deductible_pct numeric(5,2),  -- TX/coastal — separate %
  wind_hail_deductible_cents bigint,      -- if flat dollar instead

  -- Notable line items as arrays (rendered as bullets in comparison)
  notable_endorsements text[],      -- e.g. ["Equipment Breakdown", "Ordinance & Law $50k"]
  notable_exclusions text[],        -- e.g. ["Mold $25k cap", "Asbestos", "Cyber"]
  notable_sublimits jsonb,          -- {"mold": 25000, "fungus": 25000} — sublimit caps
  payment_options text[],           -- ["Annual", "Quarterly + 3%", "Monthly + 8%"]

  -- Audit + extraction provenance
  extracted_at timestamptz,
  extraction_raw jsonb,             -- raw Claude response (audit; debug-first)
  extraction_confidence text CHECK (extraction_confidence IN ('high','medium','low','manual')),
  extraction_warnings text[],       -- e.g. ["aggregate_limit not visible in PDF — verify with agent"]
  manual_override boolean NOT NULL DEFAULT false,

  notes text,                       -- staff free-text annotation
  record_ownership text NOT NULL DEFAULT 'mixed'
    CHECK (record_ownership IN ('association_record','workpaper','mixed')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_quotes_comparison
  ON insurance_quotes(comparison_id);
CREATE INDEX IF NOT EXISTS idx_insurance_quotes_community
  ON insurance_quotes(community_id);
CREATE INDEX IF NOT EXISTS idx_insurance_quotes_document
  ON insurance_quotes(library_document_id);

DROP TRIGGER IF EXISTS trg_insurance_quotes_updated_at ON insurance_quotes;
CREATE TRIGGER trg_insurance_quotes_updated_at
  BEFORE UPDATE ON insurance_quotes
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Now add the circular FK selected_quote_id → insurance_quotes(id).
-- ON DELETE SET NULL: if the picked quote gets deleted (shouldn't, but),
-- the comparison status reverts to no-selection rather than cascade-erasing
-- the board decision record.
ALTER TABLE insurance_comparisons
  ADD CONSTRAINT insurance_comparisons_selected_quote_fk
  FOREIGN KEY (selected_quote_id) REFERENCES insurance_quotes(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Extend library_documents category to allow 'insurance_quote'.
-- The category column is text + CHECK in some envs, text-only in others —
-- this UPDATE is safe either way. New ingest uses the category for tile-gating.
-- ---------------------------------------------------------------------------
-- No constraint changes needed: library_documents.category is free-text
-- across the codebase; existing categories include 'vendor_invoice',
-- 'vendor_contract', 'declaration_ccrs', etc. The string 'insurance_quote'
-- and 'insurance_policy' are added by convention here.

COMMIT;
