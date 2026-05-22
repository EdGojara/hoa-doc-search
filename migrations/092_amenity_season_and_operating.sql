-- ============================================================================
-- 092_amenity_season_and_operating.sql
-- ----------------------------------------------------------------------------
-- Two related additions to amenities:
--
-- 1) Date-precise season + offseason status (replacing month-only fields)
--    The existing seasonal_open_month / seasonal_close_month columns stay
--    for backward compat but should be considered deprecated.
--
-- 2) Operating-contract metadata (vendor, annual + monthly schedule,
--    contract dates, source document). This lives on the amenity, not on
--    reserve components — keeps the reserve / operating fund separation
--    clean in the data model. The reserve map surfaces this via a single
--    "linked to" line in the component detail panel when an amenity is
--    linked + has operating data populated.
--
-- Apply after 091. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Season + offseason hours
-- ----------------------------------------------------------------------------
ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS season_rule TEXT
    CHECK (season_rule IS NULL OR season_rule IN ('fixed', 'memorial_to_labor', 'year_round'));

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS season_open_md TEXT;    -- "MM-DD" e.g. "04-15"

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS season_close_md TEXT;   -- "MM-DD"

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS offseason_status TEXT
    CHECK (offseason_status IS NULL OR offseason_status IN ('closed', 'limited', 'open'));

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS offseason_hours_text TEXT;

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS offseason_hours_structured JSONB;

-- Sanity: MM-DD format validation
ALTER TABLE amenities DROP CONSTRAINT IF EXISTS chk_amenities_season_open_md;
ALTER TABLE amenities ADD CONSTRAINT chk_amenities_season_open_md
  CHECK (season_open_md IS NULL OR season_open_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');
ALTER TABLE amenities DROP CONSTRAINT IF EXISTS chk_amenities_season_close_md;
ALTER TABLE amenities ADD CONSTRAINT chk_amenities_season_close_md
  CHECK (season_close_md IS NULL OR season_close_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');

COMMENT ON COLUMN amenities.season_rule IS
  '''fixed'' = use season_open_md + season_close_md as MM-DD strings. ''memorial_to_labor'' = compute Memorial Day weekend to Labor Day weekend for current year (in app). ''year_round'' = no season, always open.';
COMMENT ON COLUMN amenities.offseason_status IS
  '''closed'' = no access offseason (most pools). ''limited'' = reduced hours offseason. ''open'' = full hours year-round.';

-- ----------------------------------------------------------------------------
-- 2) Operating contract (vendor management agreement)
-- ----------------------------------------------------------------------------
ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_vendor_name TEXT;

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_annual_cost_cents BIGINT;

-- Monthly cost schedule for vendors who bill differently in-season vs offseason
-- (e.g., Swim Houston bills monthly maintenance + lifeguard line items only in
-- swim-season months). Format: [{ "month": 1-12, "amount_cents": N, "notes": "" }]
ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_monthly_schedule JSONB;

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_contract_start_date DATE;

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_contract_end_date DATE;

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_contract_doc_id UUID
    REFERENCES library_documents(id) ON DELETE SET NULL;

ALTER TABLE amenities
  ADD COLUMN IF NOT EXISTS management_contract_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_amenities_contract_end
  ON amenities(management_contract_end_date)
  WHERE management_contract_end_date IS NOT NULL;

COMMENT ON COLUMN amenities.management_annual_cost_cents IS
  'Total annual cost of the operating contract for this amenity. Operating expense (NOT a reserve item). Surfaces as a one-line context on the reserve map when an amenity has both a vendor name + this cost set, and as a primary card on the homeowner portal map.';

COMMIT;
