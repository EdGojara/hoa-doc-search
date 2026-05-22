-- ============================================================================
-- 100_reserve_view_amenity_coords.sql
-- ----------------------------------------------------------------------------
-- Expose the linked amenity's lat/lng on v_reserve_components_with_totals so
-- the reserve map can render linked components at the amenity's location
-- automatically — without having to copy coords onto each component.
--
-- This is the integration-depth pattern: the amenity is the canonical
-- location; components downstream of it inherit. Pin the Pool amenity once,
-- every Pool reserve component appears there.
--
-- Apply after 093. Idempotent (DROP CASCADE + CREATE).
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS v_reserve_components_with_totals CASCADE;

CREATE VIEW v_reserve_components_with_totals AS
WITH study_year AS (
  SELECT
    rc.id AS component_id,
    GREATEST(0,
      EXTRACT(YEAR FROM NOW())::INT - COALESCE(rsv.fiscal_year, EXTRACT(YEAR FROM NOW())::INT)
    ) AS years_elapsed,
    COALESCE(rsv.fiscal_year, NULL) AS baseline_fiscal_year
  FROM reserve_components rc
  LEFT JOIN reserve_study_versions rsv ON rsv.id = rc.reserve_study_version_id
)
SELECT
  rc.*,
  COALESCE(spend.lifetime_spent_cents, 0)                  AS lifetime_spent_cents,
  COALESCE(spend.spending_count, 0)                        AS expenditure_count,
  spend.last_expenditure_date                              AS last_expenditure_date,
  spend.last_vendor                                        AS last_vendor,

  sy.baseline_fiscal_year                                  AS baseline_fiscal_year,
  sy.years_elapsed                                         AS years_elapsed_since_baseline,

  CASE
    WHEN rc.remaining_useful_life_years IS NULL THEN NULL
    ELSE GREATEST(0, rc.remaining_useful_life_years - sy.years_elapsed)
  END                                                       AS current_remaining_useful_life_years,

  CASE
    WHEN rc.current_cost_estimate_cents IS NULL THEN NULL
    WHEN rc.inflation_factor IS NULL OR sy.years_elapsed = 0 THEN rc.current_cost_estimate_cents
    ELSE ROUND(rc.current_cost_estimate_cents * POWER(rc.inflation_factor, sy.years_elapsed))::BIGINT
  END                                                       AS current_cost_today_cents,

  CASE
    WHEN rc.condition = 'failing'                           THEN 'critical'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 1 THEN 'critical'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 2 THEN 'imminent'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 5 THEN 'soon'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 10 THEN 'medium'
    ELSE 'far'
  END                                                       AS urgency_band,

  CASE
    WHEN rc.next_scheduled_replacement_year IS NOT NULL
      THEN rc.next_scheduled_replacement_year - EXTRACT(YEAR FROM NOW())::INT
    WHEN rc.remaining_useful_life_years IS NOT NULL
      THEN GREATEST(0, rc.remaining_useful_life_years - sy.years_elapsed)
    ELSE NULL
  END                                                       AS years_until_replacement,

  a.name                                                    AS linked_amenity_name,
  a.amenity_type                                            AS linked_amenity_type,
  a.management_vendor_name                                  AS linked_amenity_vendor,
  a.management_annual_cost_cents                            AS linked_amenity_annual_cost_cents,
  a.management_contract_end_date                            AS linked_amenity_contract_end,
  -- NEW: amenity coords for "linked component inherits amenity location"
  a.lat                                                     AS linked_amenity_lat,
  a.lng                                                     AS linked_amenity_lng
FROM reserve_components rc
LEFT JOIN study_year sy ON sy.component_id = rc.id
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

COMMIT;
