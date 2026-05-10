-- ============================================================================
-- 012_library_documents_module.sql
-- ----------------------------------------------------------------------------
-- Documents Tracker module. Bedrock's canonical document library.
--
-- Architectural decision: trustEd becomes the single source of truth for
-- community library_documents. Files live in Supabase Storage. HomeWise Doctivity
-- and Vantaca's library become DOWNSTREAM consumers — staff downloads from
-- trustEd, uploads to vendors, marks the push state in trustEd. Eventually
-- (Push 2) we automate push via vendor APIs.
--
-- Capabilities:
--   - Single + bulk PDF upload
--   - Claude auto-extracts metadata (community, category, period, status)
--   - SHA-256 + semantic duplicate detection
--   - Standardized filename on storage based on extracted metadata
--   - Per-community matrix view of all categories
--   - Natural-language retrieval ("give me 2026 LPF approved budget")
--   - Historical versioning (multiple Budgets across years preserved)
--   - Predecessor tagging (docs created before Bedrock took over each community)
--   - Push-to-vendor state tracking (HomeWise / Vantaca uploaded flags)
--   - Structured field extraction for downstream analytics (insurance trends,
--     budget comparisons, ReservEd, etc.)
--
-- Apply AFTER 011_knowledge_base.sql. Idempotent.
-- ============================================================================

-- ============================================================================
-- library_documents
-- One row per uploaded PDF. Status determines whether this version is
-- currently active or has been superseded by a newer version of the same
-- (community, category, period) tuple.
-- ============================================================================
CREATE TABLE IF NOT EXISTS library_documents (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID REFERENCES communities(id),     -- nullable for portfolio-level docs
  category                 TEXT NOT NULL,                        -- enum-like, see docs_categories below
  period_label             TEXT,                                 -- "2026", "2026-04", "FY2025-26", etc.
  effective_date           DATE,
  expiration_date          DATE,
  status                   TEXT NOT NULL DEFAULT 'current'
                           CHECK (status IN (
                             'current',           -- the active version
                             'superseded',        -- replaced by a newer version
                             'draft',             -- not yet approved/finalized
                             'not_applicable',    -- explicitly marked N/A for this community
                             'missing',           -- known to be needed but not yet uploaded (placeholder)
                             'archived'           -- intentionally retained but not in active rotation
                           )),
  approval_status          TEXT
                           CHECK (approval_status IS NULL OR approval_status IN (
                             'approved','draft','proposed','signed','unsigned'
                           )),
  title                    TEXT,                                 -- user-friendly title (auto-extracted)
  file_name_original       TEXT,                                 -- what the file was called when uploaded
  file_name_normalized     TEXT,                                 -- standardized name we render: "Lakes of Pine Forest - Annual Budget - 2026 - Approved.pdf"
  file_path                TEXT,                                 -- path in Supabase Storage (e.g., {mgmt_co}/{community}/{category}/{id}.pdf)
  file_hash                TEXT,                                 -- SHA-256 of bytes (for byte-level dedup)
  file_size_bytes          INTEGER,
  page_count               INTEGER,
  -- Provenance: was this doc created by Bedrock or by a predecessor management company?
  created_by_mgmt_company  TEXT NOT NULL DEFAULT 'Bedrock'
                           CHECK (created_by_mgmt_company IN ('Bedrock','Predecessor','Unknown')),
  predecessor_name         TEXT,                                 -- if Predecessor, who? e.g., "ABC Property Management"
  -- Push-to-vendor state
  in_homewise_doctivity    BOOLEAN NOT NULL DEFAULT FALSE,
  in_homewise_verified_at  TIMESTAMPTZ,
  in_vantaca_library       BOOLEAN NOT NULL DEFAULT FALSE,
  in_vantaca_verified_at   TIMESTAMPTZ,
  -- Extraction metadata
  extraction_model         TEXT,                                 -- which Claude model parsed this
  extraction_confidence    TEXT
                           CHECK (extraction_confidence IS NULL OR extraction_confidence IN ('high','medium','low')),
  extraction_notes         TEXT,                                 -- Claude's notes if anything was ambiguous
  -- Free-form
  notes                    TEXT,                                 -- staff notes about this specific document
  superseded_by_id         UUID REFERENCES library_documents(id),
  uploaded_by              UUID,                                 -- nullable until auth
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quick lookups
CREATE INDEX IF NOT EXISTS idx_docs_mgmt_co_community_category
  ON library_documents(management_company_id, community_id, category, status);
CREATE INDEX IF NOT EXISTS idx_docs_status
  ON library_documents(management_company_id, status) WHERE status IN ('current','missing');
CREATE INDEX IF NOT EXISTS idx_docs_expiration
  ON library_documents(expiration_date) WHERE expiration_date IS NOT NULL AND status = 'current';
CREATE UNIQUE INDEX IF NOT EXISTS ux_docs_file_hash
  ON library_documents(management_company_id, file_hash)
  WHERE file_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_library_documents_updated_at ON library_documents;
CREATE TRIGGER trg_library_documents_updated_at
  BEFORE UPDATE ON library_documents
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- document_extracted_fields
-- Structured field extraction (per document type, varies). Stored as JSONB
-- so different document types can have different schemas without altering
-- the table.
--
-- Examples:
--   Budget: { total: 1198248, line_items: [...], fiscal_year: '2026' }
--   Insurance: { carrier: 'Travelers', premium: 42500, policy_number: 'X',
--                effective: '2026-01-01', expiration: '2026-12-31',
--                coverage: { gl: 1000000/2000000, do: 1000000 } }
--   Reserve Study: { study_date: '2024-06-01', recommended_balance: ...,
--                    components: [...] }
--   Meeting Minutes: { meeting_date: '2026-04-15', meeting_type: 'regular',
--                      attendees: [...], decisions: [...] }
-- ============================================================================
CREATE TABLE IF NOT EXISTS document_extracted_fields (
  document_id              UUID PRIMARY KEY REFERENCES library_documents(id) ON DELETE CASCADE,
  fields                   JSONB NOT NULL,
  extracted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_extracted_fields_gin
  ON document_extracted_fields USING gin (fields);

-- ============================================================================
-- document_categories (master list per source type)
-- The canonical list of document categories trustEd recognizes. Used to
-- populate dropdowns, drive the per-community matrix view, and tag
-- ingested docs.
-- ============================================================================
CREATE TABLE IF NOT EXISTS document_categories (
  category                 TEXT PRIMARY KEY,            -- stable slug
  display_name             TEXT NOT NULL,
  description              TEXT,
  typical_frequency        TEXT
                           CHECK (typical_frequency IN ('one_time','annual','quarterly','monthly','event_driven','perpetual')),
  typical_expiration_months INTEGER,                    -- NULL = no expiration
  required_for_resale      BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order               INTEGER NOT NULL DEFAULT 0
);

-- Seed the standard HOA document categories
INSERT INTO document_categories (category, display_name, description, typical_frequency, typical_expiration_months, required_for_resale, sort_order) VALUES
  ('annual_budget',                'Annual Budget',                'The community''s approved budget for the fiscal year', 'annual', 12, TRUE, 10),
  ('insurance_dec_page',           'Insurance Dec Page',           'Declarations page from the community''s insurance policy', 'annual', 12, TRUE, 20),
  ('annual_board_meeting_minutes', 'Annual Board Meeting Minutes', 'Minutes from the annual board meeting', 'annual', 12, TRUE, 30),
  ('regular_meeting_minutes',      'Regular Meeting Minutes',      'Monthly/regular board meeting minutes', 'monthly', NULL, FALSE, 35),
  ('reserve_study',                'Reserve Study',                'Long-term capital reserve study', 'event_driven', 60, TRUE, 40),
  ('reserve_report',               'Reserve Report',               'Current reserve balance + status report', 'annual', 12, TRUE, 45),
  ('bylaws',                       'Bylaws',                       'Governing document — bylaws of the association', 'perpetual', NULL, TRUE, 50),
  ('declaration_ccrs',             'Declaration / CC&Rs',          'Governing document — Declaration of Covenants, Conditions & Restrictions', 'perpetual', NULL, TRUE, 60),
  ('rules_and_regulations',        'Rules and Regulations',        'Community rules and regulations', 'event_driven', NULL, TRUE, 70),
  ('resolutions_and_policies',     'Resolutions and Policies',     'Board-adopted resolutions and policies', 'event_driven', NULL, TRUE, 75),
  ('articles_of_incorporation',    'Articles of Incorporation',    'State filing creating the association entity', 'perpetual', NULL, TRUE, 80),
  ('annual_financial_statements',  'Annual Financial Statements',  'Audited or reviewed annual financials', 'annual', NULL, TRUE, 90),
  ('current_unaudited_financials', 'Current Unaudited Financials', 'Monthly unaudited financial statements', 'monthly', NULL, FALSE, 95),
  ('w9',                           'W-9',                          'IRS Form W-9 for the association', 'event_driven', NULL, FALSE, 100),
  ('welcome_package',              'Welcome Package',              'New resident welcome materials', 'event_driven', NULL, FALSE, 110),
  ('engineers_inspection_report',  'Engineer''s / Inspection Report', 'Engineer''s or inspection report on community structures', 'event_driven', 60, FALSE, 120),
  ('litigation',                   'Litigation',                   'Open or historical litigation documents', 'event_driven', NULL, TRUE, 130),
  ('design_document',              'Design Document',              'Architectural / design guidelines', 'perpetual', NULL, TRUE, 140),
  ('special_assessments',          'Special Assessments',          'Active special assessment documents', 'event_driven', NULL, TRUE, 150),
  ('unit_ledger',                  'Unit Ledger',                  'Per-unit ledger filler page (HomeWise resale)', 'event_driven', NULL, FALSE, 160),
  ('management_agreement',         'Management Agreement',         'Bedrock-Association management contract', 'perpetual', NULL, FALSE, 170),
  ('other',                        'Other',                        'Document that doesn''t fit standard categories', 'event_driven', NULL, FALSE, 999)
ON CONFLICT (category) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  typical_frequency = EXCLUDED.typical_frequency,
  typical_expiration_months = EXCLUDED.typical_expiration_months,
  required_for_resale = EXCLUDED.required_for_resale,
  sort_order = EXCLUDED.sort_order;

-- ============================================================================
-- community_management_history
-- Tracks when each community came under Bedrock's management. Used to
-- auto-tag predecessor-era library_documents based on creation date.
-- ============================================================================
CREATE TABLE IF NOT EXISTS community_management_history (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id             UUID NOT NULL REFERENCES communities(id),
  management_company       TEXT NOT NULL,                -- 'Bedrock' or predecessor name
  start_date               DATE NOT NULL,
  end_date                 DATE,                         -- NULL = currently managing
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, management_company, start_date)
);

CREATE INDEX IF NOT EXISTS idx_community_mgmt_history_community
  ON community_management_history(community_id, start_date);

-- Seed: Lakes of Pine Forest taken over by Bedrock on Aug 1, 2023 (per the contract we ingested)
INSERT INTO community_management_history (community_id, management_company, start_date, notes)
SELECT id, 'Bedrock', '2023-08-01', 'Management Start Date per signed agreement'
FROM communities WHERE name = 'Lakes of Pine Forest'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- document_duplicate_groups
-- When we detect duplicates (byte-level, content-level, or semantic), we
-- group them so the user can resolve the group in one action.
-- ============================================================================
CREATE TABLE IF NOT EXISTS document_duplicate_groups (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  detection_type           TEXT NOT NULL
                           CHECK (detection_type IN ('byte_identical','content_identical','semantic_match')),
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution_status        TEXT NOT NULL DEFAULT 'pending'
                           CHECK (resolution_status IN ('pending','resolved','dismissed_as_distinct')),
  resolved_at              TIMESTAMPTZ,
  resolved_by              UUID,
  notes                    TEXT
);

CREATE TABLE IF NOT EXISTS document_duplicate_members (
  group_id                 UUID NOT NULL REFERENCES document_duplicate_groups(id) ON DELETE CASCADE,
  document_id              UUID NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
  decision                 TEXT
                           CHECK (decision IS NULL OR decision IN ('keep','delete','keep_as_version')),
  PRIMARY KEY (group_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_dup_groups_pending
  ON document_duplicate_groups(management_company_id) WHERE resolution_status = 'pending';

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE library_documents                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extracted_fields       ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_management_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_duplicate_groups       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_duplicate_members      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_library_documents_tenant ON library_documents;
CREATE POLICY p_library_documents_tenant ON library_documents
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_doc_fields_tenant ON document_extracted_fields;
CREATE POLICY p_doc_fields_tenant ON document_extracted_fields
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM library_documents d
    WHERE d.id = document_extracted_fields.document_id
      AND d.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_mgmt_history_tenant ON community_management_history;
CREATE POLICY p_mgmt_history_tenant ON community_management_history
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communities c
    WHERE c.id = community_management_history.community_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_dup_groups_tenant ON document_duplicate_groups;
CREATE POLICY p_dup_groups_tenant ON document_duplicate_groups
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_dup_members_tenant ON document_duplicate_members;
CREATE POLICY p_dup_members_tenant ON document_duplicate_members
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM document_duplicate_groups g
    WHERE g.id = document_duplicate_members.group_id
      AND g.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ============================================================================
-- Grants
-- ============================================================================
GRANT ALL ON library_documents, document_extracted_fields, community_management_history,
             document_duplicate_groups, document_duplicate_members
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  library_documents, document_extracted_fields, community_management_history,
  document_duplicate_groups, document_duplicate_members
  TO authenticated;
GRANT SELECT ON document_categories TO service_role, authenticated;

-- ============================================================================
-- Convenience view: per-community document matrix
-- Each row = (community, category) cell. Tells the UI what's current,
-- what's expired, what's missing, who's pushed where.
-- ============================================================================
CREATE OR REPLACE VIEW v_community_document_matrix AS
SELECT
  c.id                        AS community_id,
  c.name                      AS community_name,
  cat.category                AS category,
  cat.display_name            AS category_display,
  cat.required_for_resale     AS required_for_resale,
  cat.typical_frequency       AS typical_frequency,
  d.id                        AS current_document_id,
  d.title                     AS current_document_title,
  d.file_name_normalized      AS current_document_filename,
  d.period_label              AS current_period,
  d.effective_date            AS current_effective_date,
  d.expiration_date           AS current_expiration_date,
  d.status                    AS current_status,
  d.created_by_mgmt_company   AS created_by_mgmt_company,
  d.in_homewise_doctivity     AS in_homewise,
  d.in_vantaca_library        AS in_vantaca,
  CASE
    WHEN d.id IS NULL THEN 'missing'
    WHEN d.expiration_date IS NOT NULL AND d.expiration_date < CURRENT_DATE THEN 'expired'
    WHEN d.expiration_date IS NOT NULL AND d.expiration_date < CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
    ELSE 'current'
  END                         AS matrix_status,
  CASE
    WHEN d.expiration_date IS NOT NULL THEN d.expiration_date - CURRENT_DATE
    ELSE NULL
  END                         AS days_to_expiration
FROM communities c
CROSS JOIN document_categories cat
LEFT JOIN library_documents d
  ON d.community_id = c.id
  AND d.category = cat.category
  AND d.status = 'current'
ORDER BY c.name, cat.sort_order;

GRANT SELECT ON v_community_document_matrix TO service_role, authenticated;

-- ============================================================================
-- Verify with:
--   SELECT COUNT(*) FROM document_categories;                  -- expect ~22
--   SELECT COUNT(*) FROM community_management_history;         -- expect 1 (LPF)
--   SELECT * FROM v_community_document_matrix WHERE community_name = 'Lakes of Pine Forest'
--     ORDER BY required_for_resale DESC, category_display;
-- ============================================================================
