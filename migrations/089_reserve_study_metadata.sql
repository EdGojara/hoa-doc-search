-- ============================================================================
-- 089_reserve_study_metadata.sql
-- ----------------------------------------------------------------------------
-- Reserve study-level metadata + annual funding plan. Sits alongside the
-- per-component reserve_components / reserve_expenditures tables (migration
-- 088) and gives us the "live-vs-projected" reserve health view boards see
-- on the reserve map.
--
-- One row in reserve_study_versions per study (typically every 3-5 years).
-- The components in reserve_components link to a study version via
-- source_document_id (already exists) and now via reserve_study_version_id.
--
-- The funding plan is 30 years of projected contributions, interest, and
-- expenditures per fiscal year — extracted from Reserve Advisors LLC v7.0
-- spreadsheet's "Funding Plan" sheet. We compare it to actuals from
-- reserve_expenditures + community ledger to show variance.
--
-- Apply after 088. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) reserve_study_versions — one row per study (2024 study, 2027 update, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_study_versions (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,

  -- Study identification
  study_firm                        TEXT,            -- "Reserve Advisors LLC"
  study_format                      TEXT,            -- "reserve_advisors_v7"
  reference_number                  TEXT,            -- firm-assigned reference number
  inspection_date                   DATE,
  fiscal_year                       INTEGER,         -- e.g., 2024
  fiscal_year_begin                 DATE,
  first_year_recommendation         INTEGER,
  length_years                      INTEGER,         -- 30
  units_count                       INTEGER,

  -- Financial assumptions
  beginning_balance_cents           BIGINT,          -- as of beginning_balance_date
  beginning_balance_date            DATE,
  near_term_inflation               NUMERIC(7,5),    -- 0.03300 = 3.30%
  remaining_inflation               NUMERIC(7,5),
  last_year_near_term               INTEGER,
  interest_rate                     NUMERIC(7,5),    -- 0.02700 = 2.70%
  contributions_per_year            INTEGER,         -- 12 = monthly

  -- Source document
  source_document_id                UUID REFERENCES library_documents(id) ON DELETE SET NULL,

  -- Diff workflow — when a NEW study lands, the OLD one stays in this table
  -- with is_active = false. The active study is the one we benchmark against.
  is_active                         BOOLEAN NOT NULL DEFAULT TRUE,
  replaced_at                       TIMESTAMPTZ,
  replaced_by_id                    UUID REFERENCES reserve_study_versions(id) ON DELETE SET NULL,

  notes                             TEXT,
  imported_by                       TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserve_study_versions_community
  ON reserve_study_versions(community_id, is_active, inspection_date DESC);

DROP TRIGGER IF EXISTS trg_reserve_study_versions_updated_at ON reserve_study_versions;
CREATE TRIGGER trg_reserve_study_versions_updated_at
  BEFORE UPDATE ON reserve_study_versions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Ensure only one active study per community
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reserve_study_active_per_community
  ON reserve_study_versions(community_id) WHERE is_active = TRUE;

COMMENT ON TABLE reserve_study_versions IS
  'One row per formal reserve study (typically every 3-5 years). When a new study lands, the prior version is marked is_active=false and replaced_by_id points to the new row. The active study is the baseline for live-vs-projected comparison.';

-- ----------------------------------------------------------------------------
-- 2) reserve_funding_plan — 30 years of projected contributions/balances
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_funding_plan (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  reserve_study_version_id          UUID NOT NULL REFERENCES reserve_study_versions(id) ON DELETE CASCADE,

  fiscal_year                       INTEGER NOT NULL,
  beginning_balance_cents           BIGINT,
  recommended_contribution_cents    BIGINT,
  additional_contribution_cents     BIGINT,
  additional_assessment_cents       BIGINT,
  total_contribution_cents          BIGINT,
  interest_rate                     NUMERIC(7,5),
  interest_earned_cents             BIGINT,
  anticipated_expenditures_cents    BIGINT,
  ending_balance_cents              BIGINT,

  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reserve_study_version_id, fiscal_year)
);

CREATE INDEX IF NOT EXISTS idx_reserve_funding_plan_community_year
  ON reserve_funding_plan(community_id, fiscal_year);

COMMENT ON TABLE reserve_funding_plan IS
  'Projected fiscal-year reserve fund trajectory from the active reserve study. Compared against actuals (assessments collected + interest earned + reserve_expenditures) to show variance from study projection.';

-- ----------------------------------------------------------------------------
-- 3) Add reserve_study_version_id to reserve_components
-- ----------------------------------------------------------------------------
ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS reserve_study_version_id UUID
    REFERENCES reserve_study_versions(id) ON DELETE SET NULL;

ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS line_item_number TEXT;  -- "4.120" — Reserve Advisors line item

ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS quantity_total NUMERIC(12,2);

ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS quantity_per_phase NUMERIC(12,2);

ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS quantity_units TEXT;  -- "Square Feet", "Linear Feet"

ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS partial_quantity_pct NUMERIC(5,3); -- 0.30 = 30% replaced each phase

ALTER TABLE reserve_components
  ADD COLUMN IF NOT EXISTS unit_cost_cents BIGINT;

CREATE INDEX IF NOT EXISTS idx_reserve_components_study
  ON reserve_components(reserve_study_version_id);

CREATE INDEX IF NOT EXISTS idx_reserve_components_line_item
  ON reserve_components(community_id, line_item_number)
  WHERE line_item_number IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4) View — live-vs-projected funding plan
-- ----------------------------------------------------------------------------
-- For each year in the funding plan, compute the actuals (sum of expenditures
-- for that fiscal year from reserve_expenditures) and the variance vs. study
-- projection. This is what the "Reserve Health" panel on the board map uses.
CREATE OR REPLACE VIEW v_reserve_funding_actuals AS
SELECT
  fp.id,
  fp.community_id,
  fp.reserve_study_version_id,
  fp.fiscal_year,
  fp.beginning_balance_cents,
  fp.total_contribution_cents      AS projected_contribution_cents,
  fp.interest_earned_cents         AS projected_interest_cents,
  fp.anticipated_expenditures_cents AS projected_expenditures_cents,
  fp.ending_balance_cents           AS projected_ending_balance_cents,
  COALESCE((
    SELECT SUM(amount_cents)
    FROM reserve_expenditures e
    WHERE e.community_id = fp.community_id
      AND EXTRACT(YEAR FROM e.expenditure_date)::INT = fp.fiscal_year
  ), 0)                              AS actual_expenditures_cents,
  -- Variance: positive = under budget (good), negative = over budget
  fp.anticipated_expenditures_cents - COALESCE((
    SELECT SUM(amount_cents)
    FROM reserve_expenditures e
    WHERE e.community_id = fp.community_id
      AND EXTRACT(YEAR FROM e.expenditure_date)::INT = fp.fiscal_year
  ), 0)                              AS variance_cents
FROM reserve_funding_plan fp;

COMMENT ON VIEW v_reserve_funding_actuals IS
  'Per-fiscal-year projected vs actual reserve spend. Positive variance = under budget vs the study. Drives the live-vs-projected gauge on the board reserve map.';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON reserve_study_versions, reserve_funding_plan
  TO anon, authenticated, service_role;
GRANT SELECT ON v_reserve_funding_actuals TO service_role, authenticated;

COMMIT;
