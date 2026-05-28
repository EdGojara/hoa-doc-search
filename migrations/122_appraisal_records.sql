-- ============================================================================
-- 122_appraisal_records.sql
-- ----------------------------------------------------------------------------
-- County appraisal data (FBCAD, HCAD, and any future Texas appraisal district)
-- linked to the property spine. Texas appraisal records are public under TX
-- Gov Code Ch. 552 — these are bulk-roll imports we cross-reference against
-- Vantaca to catch missed deed transfers, surface true acquisition dates,
-- and power new map layers (tenure, investor flag, assessed-value buckets).
--
-- Why this matters operationally:
--   - Vantaca occasionally has wrong ownership data (typos at import, missed
--     deed transfers). The county is THE legal record. Cross-checking here
--     means the board can always find the right owner.
--   - Acquisition date enables tenure-on-map and "how long has Sarah lived
--     here?" answers boards genuinely want.
--   - Owner mailing address (when different from property address) is the
--     cleanest investor/rental signal — better than our current heuristic.
--   - Assessed values feed future capital-planning conversations.
--
-- Single-source-of-truth discipline:
--   The county is canonical for legal ownership of record. Vantaca is
--   canonical for the assessment-payer-of-record relationship. They're
--   USUALLY the same person but not always. Every UI surfacing appraisal
--   data must label it 'per [county] as of [date]'. Don't conflate.
--
-- Record ownership (per CLAUDE.md): `association_record`. The actual county
-- data is public record. The fact that we've assembled, cross-referenced,
-- and tied it to the property spine is for the HOA's benefit, transfers
-- with the association on termination. (Our match heuristics + AI mapping
-- of column headers stays workpaper.)
--
-- Schema design:
--   - appraisal_records: time-series of imports (one row per property per
--     pull_date). Multiple snapshots over time = trend.
--   - appraisal_ingest_batches: upload tracking, preview/approve pattern
--     matching the owner_ar_snapshots ingest workflow.
--   - v_latest_appraisal_per_property: latest approved row per property.
--   - v_appraisal_property_summary: joins property + latest appraisal +
--     computed flags (tenure_years, owner_at_different_address).
--
-- Apply AFTER 121. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) appraisal_records — one row per (property, pull_date)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appraisal_records (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id     UUID NOT NULL REFERENCES management_companies(id),
  community_id              UUID NOT NULL REFERENCES communities(id),  -- denorm for fast filters
  property_id               UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,

  -- County source
  county_source             TEXT NOT NULL
                              CHECK (county_source IN ('FBCAD', 'HCAD', 'OTHER')),
  parcel_number             TEXT,                  -- county's official parcel/property ID

  -- Ownership per county records (MAY differ from Vantaca!)
  owner_name_appraisal      TEXT,
  owner_mailing_address     TEXT,                  -- powers investor/rental flag

  -- Acquisition / sale
  acquisition_date          DATE,                  -- deed-record date for current owner
  sale_price                NUMERIC(12, 2),
  prior_sale_date           DATE,                  -- last sale before current (if county provides)
  prior_sale_price          NUMERIC(12, 2),

  -- Assessed values (most counties supply current + 1-2 prior years)
  assessed_value_current    NUMERIC(12, 2),
  assessed_value_prior      NUMERIC(12, 2),
  land_value                NUMERIC(12, 2),
  improvement_value         NUMERIC(12, 2),

  -- Property characteristics from county records
  year_built                INTEGER,
  building_sqft             INTEGER,
  lot_sqft                  INTEGER,

  -- Pull metadata. pull_date is the "as-of" claimed by the county roll
  -- (e.g., FBCAD 2026 certified roll = '2026-01-01'). Multiple snapshots
  -- per property allowed (one per year is typical; quarterly mid-year if
  -- the county publishes updates).
  pull_date                 DATE NOT NULL,
  source_filename           TEXT,
  source_storage_path       TEXT,
  ingest_batch_id           UUID,
  raw_extraction            JSONB,                 -- full per-row data we extracted

  -- Audit
  approved_at               TIMESTAMPTZ,
  approved_by_user_id       UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  notes                     TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One snapshot per property per pull_date. Re-running an approve after
  -- a fix updates the existing row instead of duplicating.
  UNIQUE (property_id, pull_date)
);

CREATE INDEX IF NOT EXISTS idx_appraisal_property_date
  ON appraisal_records (property_id, pull_date DESC);
CREATE INDEX IF NOT EXISTS idx_appraisal_community_date
  ON appraisal_records (community_id, pull_date DESC);
CREATE INDEX IF NOT EXISTS idx_appraisal_parcel
  ON appraisal_records (parcel_number)
  WHERE parcel_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appraisal_pending
  ON appraisal_records (community_id, created_at DESC)
  WHERE approved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appraisal_county
  ON appraisal_records (county_source, pull_date DESC);

DROP TRIGGER IF EXISTS trg_appraisal_records_updated_at ON appraisal_records;
CREATE TRIGGER trg_appraisal_records_updated_at
  BEFORE UPDATE ON appraisal_records
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE appraisal_records IS
  'Time-series of county appraisal data (FBCAD/HCAD) per property. Multiple snapshots per property allowed (one per pull_date). v_latest_appraisal_per_property exposes the most recent.';

-- ----------------------------------------------------------------------------
-- 2) appraisal_ingest_batches — one row per upload, for preview/approve flow
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appraisal_ingest_batches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id     UUID NOT NULL REFERENCES management_companies(id),
  community_id              UUID REFERENCES communities(id),  -- NULL for multi-community uploads
  county_source             TEXT NOT NULL
                              CHECK (county_source IN ('FBCAD', 'HCAD', 'OTHER')),
  uploaded_by_user_id       UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  uploaded_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_filename           TEXT,
  source_storage_path       TEXT,
  pull_date                 DATE,                  -- as-of date claimed by the roll
  total_rows                INTEGER NOT NULL DEFAULT 0,
  rows_matched_property     INTEGER NOT NULL DEFAULT 0,
  rows_unmatched            INTEGER NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'previewed'
                              CHECK (status IN ('previewed', 'approved', 'discarded')),
  approved_at               TIMESTAMPTZ,
  approved_by_user_id       UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  raw_extraction            JSONB,                 -- the full extracted preview
  column_mapping            JSONB,                 -- detected CSV column → field mapping
  extraction_model          TEXT,
  notes                     TEXT
);

CREATE INDEX IF NOT EXISTS idx_appraisal_batches_community
  ON appraisal_ingest_batches (community_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_appraisal_batches_status
  ON appraisal_ingest_batches (status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_appraisal_batches_county
  ON appraisal_ingest_batches (county_source, uploaded_at DESC);

-- ----------------------------------------------------------------------------
-- 3) v_latest_appraisal_per_property — latest approved snapshot per property
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_latest_appraisal_per_property CASCADE;
CREATE VIEW v_latest_appraisal_per_property AS
SELECT DISTINCT ON (property_id)
  property_id,
  community_id,
  county_source,
  parcel_number,
  owner_name_appraisal,
  owner_mailing_address,
  acquisition_date,
  sale_price,
  prior_sale_date,
  prior_sale_price,
  assessed_value_current,
  assessed_value_prior,
  land_value,
  improvement_value,
  year_built,
  building_sqft,
  lot_sqft,
  pull_date,
  CURRENT_DATE - pull_date AS days_since_pull,
  -- Tenure in fractional years. NULL when no acquisition_date.
  CASE WHEN acquisition_date IS NOT NULL
       THEN ROUND(((CURRENT_DATE - acquisition_date)::numeric / 365.25)::numeric, 2)
       ELSE NULL
  END AS tenure_years
FROM appraisal_records
WHERE approved_at IS NOT NULL
ORDER BY property_id, pull_date DESC;

GRANT SELECT ON v_latest_appraisal_per_property TO service_role, authenticated;

COMMENT ON VIEW v_latest_appraisal_per_property IS
  'One row per property, latest approved appraisal snapshot. tenure_years computed at query time. days_since_pull lets UI flag stale county data (default warning at >180 days = older than a typical annual roll cycle).';

-- ----------------------------------------------------------------------------
-- 4) v_appraisal_property_summary — joins property + latest appraisal +
-- computed flags. Powers the Community Map's new layers.
-- ----------------------------------------------------------------------------
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
  -- Build a comparable property address string for the investor-flag check.
  -- Lowercase + trim because county records often have ALL-CAPS owner addresses
  -- like '11602 CANYON GATE BLVD' while property records are '11602 Canyon Gate Blvd'.
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
  -- Tenure bucket for map coloring
  CASE
    WHEN ap.tenure_years IS NULL THEN NULL
    WHEN ap.tenure_years < 1   THEN 'new'           -- < 1 year
    WHEN ap.tenure_years < 4   THEN 'short'         -- 1-3 years
    WHEN ap.tenure_years < 8   THEN 'medium'        -- 4-7 years
    WHEN ap.tenure_years < 15  THEN 'long'          -- 8-14 years
    ELSE 'very_long'                                -- 15+ years
  END AS tenure_bucket,
  -- Investor flag — owner mailing address ≠ property address (loose match).
  -- This is the CLEAN version of the heuristic — county records have the
  -- owner's actual statutory mailing address, not what they told Vantaca.
  CASE
    WHEN ap.owner_mailing_address IS NULL THEN NULL
    WHEN POSITION(LOWER(TRIM(p.street_address)) IN LOWER(ap.owner_mailing_address)) > 0 THEN FALSE
    ELSE TRUE
  END AS investor_flag,
  -- Sale-velocity flag: sold within the last 365 days
  CASE
    WHEN ap.acquisition_date IS NULL THEN NULL
    WHEN ap.acquisition_date >= CURRENT_DATE - INTERVAL '365 days' THEN TRUE
    ELSE FALSE
  END AS recently_sold,
  -- Assessed value bucket — relative to community median computed in app code
  -- (here we just expose the raw value; bucketing happens in the API layer
  -- because thresholds vary by community).
  ap.assessed_value_current AS value_for_bucket
FROM properties p
LEFT JOIN v_latest_appraisal_per_property ap ON ap.property_id = p.id;

GRANT SELECT ON v_appraisal_property_summary TO service_role, authenticated;

COMMENT ON VIEW v_appraisal_property_summary IS
  'One row per property with latest appraisal data + computed tenure_bucket + investor_flag + recently_sold. Powers the Community Map appraisal layers. NULL appraisal columns indicate no approved record yet for that property.';

GRANT ALL  ON appraisal_records, appraisal_ingest_batches TO service_role;
GRANT SELECT ON appraisal_records, appraisal_ingest_batches TO authenticated;

COMMIT;
