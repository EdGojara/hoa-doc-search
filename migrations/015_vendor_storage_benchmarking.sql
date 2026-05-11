-- ============================================================================
-- 015_vendor_storage_benchmarking.sql
-- ----------------------------------------------------------------------------
-- Vendor Workflow data moat: store original PDFs, track bid outcomes, persist
-- signed contracts, and lay benchmarking views on top so trustEd can answer:
--
--   "What did landscape maintenance cost across Bedrock communities in 2026?"
--   "Has ABC Landscaping ever lost a bid? Who beat them?"
--   "How does this proposal compare to the median for similar communities?"
--   "What's our win rate for incumbents vs. challengers?"
--
-- That's TrueCar/Carfax for HOA vendors. No one else in the industry has this
-- structured because nobody else stores bids as data — they store them as PDFs
-- in a vendor's email folder and forget about them after the comparison.
--
-- Apply AFTER 014_board_packets.sql. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) vendor_proposals: add storage path, outcome tracking, file metadata
-- ----------------------------------------------------------------------------
ALTER TABLE vendor_proposals
  ADD COLUMN IF NOT EXISTS file_path TEXT,                  -- Supabase Storage path to original PDF
  ADD COLUMN IF NOT EXISTS file_hash TEXT,                  -- SHA-256 for byte-dedup
  ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','won','lost','withdrawn','expired')),
  ADD COLUMN IF NOT EXISTS outcome_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_vendor_proposals_outcome
  ON vendor_proposals(management_company_id, outcome, service_category);
CREATE INDEX IF NOT EXISTS idx_vendor_proposals_hash
  ON vendor_proposals(file_hash) WHERE file_hash IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) bid_requests: add storage path + selected-proposal pointer
-- ----------------------------------------------------------------------------
ALTER TABLE bid_requests
  ADD COLUMN IF NOT EXISTS rfp_file_path TEXT,              -- DOCX or PDF storage path
  ADD COLUMN IF NOT EXISTS selected_proposal_id UUID REFERENCES vendor_proposals(id);

-- ----------------------------------------------------------------------------
-- 3) vendor_service_categories: canonical master list driving benchmarks + filters
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_service_categories (
  category                 TEXT PRIMARY KEY,
  display_name             TEXT NOT NULL,
  description              TEXT,
  unit_of_measure          TEXT,                            -- 'monthly','annual','project','hourly','per_unit'
  typical_term_months      INTEGER,                          -- 12 = annual contract typical, NULL = varies
  benchmark_dimensions     JSONB,                            -- what to benchmark on: {"per_unit": "yes", "per_acre": "maybe"}
  sort_order               INTEGER NOT NULL DEFAULT 0
);

INSERT INTO vendor_service_categories (category, display_name, description, unit_of_measure, typical_term_months, sort_order) VALUES
  ('landscape_maintenance',  'Landscape Maintenance',   'Recurring grounds maintenance — mowing, edging, fertilization, seasonal cleanup', 'monthly', 12, 10),
  ('landscape_construction', 'Landscape Construction',  'Hardscape, plantings, irrigation install — project-based',                        'project',  NULL, 15),
  ('tree_service',           'Tree Service',            'Tree trimming, removal, planting, stump grinding',                                 'project',  NULL, 20),
  ('pool_management',        'Pool Management',         'Pool maintenance, chemicals, opening/closing, equipment',                          'monthly', 12, 25),
  ('janitorial',             'Janitorial / Cleaning',   'Common area cleaning, restrooms, clubhouse',                                       'monthly', 12, 30),
  ('pressure_washing',       'Pressure Washing',        'Sidewalks, monument signs, common surfaces',                                       'project',  NULL, 35),
  ('painting',               'Painting',                'Exterior or interior painting projects',                                           'project',  NULL, 40),
  ('repair',                 'General Repair',          'Carpentry, fencing, masonry, signage repair',                                      'project',  NULL, 45),
  ('security',               'Security Services',       'Guard, patrol, access control, monitoring',                                        'monthly', 12, 50),
  ('pest_control',           'Pest Control',            'Termite, mosquito, general pest treatments',                                       'monthly', 12, 55),
  ('irrigation',             'Irrigation Management',   'Irrigation system maintenance, controllers, repairs',                              'monthly', 12, 60),
  ('insurance',              'Insurance',               'GL, D&O, Umbrella, Crime policies',                                                'annual',  12, 70),
  ('legal',                  'Legal Services',          'Counsel for assessments, governance, fair housing',                                'hourly_or_retainer', NULL, 80),
  ('accounting',             'Accounting Services',     'External CPA, audit, tax preparation',                                             'annual',  NULL, 85),
  ('reserve_study',          'Reserve Study',           'Reserve study consultant — funding analysis + component inventory',                'project',  NULL, 90),
  ('engineer_inspection',    'Engineering / Inspection','Structural, pavement, ADA, irrigation audit reports',                              'project',  NULL, 95),
  ('management',             'Management Services',     'HOA management company (e.g., Bedrock, predecessor)',                              'monthly', 12, 100),
  ('other',                  'Other',                   'Service category not yet classified',                                              NULL,      NULL, 999)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  unit_of_measure = EXCLUDED.unit_of_measure,
  typical_term_months = EXCLUDED.typical_term_months,
  sort_order = EXCLUDED.sort_order;

GRANT SELECT ON vendor_service_categories TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 4) vendor_contracts: signed contracts that resulted from winning bids
-- Separate from the existing 'contracts' table which is for Bedrock-community
-- MANAGEMENT agreements. This table is for vendor SERVICE contracts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_contracts (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID REFERENCES communities(id),       -- nullable for portfolio-wide vendors
  community_name           TEXT,                                   -- denormalized for queries when community_id is null
  vendor_id                UUID REFERENCES vendors(id),
  vendor_name_raw          TEXT,                                   -- denormalized for legacy / unlinked vendors
  -- Source linkage
  source_proposal_id       UUID REFERENCES vendor_proposals(id),   -- the winning bid that became this contract
  bid_request_id           UUID REFERENCES bid_requests(id),
  -- Service classification
  service_category         TEXT REFERENCES vendor_service_categories(category) DEFAULT 'other',
  service_description      TEXT,                                   -- 1-2 sentence summary
  -- Dates
  effective_date           DATE,
  end_date                 DATE,                                   -- NULL = open-ended / auto-renewing
  signed_date              DATE,
  -- Financials
  total_amount             NUMERIC(14,2),                          -- contract total as written
  annualized_amount        NUMERIC(14,2),                          -- normalized to 12-month for cross-comparison
  term_months              INTEGER,
  currency                 TEXT DEFAULT 'USD',
  -- Terms
  escalator_kind           TEXT DEFAULT 'none'
                           CHECK (escalator_kind IN ('max_cpi_or_pct','fixed_pct','cpi_only','none')),
  escalator_pct            NUMERIC(5,2),
  payment_terms            TEXT,
  termination_terms        TEXT,
  auto_renews              BOOLEAN NOT NULL DEFAULT FALSE,
  renewal_notice_days      INTEGER,
  -- Signatures
  signatories              JSONB,                                  -- {"community":"...","vendor":"...","date":"..."}
  -- Insurance & compliance
  insurance_required       JSONB,                                  -- {"general_liability":"$1M/2M","umbrella":"$5M",...}
  w9_on_file               BOOLEAN NOT NULL DEFAULT FALSE,
  coi_on_file              BOOLEAN NOT NULL DEFAULT FALSE,
  -- Storage
  file_path                TEXT,                                   -- Supabase Storage path to signed PDF
  file_hash                TEXT,
  file_size_bytes          INTEGER,
  -- Extraction (when Claude parsed the contract PDF)
  extracted_data           JSONB,
  extraction_model         TEXT,
  extraction_confidence    TEXT
                           CHECK (extraction_confidence IS NULL OR extraction_confidence IN ('high','medium','low')),
  extraction_notes         TEXT,
  -- Status
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('draft','active','expiring','expired','terminated','superseded','renewed')),
  -- Freeform
  notes                    TEXT,
  -- Audit
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_contracts_mgmt_community
  ON vendor_contracts(management_company_id, community_id, service_category, status);
CREATE INDEX IF NOT EXISTS idx_vendor_contracts_vendor
  ON vendor_contracts(vendor_id, service_category, status);
CREATE INDEX IF NOT EXISTS idx_vendor_contracts_dates
  ON vendor_contracts(management_company_id, end_date) WHERE end_date IS NOT NULL AND status = 'active';

DROP TRIGGER IF EXISTS trg_vendor_contracts_updated_at ON vendor_contracts;
CREATE TRIGGER trg_vendor_contracts_updated_at
  BEFORE UPDATE ON vendor_contracts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 5) Benchmarking views — read-only data layer for analytics
-- ----------------------------------------------------------------------------

-- 5a) Flat per-proposal history with calculated dimensions for filtering
CREATE OR REPLACE VIEW v_vendor_bid_history AS
SELECT
  vp.id                                AS proposal_id,
  vp.management_company_id,
  vp.community                         AS community_name,
  c.id                                 AS community_id,
  vp.service_category,
  vp.vendor_id,
  COALESCE(v.name, vp.vendor_name_raw) AS vendor_name,
  vp.proposal_date,
  EXTRACT(YEAR FROM COALESCE(vp.proposal_date, vp.created_at::DATE))::INTEGER AS proposal_year,
  vp.total_amount,
  vp.annualized_total_amount           AS annualized_amount,
  vp.term_months,
  vp.is_incumbent,
  vp.outcome,
  vp.outcome_decided_at,
  vp.document_type,
  vp.bid_request_id,
  vp.filename,
  vp.file_path,
  vp.created_at
FROM vendor_proposals vp
LEFT JOIN vendors v ON v.id = vp.vendor_id
LEFT JOIN communities c
  ON c.name = vp.community
 AND c.management_company_id = vp.management_company_id;

GRANT SELECT ON v_vendor_bid_history TO service_role, authenticated;

-- 5b) Service category benchmarks: count + percentile pricing per year
CREATE OR REPLACE VIEW v_service_category_benchmarks AS
SELECT
  management_company_id,
  service_category,
  proposal_year,
  COUNT(*)                                                                 AS bid_count,
  COUNT(DISTINCT vendor_id) FILTER (WHERE vendor_id IS NOT NULL)           AS unique_vendors,
  COUNT(DISTINCT community_name)                                           AS communities_with_bids,
  MIN(annualized_amount)                                                   AS min_annualized,
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY annualized_amount)          AS p25_annualized,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY annualized_amount)          AS median_annualized,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY annualized_amount)          AS p75_annualized,
  MAX(annualized_amount)                                                   AS max_annualized,
  AVG(annualized_amount)                                                   AS avg_annualized
FROM v_vendor_bid_history
WHERE annualized_amount IS NOT NULL AND annualized_amount > 0
GROUP BY management_company_id, service_category, proposal_year;

GRANT SELECT ON v_service_category_benchmarks TO service_role, authenticated;

-- 5c) Vendor performance: per-vendor stats across all bids
CREATE OR REPLACE VIEW v_vendor_performance AS
SELECT
  management_company_id,
  vendor_id,
  vendor_name,
  COUNT(*)                                                                 AS total_bids,
  COUNT(*) FILTER (WHERE outcome = 'won')                                  AS bids_won,
  COUNT(*) FILTER (WHERE outcome = 'lost')                                 AS bids_lost,
  COUNT(*) FILTER (WHERE outcome = 'pending')                              AS bids_pending,
  COUNT(*) FILTER (WHERE outcome = 'withdrawn')                            AS bids_withdrawn,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE outcome = 'won') /
    NULLIF(COUNT(*) FILTER (WHERE outcome IN ('won','lost')), 0),
    1
  )                                                                        AS win_rate_pct,
  SUM(annualized_amount) FILTER (WHERE outcome = 'won')                    AS total_won_annualized,
  AVG(annualized_amount)                                                   AS avg_bid_annualized,
  COUNT(DISTINCT community_name)                                           AS communities_bid_for,
  COUNT(DISTINCT community_name) FILTER (WHERE outcome = 'won')            AS communities_won,
  COUNT(DISTINCT service_category)                                         AS service_categories_count,
  MIN(proposal_date)                                                       AS first_bid_date,
  MAX(proposal_date)                                                       AS last_bid_date
FROM v_vendor_bid_history
WHERE vendor_id IS NOT NULL OR vendor_name IS NOT NULL
GROUP BY management_company_id, vendor_id, vendor_name;

GRANT SELECT ON v_vendor_performance TO service_role, authenticated;

-- 5d) Community spend: per-community vendor activity
CREATE OR REPLACE VIEW v_community_vendor_spend AS
SELECT
  management_company_id,
  community_name,
  community_id,
  service_category,
  COUNT(*)                                                                 AS bids_received,
  COUNT(DISTINCT vendor_id) FILTER (WHERE vendor_id IS NOT NULL)           AS unique_bidders,
  COUNT(*) FILTER (WHERE outcome = 'won')                                  AS bids_won,
  SUM(annualized_amount) FILTER (WHERE outcome = 'won')                    AS won_annualized_total,
  AVG(annualized_amount)                                                   AS avg_bid_annualized,
  MIN(annualized_amount)                                                   AS min_bid_annualized,
  MAX(annualized_amount)                                                   AS max_bid_annualized
FROM v_vendor_bid_history
WHERE annualized_amount IS NOT NULL AND annualized_amount > 0
GROUP BY management_company_id, community_name, community_id, service_category;

GRANT SELECT ON v_community_vendor_spend TO service_role, authenticated;

-- 5e) Active vendor contracts roll-up — what's signed and current
CREATE OR REPLACE VIEW v_active_vendor_contracts AS
SELECT
  vc.id,
  vc.management_company_id,
  vc.community_id,
  vc.community_name,
  vc.vendor_id,
  COALESCE(v.name, vc.vendor_name_raw) AS vendor_name,
  vc.service_category,
  cat.display_name AS service_display_name,
  vc.effective_date,
  vc.end_date,
  CASE
    WHEN vc.end_date IS NOT NULL AND vc.end_date < CURRENT_DATE THEN 'expired'
    WHEN vc.end_date IS NOT NULL AND vc.end_date < CURRENT_DATE + INTERVAL '90 days' THEN 'expiring_soon'
    ELSE 'active'
  END                                  AS contract_status,
  CASE
    WHEN vc.end_date IS NOT NULL THEN vc.end_date - CURRENT_DATE
    ELSE NULL
  END                                  AS days_to_end,
  vc.annualized_amount,
  vc.total_amount,
  vc.term_months,
  vc.auto_renews,
  vc.w9_on_file,
  vc.coi_on_file,
  vc.file_path IS NOT NULL             AS has_signed_pdf,
  vc.source_proposal_id IS NOT NULL    AS has_source_bid
FROM vendor_contracts vc
LEFT JOIN vendors v ON v.id = vc.vendor_id
LEFT JOIN vendor_service_categories cat ON cat.category = vc.service_category
WHERE vc.status IN ('active','draft','expiring');

GRANT SELECT ON v_active_vendor_contracts TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 6) RLS for new table
-- ----------------------------------------------------------------------------
ALTER TABLE vendor_contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_vendor_contracts_tenant ON vendor_contracts;
CREATE POLICY p_vendor_contracts_tenant ON vendor_contracts
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

GRANT ALL ON vendor_contracts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_contracts TO authenticated;

-- ----------------------------------------------------------------------------
-- Verify (run as separate queries):
--
--   SELECT category, display_name FROM vendor_service_categories ORDER BY sort_order;
--   -- expect 18 rows
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='vendor_proposals'
--      AND column_name IN ('file_path','outcome','file_hash');
--   -- expect 3 rows
--
--   SELECT viewname FROM pg_views WHERE viewname LIKE 'v_%vendor%' OR viewname LIKE 'v_%bid%';
--   -- expect v_vendor_bid_history, v_service_category_benchmarks, v_vendor_performance,
--   --        v_community_vendor_spend, v_active_vendor_contracts
-- ----------------------------------------------------------------------------
