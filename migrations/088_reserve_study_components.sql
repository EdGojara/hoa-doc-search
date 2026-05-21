-- ============================================================================
-- 088_reserve_study_components.sql
-- ----------------------------------------------------------------------------
-- Reserve study components + expenditures. Powers the board-facing reserve
-- map (see project_reserve_study_map.md): pins per reserve item across the
-- community with click-through to remaining useful life, projected replacement
-- cost, condition, and recent spending.
--
-- Apply after 087. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) reserve_components — one row per reserve study line item per community
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_components (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,

  -- Identity
  component_name                    TEXT NOT NULL,            -- "Pool plaster", "Parking lot asphalt", etc.
  category                          TEXT NOT NULL
    CHECK (category IN (
      'pool', 'roof', 'paving', 'fence', 'mechanical',
      'landscape', 'common_area', 'playground', 'signage',
      'lighting', 'irrigation', 'mailroom', 'other'
    )),
  description                       TEXT,
  amenity_id                        UUID REFERENCES amenities(id) ON DELETE SET NULL,

  -- Specs from reserve study
  installed_or_built_year           INTEGER,
  useful_life_years                 INTEGER,
  remaining_useful_life_years       INTEGER,

  -- Cost estimates
  current_cost_estimate_cents       BIGINT,
  future_cost_estimate_cents        BIGINT,
  inflation_factor                  NUMERIC(5,3),             -- e.g., 1.034 = 3.4% per year
  next_scheduled_replacement_year   INTEGER,

  -- Status
  condition                         TEXT
    CHECK (condition IS NULL OR condition IN
      ('excellent', 'good', 'fair', 'poor', 'failing', 'unknown')),
  last_inspection_date              DATE,
  status                            TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'replaced', 'removed', 'on_hold')),

  -- Map placement
  lat                               NUMERIC(10, 7),
  lng                               NUMERIC(10, 7),
  pin_label_override                TEXT,                     -- short label for map pin if needed

  -- Provenance
  source_document_id                UUID REFERENCES library_documents(id) ON DELETE SET NULL,
  source_section                    TEXT,                     -- e.g., "Section 4.2 Pool Equipment"
  notes                             TEXT,
  photo_storage_path                TEXT,

  display_order                     INTEGER NOT NULL DEFAULT 100,

  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserve_components_community
  ON reserve_components(community_id, status, display_order);
CREATE INDEX IF NOT EXISTS idx_reserve_components_category
  ON reserve_components(community_id, category, status);
CREATE INDEX IF NOT EXISTS idx_reserve_components_replacement_year
  ON reserve_components(community_id, next_scheduled_replacement_year)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_reserve_components_updated_at ON reserve_components;
CREATE TRIGGER trg_reserve_components_updated_at
  BEFORE UPDATE ON reserve_components
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE reserve_components IS
  'Per-community reserve study components (pool, roof, asphalt, fences, etc.). One row per asset with useful life, replacement cost estimates, condition, and optional map pin. Powers the board-facing reserve map.';

-- ----------------------------------------------------------------------------
-- 2) reserve_expenditures — actual spending tracked against each component
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_expenditures (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id                      UUID NOT NULL REFERENCES reserve_components(id) ON DELETE RESTRICT,
  community_id                      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,

  amount_cents                      BIGINT NOT NULL,
  expenditure_date                  DATE NOT NULL,
  type                              TEXT NOT NULL
    CHECK (type IN ('maintenance', 'repair', 'partial_replacement',
                    'full_replacement', 'inspection', 'consulting', 'other')),
  description                       TEXT,
  vendor_name                       TEXT,
  invoice_number                    TEXT,
  invoice_doc_id                    UUID REFERENCES library_documents(id) ON DELETE SET NULL,

  funded_from                       TEXT
    CHECK (funded_from IS NULL OR funded_from IN
      ('operating', 'reserves', 'special_assessment', 'insurance', 'other')),

  notes                             TEXT,
  recorded_by                       TEXT,

  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserve_expenditures_component
  ON reserve_expenditures(component_id, expenditure_date DESC);
CREATE INDEX IF NOT EXISTS idx_reserve_expenditures_community_recent
  ON reserve_expenditures(community_id, expenditure_date DESC);

DROP TRIGGER IF EXISTS trg_reserve_expenditures_updated_at ON reserve_expenditures;
CREATE TRIGGER trg_reserve_expenditures_updated_at
  BEFORE UPDATE ON reserve_expenditures
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE reserve_expenditures IS
  'Actual spending tracked against reserve components. Each invoice/expense links to a component. Boards see lifetime spending per component + recent activity in the reserve map detail panel.';

-- ----------------------------------------------------------------------------
-- 3) View — components with lifetime totals + computed status flags
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_reserve_components_with_totals AS
SELECT
  rc.*,
  COALESCE(spend.lifetime_spent_cents, 0)                  AS lifetime_spent_cents,
  COALESCE(spend.spending_count, 0)                        AS expenditure_count,
  spend.last_expenditure_date                              AS last_expenditure_date,
  spend.last_vendor                                        AS last_vendor,
  -- Derived urgency for map coloring
  CASE
    WHEN rc.condition = 'failing' OR rc.remaining_useful_life_years IS NOT NULL AND rc.remaining_useful_life_years <= 1 THEN 'critical'
    WHEN rc.remaining_useful_life_years IS NOT NULL AND rc.remaining_useful_life_years <= 2 THEN 'imminent'
    WHEN rc.remaining_useful_life_years IS NOT NULL AND rc.remaining_useful_life_years <= 5 THEN 'soon'
    WHEN rc.remaining_useful_life_years IS NOT NULL AND rc.remaining_useful_life_years <= 10 THEN 'medium'
    ELSE 'far'
  END                                                       AS urgency_band,
  -- Years until replacement (NULL if no date or replacement year set)
  CASE
    WHEN rc.next_scheduled_replacement_year IS NOT NULL THEN rc.next_scheduled_replacement_year - EXTRACT(YEAR FROM NOW())::INT
    WHEN rc.remaining_useful_life_years IS NOT NULL THEN rc.remaining_useful_life_years
    ELSE NULL
  END                                                       AS years_until_replacement,
  a.name                                                    AS linked_amenity_name,
  a.amenity_type                                            AS linked_amenity_type
FROM reserve_components rc
LEFT JOIN amenities a ON a.id = rc.amenity_id
LEFT JOIN (
  SELECT
    component_id,
    SUM(amount_cents)                       AS lifetime_spent_cents,
    COUNT(*)                                AS spending_count,
    MAX(expenditure_date)                   AS last_expenditure_date,
    (
      SELECT vendor_name FROM reserve_expenditures e2
      WHERE e2.component_id = e.component_id
      ORDER BY expenditure_date DESC NULLS LAST LIMIT 1
    )                                       AS last_vendor
  FROM reserve_expenditures e
  GROUP BY component_id
) spend ON spend.component_id = rc.id;

-- ----------------------------------------------------------------------------
-- 4) View — per-community reserve exposure summary (for board dashboard)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_reserve_community_summary AS
SELECT
  rc.community_id,
  c.name                                                  AS community_name,
  COUNT(*) FILTER (WHERE rc.status = 'active')            AS active_components,
  SUM(rc.current_cost_estimate_cents) FILTER (WHERE rc.status = 'active')  AS total_current_cost_cents,
  SUM(rc.future_cost_estimate_cents)  FILTER (WHERE rc.status = 'active')  AS total_future_cost_cents,
  COUNT(*) FILTER (WHERE rc.status = 'active' AND rc.remaining_useful_life_years <= 2)  AS critical_2yr_count,
  COUNT(*) FILTER (WHERE rc.status = 'active' AND rc.remaining_useful_life_years <= 5)  AS soon_5yr_count,
  COALESCE((SELECT SUM(amount_cents) FROM reserve_expenditures e
            WHERE e.community_id = rc.community_id
              AND e.expenditure_date >= CURRENT_DATE - INTERVAL '12 months'), 0)
                                                          AS spent_last_12mo_cents
FROM reserve_components rc
JOIN communities c ON c.id = rc.community_id
GROUP BY rc.community_id, c.name;

GRANT SELECT, INSERT, UPDATE, DELETE ON reserve_components, reserve_expenditures
  TO anon, authenticated, service_role;
GRANT SELECT ON v_reserve_components_with_totals, v_reserve_community_summary
  TO service_role, authenticated;

COMMIT;
