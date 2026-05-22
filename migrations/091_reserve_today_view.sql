-- ============================================================================
-- 091_reserve_today_view.sql
-- ----------------------------------------------------------------------------
-- Make reserve component values "tick forward" each year automatically.
-- The study baseline (2024 study said: 6yr RUL, $27,820 today's cost) is
-- preserved in reserve_components as the audit trail. The view computes the
-- current "as of today" values by:
--   - decrementing remaining_useful_life_years by years elapsed since the
--     study's fiscal_year
--   - inflating current_cost_estimate_cents forward by inflation_factor for
--     the same elapsed years
--   - re-deriving urgency_band from the current (not baseline) RUL
--
-- Apply after 089. Idempotent.
-- ============================================================================

BEGIN;

-- DROP + CREATE rather than REPLACE — rc.* expanded since the view was first
-- defined in 088 (migration 089 added columns to reserve_components), and
-- CREATE OR REPLACE VIEW rejects that as a column rename. CASCADE is safe —
-- no other views depend on this one (v_reserve_community_summary reads
-- reserve_components directly).
DROP VIEW IF EXISTS v_reserve_components_with_totals CASCADE;

CREATE VIEW v_reserve_components_with_totals AS
WITH study_year AS (
  SELECT
    rc.id AS component_id,
    -- Years elapsed since the study baseline. If no study link, treat as 0
    -- (no automatic ticking). Negative result (study fiscal year is in the
    -- future, unlikely) is clamped to 0.
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

  -- Audit trail
  sy.baseline_fiscal_year                                  AS baseline_fiscal_year,
  sy.years_elapsed                                         AS years_elapsed_since_baseline,

  -- "As of today" values — tick forward automatically each year
  CASE
    WHEN rc.remaining_useful_life_years IS NULL THEN NULL
    ELSE GREATEST(0, rc.remaining_useful_life_years - sy.years_elapsed)
  END                                                       AS current_remaining_useful_life_years,

  -- Inflated forward by inflation_factor^years_elapsed. inflation_factor is
  -- stored as 1.033 (= 1 + rate), so this directly compounds.
  CASE
    WHEN rc.current_cost_estimate_cents IS NULL THEN NULL
    WHEN rc.inflation_factor IS NULL OR sy.years_elapsed = 0 THEN rc.current_cost_estimate_cents
    ELSE ROUND(rc.current_cost_estimate_cents * POWER(rc.inflation_factor, sy.years_elapsed))::BIGINT
  END                                                       AS current_cost_today_cents,

  -- Urgency band re-derived from CURRENT remaining life (not stored baseline).
  -- "failing" condition still trumps everything.
  CASE
    WHEN rc.condition = 'failing'                           THEN 'critical'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 1 THEN 'critical'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 2 THEN 'imminent'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 5 THEN 'soon'
    WHEN GREATEST(0, COALESCE(rc.remaining_useful_life_years - sy.years_elapsed, 999)) <= 10 THEN 'medium'
    ELSE 'far'
  END                                                       AS urgency_band,

  -- Years until replacement = next_scheduled_replacement_year - current year
  -- (this was already dynamic — kept for compatibility)
  CASE
    WHEN rc.next_scheduled_replacement_year IS NOT NULL
      THEN rc.next_scheduled_replacement_year - EXTRACT(YEAR FROM NOW())::INT
    WHEN rc.remaining_useful_life_years IS NOT NULL
      THEN GREATEST(0, rc.remaining_useful_life_years - sy.years_elapsed)
    ELSE NULL
  END                                                       AS years_until_replacement,

  a.name                                                    AS linked_amenity_name,
  a.amenity_type                                            AS linked_amenity_type
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

COMMENT ON VIEW v_reserve_components_with_totals IS
  'Reserve components with lifetime spending totals + "as of today" computed values. The reserve_components table stores study-baseline values (immutable audit trail); this view ticks RUL and cost forward by years elapsed since the active study''s fiscal_year + inflation_factor. Urgency band recomputes from current RUL so colors stay accurate as time passes.';

COMMIT;
