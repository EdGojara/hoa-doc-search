-- ============================================================================
-- 123_appraisal_yoy_change.sql
-- ----------------------------------------------------------------------------
-- Adds year-over-year value-change computation to v_appraisal_property_summary.
-- The underlying assessed_value_current + assessed_value_prior columns are
-- already on appraisal_records (since migration 122); this just exposes the
-- delta + percent change in the view so the Community Map can color by it
-- and the side panel can display it.
--
-- Why this layer matters operationally:
--   HOAs claim to "preserve / increase property values" as a core benefit.
--   This is the layer that quantifies whether that's actually happening
--   per community + per neighborhood pocket. Pairs naturally with the
--   DRV + Investor layers — if the high-violation cluster ALSO has the
--   slowest appreciation, that's a directly actionable signal for the
--   board (consistent-enforcement thesis surfacing in the data).
--
-- Apply AFTER 122. Idempotent (DROP VIEW IF EXISTS + CREATE pattern).
-- ============================================================================

BEGIN;

-- DROP + CREATE pattern (per the CREATE OR REPLACE VIEW scar — adding
-- columns to an existing view doesn't work via REPLACE). Re-issue GRANTs
-- at the end (per the migration 100 scar where DROP loses grants).
DROP VIEW IF EXISTS v_appraisal_property_summary CASCADE;

CREATE VIEW v_appraisal_property_summary AS
SELECT
  p.id                                       AS property_id,
  p.community_id,
  p.street_address,
  p.unit,
  p.city,
  p.state,
  p.zip,
  LOWER(TRIM(p.street_address)) AS _prop_addr_normalized,
  ap.county_source,
  ap.parcel_number,
  ap.owner_name_appraisal,
  ap.owner_mailing_address,
  ap.acquisition_date,
  ap.sale_price,
  ap.prior_sale_date,
  ap.prior_sale_price,
  ap.assessed_value_current,
  ap.assessed_value_prior,
  ap.land_value,
  ap.improvement_value,
  ap.year_built,
  ap.building_sqft,
  ap.lot_sqft,
  ap.pull_date,
  ap.days_since_pull,
  ap.tenure_years,
  CASE
    WHEN ap.tenure_years IS NULL THEN NULL
    WHEN ap.tenure_years < 1   THEN 'new'
    WHEN ap.tenure_years < 4   THEN 'short'
    WHEN ap.tenure_years < 8   THEN 'medium'
    WHEN ap.tenure_years < 15  THEN 'long'
    ELSE 'very_long'
  END AS tenure_bucket,
  CASE
    WHEN ap.owner_mailing_address IS NULL THEN NULL
    WHEN POSITION(LOWER(TRIM(p.street_address)) IN LOWER(ap.owner_mailing_address)) > 0 THEN FALSE
    ELSE TRUE
  END AS investor_flag,
  CASE
    WHEN ap.acquisition_date IS NULL THEN NULL
    WHEN ap.acquisition_date >= CURRENT_DATE - INTERVAL '365 days' THEN TRUE
    ELSE FALSE
  END AS recently_sold,
  ap.assessed_value_current AS value_for_bucket,

  -- YoY value change. NULL when either side is missing or the prior value
  -- is zero (avoid divide-by-zero and the meaningless 'infinity' bucket
  -- when a property comes off-roll then back-on at full value).
  CASE
    WHEN ap.assessed_value_current IS NULL OR ap.assessed_value_prior IS NULL THEN NULL
    WHEN ap.assessed_value_prior <= 0 THEN NULL
    ELSE ROUND(
      (((ap.assessed_value_current - ap.assessed_value_prior) / ap.assessed_value_prior) * 100)::numeric,
      2
    )
  END AS yoy_change_pct,

  -- Absolute dollar change — useful for the side panel even when % is misleading
  -- (e.g., low-value property with $5k increase looks huge as a %; the dollar
  -- amount tells the truer story for board conversations).
  CASE
    WHEN ap.assessed_value_current IS NULL OR ap.assessed_value_prior IS NULL THEN NULL
    ELSE ap.assessed_value_current - ap.assessed_value_prior
  END AS yoy_change_dollars
FROM properties p
LEFT JOIN v_latest_appraisal_per_property ap ON ap.property_id = p.id;

-- Re-issue grants that the DROP removed (per the migration 100 scar)
GRANT SELECT ON v_appraisal_property_summary TO service_role, authenticated;

COMMENT ON VIEW v_appraisal_property_summary IS
  'One row per property with latest appraisal data + computed tenure_bucket + investor_flag + recently_sold + yoy_change_pct + yoy_change_dollars. Powers the Community Map appraisal layers (incl. the YoY value-change layer added in migration 123).';

COMMIT;
