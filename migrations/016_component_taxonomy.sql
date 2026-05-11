-- ============================================================================
-- 016_component_taxonomy.sql
-- ----------------------------------------------------------------------------
-- Component-level decomposition for vendor proposals. Turns opaque bids into
-- structured data that can be compared apples-to-apples.
--
-- The shenanigan trustEd defeats:
--   Vendor A bids pool management at $48K (basic).
--   Vendor B bids $58K (includes chemicals, lifeguarding, ADA lift).
--   Board sees "$48K vs $58K, go with A!" — and gets crushed by $10K of add-ons
--   that turn out to cost $7K more in the real total.
--
-- With this layer:
--   Each proposal's line items are mapped to a canonical component taxonomy.
--   The comparison view shows component-by-component pricing PLUS flagged
--   omissions ("Vendor A does not include chemicals supply — typically $5K/yr").
--   Markups visible: "Vendor C's pump repair labor is $185/hr vs. category
--   median of $125/hr — 48% markup."
--
-- Strategic positioning: this is what makes Bedrock's vendor analysis the
-- audit-grade product. HOAi/Vantaca don't do this because they're paperwork
-- managers, not analysts. Encoded-Ed in action.
--
-- Apply AFTER 015. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) service_category_components
-- Canonical taxonomy of what components exist for each service category.
-- Drives mapping prompts, comparison columns, benchmark dimensions.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_category_components (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_category         TEXT NOT NULL REFERENCES vendor_service_categories(category),
  component_key            TEXT NOT NULL,                          -- 'lifeguarding','chemicals_supply'
  display_name             TEXT NOT NULL,                          -- 'Lifeguarding'
  description              TEXT,
  typical_inclusion_rate   TEXT CHECK (typical_inclusion_rate IN ('always','usually','sometimes','rarely','varies')),
  typical_unit             TEXT,                                   -- 'annual','monthly','per_visit','per_hour','per_lifeguard_season','per_event'
  is_high_markup_target    BOOLEAN NOT NULL DEFAULT FALSE,         -- true for components vendors commonly mark up
  is_typical_exclusion     BOOLEAN NOT NULL DEFAULT FALSE,         -- true for components vendors commonly EXCLUDE to lowball base price
  benchmark_unit           TEXT,                                   -- the unit used for benchmark comparison (often same as typical_unit)
  notes                    TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  UNIQUE (service_category, component_key)
);

CREATE INDEX IF NOT EXISTS idx_service_components_category
  ON service_category_components(service_category, sort_order);

GRANT SELECT ON service_category_components TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Seed components for the high-shenanigan categories first.
-- Order by sort_order = roughly the order they'd appear in a real proposal.
-- ----------------------------------------------------------------------------

-- POOL MANAGEMENT — classic offender for chemical + lifeguarding add-on games
INSERT INTO service_category_components
  (service_category, component_key, display_name, description, typical_inclusion_rate, typical_unit, is_high_markup_target, is_typical_exclusion, sort_order)
VALUES
  ('pool_management', 'pool_opening',              'Pool Opening',                'One-time setup at start of swim season (de-winterize, fill, prime, chemical balance)', 'usually', 'annual',   FALSE, FALSE, 10),
  ('pool_management', 'pool_closing',              'Pool Closing',                'End-of-season shutdown (drain, winterize, cover)',                                       'usually', 'annual',   FALSE, FALSE, 20),
  ('pool_management', 'weekly_maintenance',        'Weekly Maintenance',          'Recurring visits — skimming, vacuuming, brushing, water testing',                       'always',  'monthly',  FALSE, FALSE, 30),
  ('pool_management', 'chemicals_supply',          'Chemicals (Supply)',          'Chlorine, acid, stabilizer, etc. — the chemicals themselves',                            'varies',  'annual',   FALSE, TRUE,  40),
  ('pool_management', 'chemicals_dosing_labor',    'Chemicals (Dosing Labor)',    'Labor to add chemicals on visits (often bundled with weekly maintenance)',               'usually', 'monthly',  FALSE, FALSE, 50),
  ('pool_management', 'lifeguarding',              'Lifeguarding',                'Staff to monitor pool during open hours — typically Memorial-Labor Day',                 'varies',  'per_lifeguard_season', FALSE, TRUE, 60),
  ('pool_management', 'filter_cleaning',           'Filter Cleaning / Backwash',  'Periodic filter cleaning (cartridge, DE, sand) — often monthly or quarterly',           'usually', 'monthly',  FALSE, FALSE, 70),
  ('pool_management', 'equipment_repair_labor',    'Equipment Repair Labor',      'Hourly labor rate for repairs — NOT included parts',                                     'varies',  'per_hour', TRUE,  FALSE, 80),
  ('pool_management', 'pump_motor_repair',         'Pump / Motor Repair',         'Specific pump/motor service rates',                                                      'rarely',  'per_event', TRUE, TRUE,  90),
  ('pool_management', 'water_testing_compliance',  'Water Testing (Compliance)',  'TX TCEQ / health dept required tests; logs maintained',                                  'always',  'monthly',  FALSE, FALSE, 100),
  ('pool_management', 'ada_lift_maintenance',      'ADA Lift Maintenance',        'Maintenance of ADA-compliant pool lift if installed',                                    'sometimes', 'annual', FALSE, TRUE,  110),
  ('pool_management', 'private_event_staffing',    'Private Event Staffing',      'Lifeguards/attendants for owner-rented private events',                                  'rarely',   'per_event', TRUE, TRUE,  120),
  ('pool_management', 'emergency_response',        'Emergency / After-Hours',     'After-hours emergency call-out rates',                                                   'rarely',   'per_hour', TRUE, TRUE,  130),
  ('pool_management', 'vacuuming_brushing',        'Detail Vacuuming / Brushing', 'Sometimes separate from weekly visits — deeper cleaning passes',                         'usually',  'monthly', FALSE, FALSE, 140),
  ('pool_management', 'furniture_cleaning_setup',  'Pool Deck Furniture',         'Furniture cleaning, setup/teardown, storage',                                            'sometimes', 'annual', FALSE, FALSE, 150),
  ('pool_management', 'pool_school_certification', 'Pool School / Permits',       'Annual permits and certifications (TCEQ, county health)',                                 'usually',  'annual', FALSE, FALSE, 160),
  ('pool_management', 'leak_detection_repair',     'Leak Detection / Repair',     'Diagnostic and repair of pool/equipment leaks',                                          'rarely',   'per_event', TRUE, TRUE,  170)
ON CONFLICT (service_category, component_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_inclusion_rate = EXCLUDED.typical_inclusion_rate,
  typical_unit = EXCLUDED.typical_unit,
  is_high_markup_target = EXCLUDED.is_high_markup_target,
  is_typical_exclusion = EXCLUDED.is_typical_exclusion,
  sort_order = EXCLUDED.sort_order;

-- LANDSCAPE MAINTENANCE — bundled-vs-itemized games
INSERT INTO service_category_components
  (service_category, component_key, display_name, description, typical_inclusion_rate, typical_unit, is_high_markup_target, is_typical_exclusion, sort_order)
VALUES
  ('landscape_maintenance', 'mowing',                  'Mowing',                       'Routine grass cutting — frequency varies by season',                                  'always',  'monthly', FALSE, FALSE, 10),
  ('landscape_maintenance', 'edging_trimming',         'Edging / String Trimming',     'Edging along beds, walks, curbs',                                                     'always',  'monthly', FALSE, FALSE, 20),
  ('landscape_maintenance', 'shrub_pruning',           'Shrub Pruning',                'Routine pruning of shrubs and hedges',                                                'usually', 'monthly', FALSE, FALSE, 30),
  ('landscape_maintenance', 'fertilization',           'Fertilization',                'Turf and shrub fertilization rounds (typically 4-6/year)',                            'usually', 'annual',  FALSE, TRUE,  40),
  ('landscape_maintenance', 'weed_control',            'Weed Control (Post-Emergent)', 'Post-emergent herbicide applications',                                                'usually', 'annual',  FALSE, TRUE,  50),
  ('landscape_maintenance', 'pre_emergent',            'Pre-Emergent Treatment',       'Spring/fall pre-emergent application to prevent weeds',                               'usually', 'annual',  FALSE, TRUE,  60),
  ('landscape_maintenance', 'seasonal_cleanup',        'Seasonal Cleanup',             'Spring/fall cleanup — debris, bed refresh, dormant pruning',                          'usually', 'annual',  FALSE, FALSE, 70),
  ('landscape_maintenance', 'leaf_removal',            'Leaf Removal',                 'Fall leaf cleanup and disposal',                                                      'usually', 'annual',  FALSE, FALSE, 80),
  ('landscape_maintenance', 'mulching',                'Mulching',                     'Refresh mulch in beds — typically 1-2x/year',                                         'usually', 'annual',  TRUE,  TRUE,  90),
  ('landscape_maintenance', 'irrigation_checks',       'Irrigation Routine Checks',    'Visual check + minor adjustments; NOT repairs',                                       'sometimes','monthly',FALSE, FALSE, 100),
  ('landscape_maintenance', 'irrigation_repair_labor', 'Irrigation Repair Labor',      'Hourly labor for irrigation repairs — typically excluded from base',                  'rarely',  'per_hour',TRUE,  TRUE,  110),
  ('landscape_maintenance', 'aeration_overseeding',    'Aeration / Overseeding',       'Annual or as-needed core aeration + overseeding',                                     'sometimes','annual', TRUE,  TRUE,  120),
  ('landscape_maintenance', 'soil_amendment_testing',  'Soil Testing / Amendment',     'Lab soil testing + corrective amendments',                                            'rarely',  'annual',  FALSE, TRUE,  130),
  ('landscape_maintenance', 'pest_control_landscape',  'Landscape Pest Control',       'Targeted pest treatments for ornamentals (NOT termite/general)',                      'sometimes','annual', TRUE,  TRUE,  140),
  ('landscape_maintenance', 'detail_work_beds',        'Bed Detail / Refresh',         'Hand-weeding beds, plant refresh, edging beds',                                       'sometimes','monthly',FALSE, FALSE, 150),
  ('landscape_maintenance', 'holiday_decoration',      'Holiday Decoration',           'Install/removal of seasonal community-area decorations',                              'rarely',  'annual',  TRUE,  TRUE,  160),
  ('landscape_maintenance', 'tree_minor_pruning',      'Tree Pruning (Small <20ft)',   'Minor tree work — typically bundled. Large trees usually separate.',                  'sometimes','annual', FALSE, FALSE, 170),
  ('landscape_maintenance', 'flower_bedding_plants',   'Seasonal Color / Annuals',     'Spring/fall annuals install + maintenance',                                           'sometimes','annual', TRUE,  TRUE,  180)
ON CONFLICT (service_category, component_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_inclusion_rate = EXCLUDED.typical_inclusion_rate,
  typical_unit = EXCLUDED.typical_unit,
  is_high_markup_target = EXCLUDED.is_high_markup_target,
  is_typical_exclusion = EXCLUDED.is_typical_exclusion,
  sort_order = EXCLUDED.sort_order;

-- JANITORIAL / CLEANING — supplies + frequency tier games
INSERT INTO service_category_components
  (service_category, component_key, display_name, description, typical_inclusion_rate, typical_unit, is_high_markup_target, is_typical_exclusion, sort_order)
VALUES
  ('janitorial', 'routine_office_cleaning',  'Routine Office / Lobby Cleaning', 'Recurring vacuuming, dusting, surface cleaning',                            'always',   'monthly',  FALSE, FALSE, 10),
  ('janitorial', 'restroom_cleaning',        'Restroom Cleaning',               'Toilets, sinks, mirrors — frequency per spec',                              'always',   'monthly',  FALSE, FALSE, 20),
  ('janitorial', 'restroom_supplies',        'Restroom Supplies (Paper/Soap)',  'Toilet paper, paper towels, soap restocking — often add-on',                'varies',   'monthly',  TRUE,  TRUE,  30),
  ('janitorial', 'floor_care_vinyl',         'Floor Care (Vinyl / Tile)',       'Strip + wax of hard floors — typically scheduled events',                   'sometimes','annual',   FALSE, TRUE,  40),
  ('janitorial', 'floor_care_carpet',        'Carpet Cleaning',                 'Deep extraction cleaning — typically 1-2x/year',                            'sometimes','annual',   FALSE, TRUE,  50),
  ('janitorial', 'window_cleaning_interior', 'Window Cleaning (Interior)',      'Interior glass cleaning',                                                   'sometimes','annual',   FALSE, FALSE, 60),
  ('janitorial', 'window_cleaning_exterior', 'Window Cleaning (Exterior)',      'Exterior glass — often separate vendor entirely',                           'rarely',   'annual',   TRUE,  TRUE,  70),
  ('janitorial', 'supplies_chemicals',       'Cleaning Supplies / Chemicals',   'Cleaning chemicals consumed during service',                                'varies',   'monthly',  TRUE,  TRUE,  80),
  ('janitorial', 'trash_removal',            'Trash Removal',                   'Liners + disposal during cleaning visits',                                  'usually',  'monthly',  FALSE, FALSE, 90),
  ('janitorial', 'pool_deck_cleaning',       'Pool Deck Cleaning',              'Common during HOA contracts — sometimes bundled with pool vendor',          'rarely',   'monthly',  FALSE, TRUE,  100),
  ('janitorial', 'post_event_cleanup',       'Post-Event Cleanup',              'After clubhouse rentals, board meetings, parties',                          'sometimes','per_event','TRUE',  TRUE,  110),
  ('janitorial', 'pressure_washing_walks',   'Pressure Washing Walkways',       'Sidewalks, entry walks — often separate scope',                              'rarely',   'annual',   TRUE,  TRUE,  120)
ON CONFLICT (service_category, component_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_inclusion_rate = EXCLUDED.typical_inclusion_rate,
  typical_unit = EXCLUDED.typical_unit,
  is_high_markup_target = EXCLUDED.is_high_markup_target,
  is_typical_exclusion = EXCLUDED.is_typical_exclusion,
  sort_order = EXCLUDED.sort_order;

-- SECURITY SERVICES
INSERT INTO service_category_components
  (service_category, component_key, display_name, description, typical_inclusion_rate, typical_unit, is_high_markup_target, is_typical_exclusion, sort_order)
VALUES
  ('security', 'patrol_routine_hours',      'Routine Patrol Hours',           'Scheduled patrol hours per spec (drive-through, walking)',                'always',   'per_hour', FALSE, FALSE, 10),
  ('security', 'access_control_monitoring', 'Access Control Monitoring',      'Gate / clubhouse access monitoring',                                       'usually',  'monthly',  FALSE, FALSE, 20),
  ('security', 'camera_monitoring',         'Camera Monitoring',              'Active monitoring of security cameras',                                    'sometimes','monthly',  FALSE, TRUE,  30),
  ('security', 'incident_response',         'Incident Response',              'On-call response to alarms / incidents',                                   'usually',  'per_event','TRUE',  FALSE, 40),
  ('security', 'event_security_staffing',   'Event Security Staffing',        'Additional guards for special events',                                     'rarely',   'per_event','TRUE',  TRUE,  50),
  ('security', 'after_hours_overtime',      'After-Hours / Overtime Rate',    'OT rate beyond scheduled hours',                                            'usually',  'per_hour','TRUE',   FALSE, 60),
  ('security', 'vehicle_lease',             'Patrol Vehicle Lease',           'If vehicle is itemized separately',                                         'rarely',   'monthly', TRUE,   TRUE,  70),
  ('security', 'uniforms_equipment',        'Uniforms / Equipment',           'Sometimes itemized as a passthrough cost',                                  'rarely',   'annual',  TRUE,   TRUE,  80)
ON CONFLICT (service_category, component_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_inclusion_rate = EXCLUDED.typical_inclusion_rate,
  sort_order = EXCLUDED.sort_order;

-- INSURANCE
INSERT INTO service_category_components
  (service_category, component_key, display_name, description, typical_inclusion_rate, typical_unit, is_high_markup_target, is_typical_exclusion, sort_order)
VALUES
  ('insurance', 'general_liability_premium',   'General Liability Premium',     'Annual GL premium',                                       'always',   'annual', FALSE, FALSE, 10),
  ('insurance', 'general_liability_deductible','GL Deductible',                  'Per-claim deductible',                                    'always',   'annual', FALSE, FALSE, 15),
  ('insurance', 'directors_officers_premium',  'D&O Premium',                    'Directors & Officers liability premium',                  'always',   'annual', FALSE, FALSE, 20),
  ('insurance', 'directors_officers_deductible','D&O Deductible',                'Per-claim D&O deductible',                                'always',   'annual', FALSE, FALSE, 25),
  ('insurance', 'umbrella_premium',            'Umbrella Premium',               'Excess liability umbrella',                                'usually',  'annual', FALSE, TRUE,  30),
  ('insurance', 'crime_fidelity_premium',      'Crime / Fidelity Premium',       'Crime bond / fidelity coverage',                          'usually',  'annual', FALSE, TRUE,  40),
  ('insurance', 'property_premium',            'Property Premium',               'Buildings, contents, fixtures',                            'always',   'annual', FALSE, FALSE, 50),
  ('insurance', 'workers_comp_premium',        'Workers Compensation Premium',   'Required if any employees',                               'sometimes','annual', FALSE, TRUE,  60),
  ('insurance', 'cyber_premium',               'Cyber Liability Premium',        'Cybersecurity / data breach coverage',                    'rarely',   'annual', FALSE, TRUE,  70),
  ('insurance', 'flood_premium',               'Flood Premium',                  'Separate flood policy if applicable',                      'rarely',   'annual', FALSE, TRUE,  80)
ON CONFLICT (service_category, component_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_inclusion_rate = EXCLUDED.typical_inclusion_rate,
  sort_order = EXCLUDED.sort_order;

-- ----------------------------------------------------------------------------
-- 2) proposal_component_mappings
-- Each row maps one of a proposal's raw line items to a canonical component.
-- One proposal can have many mappings. Also captures "missing" components —
-- rows with is_missing_from_proposal=true represent canonical components NOT
-- addressed by the proposal at all (the "lowball by exclusion" detection).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proposal_component_mappings (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  proposal_id                   UUID NOT NULL REFERENCES vendor_proposals(id) ON DELETE CASCADE,
  service_category              TEXT NOT NULL,
  component_key                 TEXT,                                  -- nullable for line items that don't fit any canonical component
  -- Source line item from proposal.extracted_data.line_items
  raw_line_item_index           INTEGER,                                -- index into the proposal's extracted line_items
  raw_line_item_description     TEXT,                                  -- vendor's verbatim wording
  raw_line_item_amount          NUMERIC(14,2),                         -- as-stated amount from line item
  raw_line_item_unit            TEXT,                                  -- 'monthly','annual','per_hour' from vendor
  -- Normalized cost for benchmarking
  normalized_annual_amount      NUMERIC(14,2),                         -- annualized for cross-vendor comparison
  -- Mapping metadata
  mapping_confidence            TEXT CHECK (mapping_confidence IS NULL OR mapping_confidence IN ('high','medium','low','unmapped')),
  is_included_in_base           BOOLEAN NOT NULL DEFAULT TRUE,         -- false = listed as add-on/exclusion
  is_missing_from_proposal      BOOLEAN NOT NULL DEFAULT FALSE,        -- true = canonical component NOT addressed (gap detection)
  flagged_as_high_markup        BOOLEAN NOT NULL DEFAULT FALSE,        -- true if amount is >25% above category median
  flagged_as_unusual_exclusion  BOOLEAN NOT NULL DEFAULT FALSE,        -- true if a typically-included component is missing here
  notes                         TEXT,                                  -- Claude's notes on the mapping
  -- Audit
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  remapped_at                   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proposal_component_mappings_proposal
  ON proposal_component_mappings(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_component_mappings_component
  ON proposal_component_mappings(component_key, service_category)
  WHERE component_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposal_component_mappings_missing
  ON proposal_component_mappings(proposal_id, is_missing_from_proposal)
  WHERE is_missing_from_proposal = TRUE;

ALTER TABLE proposal_component_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_pcm_tenant ON proposal_component_mappings;
CREATE POLICY p_pcm_tenant ON proposal_component_mappings
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM vendor_proposals vp
    WHERE vp.id = proposal_component_mappings.proposal_id
      AND vp.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

GRANT ALL ON proposal_component_mappings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON proposal_component_mappings TO authenticated;

-- ----------------------------------------------------------------------------
-- 3) Benchmark view: per-component pricing distribution across the dataset
-- Answers "what's the median spend on lifeguarding across our communities in 2026?"
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_component_benchmarks AS
SELECT
  vp.management_company_id,
  pcm.service_category,
  pcm.component_key,
  EXTRACT(YEAR FROM COALESCE(vp.proposal_date, vp.created_at::DATE))::INTEGER AS proposal_year,
  COUNT(*)                                                                 AS data_points,
  COUNT(DISTINCT vp.vendor_id) FILTER (WHERE vp.vendor_id IS NOT NULL)     AS unique_vendors,
  COUNT(DISTINCT vp.community)                                             AS communities,
  MIN(pcm.normalized_annual_amount)                                        AS min_annualized,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY pcm.normalized_annual_amount) AS p25_annualized,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY pcm.normalized_annual_amount) AS median_annualized,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY pcm.normalized_annual_amount) AS p75_annualized,
  MAX(pcm.normalized_annual_amount)                                        AS max_annualized,
  AVG(pcm.normalized_annual_amount)                                        AS avg_annualized
FROM proposal_component_mappings pcm
JOIN vendor_proposals vp ON vp.id = pcm.proposal_id
WHERE pcm.component_key IS NOT NULL
  AND pcm.is_missing_from_proposal = FALSE
  AND pcm.normalized_annual_amount IS NOT NULL
  AND pcm.normalized_annual_amount > 0
GROUP BY vp.management_company_id, pcm.service_category, pcm.component_key,
         EXTRACT(YEAR FROM COALESCE(vp.proposal_date, vp.created_at::DATE));

GRANT SELECT ON v_component_benchmarks TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Comparison view: pivot of all components for a given bid_request
-- Used by the comparison UI to show vendors side-by-side per component.
-- (The actual side-by-side is built in the API layer because pivoting unknown
--  numbers of vendors is awkward in SQL — but this view feeds it.)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_proposal_components_flat AS
SELECT
  pcm.id                                AS mapping_id,
  pcm.proposal_id,
  vp.bid_request_id,
  vp.community,
  vp.service_category,
  vp.vendor_id,
  COALESCE(v.name, vp.vendor_name_raw)  AS vendor_name,
  vp.is_incumbent,
  vp.outcome,
  pcm.component_key,
  scc.display_name                      AS component_display_name,
  scc.typical_inclusion_rate,
  scc.is_typical_exclusion              AS component_is_typical_exclusion,
  scc.is_high_markup_target             AS component_is_high_markup_target,
  pcm.raw_line_item_description,
  pcm.raw_line_item_amount,
  pcm.normalized_annual_amount,
  pcm.is_included_in_base,
  pcm.is_missing_from_proposal,
  pcm.flagged_as_high_markup,
  pcm.flagged_as_unusual_exclusion,
  pcm.mapping_confidence,
  pcm.notes                             AS mapping_notes
FROM proposal_component_mappings pcm
JOIN vendor_proposals vp ON vp.id = pcm.proposal_id
LEFT JOIN vendors v ON v.id = vp.vendor_id
LEFT JOIN service_category_components scc
  ON scc.service_category = pcm.service_category AND scc.component_key = pcm.component_key;

GRANT SELECT ON v_proposal_components_flat TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (run as separate queries after applying):
--
--   SELECT service_category, COUNT(*) AS components
--     FROM service_category_components
--    GROUP BY service_category ORDER BY service_category;
--   -- expect: insurance (10), janitorial (12), landscape_maintenance (18),
--   --         pool_management (17), security (8)
--
--   SELECT COUNT(*) FROM proposal_component_mappings;  -- 0 (no data yet)
-- ----------------------------------------------------------------------------
