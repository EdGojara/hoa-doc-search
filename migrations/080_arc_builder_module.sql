-- ============================================================================
-- 080_arc_builder_module.sql
-- ----------------------------------------------------------------------------
-- ARC Builder Module — foundation schema.
--
-- WHY THIS EXISTS:
--   Bedrock has TWO developer communities (Still Creek Ranch, August Meadows).
--   August Meadows is projected at 100 builder submissions in year 1, scaling
--   to 400+ over 5-7 years from DRB Group alone. The existing ACC flow
--   (community_applications) is built for resident modifications — fence
--   stains, paint color changes, basketball goals — not builder-driven
--   new-construction volume from a small set of repeatable plans.
--
--   This module separates builder ARC from resident ARC: two front doors
--   (portal at builders.bedrocktxai.com + email at builders@bedrocktx.com),
--   one review backend, but separate precedent storage and a master plan
--   library that enables 5-minute fast-track reviews for repeat plans.
--
--   The Still Meadow 2026 letter that said only "Approved your application
--   for the listed project item(s): New Build." is the failure mode this
--   module exists to prevent. The Rabbit Creek 2023 letter (full material
--   spec — plan #, elevation, brick, stone, paint, trim, shutter, fence,
--   masonry %, conditions) is the floor going forward. Structured intake
--   means the output cannot drift through staff churn.
--
-- ARCHITECTURE NOTES:
--   - Builder precedents are STORED SEPARATELY from arc_historical_decisions
--     (Ed's call). Keeps DRB's 100 plan approvals from polluting AI retrieval
--     for resident paint requests.
--   - Master plans are BUILDER-SPECIFIC, COMMUNITY-SCOPED. DRB Plan 6512-A
--     can be approved at August Meadows but require fresh approval at Still
--     Creek Ranch (Design Guidelines differ). Encoded via the
--     master_plan_community_approvals join table.
--   - Reference format: {COMMUNITY_PREFIX}-BLD-{YEAR}-{COUNTER}.
--     Reuses application_reference_counters with service_type='arc_builder_new_construction'.
--   - PDFs land in the existing 'documents' bucket at
--     builders/{community_slug}/{year}/{reference}.pdf (single source of truth;
--     no separate bucket per the lesson learned from violation-letters).
--   - Portal auth reuses portal_users + portal_magic_links. We extend the
--     role CHECK to allow 'builder' and add a scope table (portal_user_builders).
--
-- APPLY AFTER 079. IDEMPOTENT (IF NOT EXISTS, ON CONFLICT).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) builder_companies — DRB Group, Lennar, etc.
--    One row per builder organization. Coordinators (portal_users) link to
--    a builder via portal_user_builders (defined below).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builder_companies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  company_name             TEXT NOT NULL,
  legal_name               TEXT,
  primary_email_domain     TEXT,
  primary_contact_name     TEXT,
  primary_contact_email    TEXT,
  primary_contact_phone    TEXT,
  mailing_address          TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive', 'on_hold')),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness on company name per management company.
-- (LOWER() can't appear inside an inline UNIQUE constraint — must be an index.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_builder_companies_name_ci
  ON builder_companies (management_company_id, LOWER(company_name));

CREATE INDEX IF NOT EXISTS idx_builder_companies_mgmt
  ON builder_companies(management_company_id, status);
CREATE INDEX IF NOT EXISTS idx_builder_companies_domain
  ON builder_companies(LOWER(primary_email_domain))
  WHERE primary_email_domain IS NOT NULL;

DROP TRIGGER IF EXISTS trg_builder_companies_updated_at ON builder_companies;
CREATE TRIGGER trg_builder_companies_updated_at
  BEFORE UPDATE ON builder_companies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2) master_plans — builder's pre-approved plan library
--    Master plans are builder-specific. Community approval is tracked in
--    master_plan_community_approvals (next table). Materials default lives
--    here so fast-track submissions pre-populate the full spec.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_plans (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_company_id       UUID NOT NULL REFERENCES builder_companies(id) ON DELETE RESTRICT,
  plan_number              TEXT NOT NULL,
  plan_name                TEXT,
  elevation                TEXT NOT NULL,
  elevation_orientation    TEXT CHECK (elevation_orientation IS NULL OR elevation_orientation IN ('left', 'right', 'standard')),
  square_footage           INTEGER,
  stories                  NUMERIC(2,1),
  default_materials        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'approved', 'retired')),
  first_approval_application_id UUID,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (builder_company_id, plan_number, elevation, elevation_orientation)
);

CREATE INDEX IF NOT EXISTS idx_master_plans_lookup
  ON master_plans(builder_company_id, plan_number, elevation);
CREATE INDEX IF NOT EXISTS idx_master_plans_status
  ON master_plans(builder_company_id, status);

DROP TRIGGER IF EXISTS trg_master_plans_updated_at ON master_plans;
CREATE TRIGGER trg_master_plans_updated_at
  BEFORE UPDATE ON master_plans
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 3) master_plan_community_approvals — community-scoped approval
--    A master plan can be approved for August Meadows but not Still Creek
--    Ranch (different Design Guidelines). Conditions attached per-community.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_plan_community_approvals (
  master_plan_id           UUID NOT NULL REFERENCES master_plans(id) ON DELETE CASCADE,
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  approved_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by              TEXT,
  approval_notes           TEXT,
  conditions               TEXT,
  retired_at               TIMESTAMPTZ,
  retired_by               TEXT,
  retired_reason           TEXT,
  PRIMARY KEY (master_plan_id, community_id)
);

CREATE INDEX IF NOT EXISTS idx_mpca_active_by_community
  ON master_plan_community_approvals(community_id, master_plan_id)
  WHERE retired_at IS NULL;

-- ----------------------------------------------------------------------------
-- 4) builder_applications — main submission record
--    Mirrors community_applications but builder-specific. Materials/options
--    in JSONB; high-cardinality match fields (plan_number, elevation,
--    street_address) are columnar for query performance.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builder_applications (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  builder_company_id       UUID NOT NULL REFERENCES builder_companies(id) ON DELETE RESTRICT,
  property_id              UUID REFERENCES properties(id) ON DELETE SET NULL,
  master_plan_id           UUID REFERENCES master_plans(id) ON DELETE SET NULL,

  reference_number         TEXT UNIQUE,

  -- Submitter (the purchasing coordinator who filed it)
  submitter_email          TEXT NOT NULL,
  submitter_name           TEXT,
  submitter_phone          TEXT,
  portal_user_id           UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  source                   TEXT NOT NULL DEFAULT 'portal'
                             CHECK (source IN ('portal', 'email', 'manual_entry', 'csv_bulk_import')),

  -- Property identification (columnar for query + master plan matching)
  lot_number               TEXT NOT NULL,
  block_number             TEXT,
  section_number           TEXT,
  street_address           TEXT NOT NULL,
  lot_type                 TEXT CHECK (lot_type IS NULL OR lot_type IN
                             ('interior', 'corner', 'cul_de_sac', 'backs_to_common_area',
                              'backs_to_thoroughfare', 'flag_lot')),

  -- Plan identification (columnar for fast-track matching)
  plan_number              TEXT NOT NULL,
  plan_name                TEXT,
  elevation                TEXT NOT NULL,
  elevation_orientation    TEXT CHECK (elevation_orientation IS NULL OR elevation_orientation IN ('left', 'right', 'standard')),
  square_footage           INTEGER,
  stories                  NUMERIC(2,1),

  -- Free-form materials + options (full spec lives here)
  --   Expected keys: brick_color, brick_manufacturer, stone_type, stone_color,
  --   masonry_percentage_front/sides/rear, masonry_wrap_distance_sides,
  --   masonry_two_story_compliance, siding_material, siding_color, trim_color,
  --   shutter_color, shutters_present, front_door_color, garage_door_color,
  --   garage_door_style, roof_material, roof_color, fence_present,
  --   fence_material, fence_height_feet, driveway_material, irrigation_included,
  --   options_selected (array), structural_modifications, setbacks, etc.
  application_data         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Workflow state
  status                   TEXT NOT NULL DEFAULT 'received'
                             CHECK (status IN ('received', 'under_review', 'info_requested',
                                               'approved', 'approved_with_conditions',
                                               'denied', 'withdrawn')),
  fast_track               BOOLEAN NOT NULL DEFAULT FALSE,
  fast_track_reason        TEXT,

  -- Construction timing (informational)
  target_construction_start_date  DATE,
  estimated_completion_date       DATE,

  -- Builder acknowledgments captured at submission (compliance + change-control)
  builder_acknowledgments  JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- AI assessment snapshot (denormalized for queue queries; canonical row in builder_application_assessments)
  assessment_draft_response       TEXT,
  assessment_recommended_action   TEXT
                             CHECK (assessment_recommended_action IS NULL OR assessment_recommended_action IN
                                    ('approve', 'approve_with_conditions', 'request_more_info', 'deny', 'manual_review')),

  -- Decision metadata (populated on finalize; canonical row in builder_application_responses)
  decided_at               TIMESTAMPTZ,
  decided_by               TEXT,

  submitted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_builder_apps_queue
  ON builder_applications(community_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_builder_apps_builder
  ON builder_applications(builder_company_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_builder_apps_plan_match
  ON builder_applications(builder_company_id, plan_number, elevation);
CREATE INDEX IF NOT EXISTS idx_builder_apps_property
  ON builder_applications(property_id)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_builder_apps_fast_track
  ON builder_applications(community_id, status, fast_track)
  WHERE fast_track = TRUE;
CREATE INDEX IF NOT EXISTS idx_builder_apps_master_plan
  ON builder_applications(master_plan_id)
  WHERE master_plan_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_builder_applications_updated_at ON builder_applications;
CREATE TRIGGER trg_builder_applications_updated_at
  BEFORE UPDATE ON builder_applications
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Back-FK from master_plans.first_approval_application_id
ALTER TABLE master_plans
  ADD CONSTRAINT fk_master_plans_first_approval
  FOREIGN KEY (first_approval_application_id)
  REFERENCES builder_applications(id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE master_plans VALIDATE CONSTRAINT fk_master_plans_first_approval;

-- ----------------------------------------------------------------------------
-- 5) builder_application_assessments — AI compliance pass output
--    One row per assessment run. Latest row is the canonical assessment;
--    older rows preserved for audit (e.g., assessment re-run after spec change).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builder_application_assessments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           UUID NOT NULL REFERENCES builder_applications(id) ON DELETE CASCADE,
  compared_against_master_plan_id  UUID REFERENCES master_plans(id) ON DELETE SET NULL,

  assessment_text          TEXT,            -- structured findings (rendered to manager)
  draft_response           TEXT,            -- Bedrock-voice email to builder
  recommended_action       TEXT
                             CHECK (recommended_action IS NULL OR recommended_action IN
                                    ('approve', 'approve_with_conditions', 'request_more_info', 'deny', 'manual_review')),
  ai_compliance_findings   JSONB NOT NULL DEFAULT '[]'::jsonb,
                           -- array of {section_ref, finding, severity, recommendation}
  ai_confidence            NUMERIC(3,2),    -- 0.00-1.00
  model_version            TEXT,            -- e.g., 'claude-sonnet-4-6'
  ai_provider              TEXT DEFAULT 'anthropic',
  run_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_by                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_builder_assessments_app
  ON builder_application_assessments(application_id, run_at DESC);

-- ----------------------------------------------------------------------------
-- 6) builder_application_responses — manager decision
--    One row per final decision. Mirrors application_responses pattern.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builder_application_responses (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           UUID NOT NULL REFERENCES builder_applications(id) ON DELETE CASCADE,
  response_type            TEXT NOT NULL
                             CHECK (response_type IN ('approved', 'approved_with_conditions',
                                                      'denied', 'info_requested', 'withdrawn')),
  message_to_builder       TEXT,
  conditions               TEXT,
  denial_reasons           TEXT,
  decided_by               TEXT NOT NULL,
  decided_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Generated letter artifact
  letter_pdf_path          TEXT,            -- supabase storage path: builders/{slug}/{year}/{ref}.pdf
  letter_signed_url        TEXT,            -- short-lived signed URL captured at send time
  letter_signed_url_expires_at  TIMESTAMPTZ,

  -- Email send tracking
  email_subject            TEXT,
  email_sent_at            TIMESTAMPTZ,
  email_message_id         TEXT,
  email_bcc_archive        BOOLEAN NOT NULL DEFAULT TRUE,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_builder_responses_app
  ON builder_application_responses(application_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_builder_responses_decided
  ON builder_application_responses(decided_at DESC);

-- ----------------------------------------------------------------------------
-- 7) builder_application_attachments — files uploaded with submission
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builder_application_attachments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           UUID NOT NULL REFERENCES builder_applications(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL
                             CHECK (kind IN ('site_plan', 'front_elevation', 'rear_elevation',
                                             'left_side_elevation', 'right_side_elevation',
                                             'floor_plan', 'color_board', 'material_sample',
                                             'plat', 'survey', 'other')),
  storage_bucket           TEXT NOT NULL DEFAULT 'documents',
  storage_path             TEXT NOT NULL,
  original_filename        TEXT,
  mime_type                TEXT,
  size_bytes               BIGINT,
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by              TEXT
);

CREATE INDEX IF NOT EXISTS idx_builder_attachments_app
  ON builder_application_attachments(application_id, kind);

-- ----------------------------------------------------------------------------
-- 8) builder_precedents — finalized decisions promoted for AI retrieval
--    Separate from arc_historical_decisions (Ed's call): builder volume
--    is structurally repetitive (DRB plan library) and would dominate
--    semantic retrieval for resident modifications. Keep them apart.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS builder_precedents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           UUID NOT NULL REFERENCES builder_applications(id) ON DELETE CASCADE,
  community_id             UUID NOT NULL REFERENCES communities(id),
  builder_company_id       UUID NOT NULL REFERENCES builder_companies(id),
  property_id              UUID REFERENCES properties(id) ON DELETE SET NULL,
  master_plan_id           UUID REFERENCES master_plans(id) ON DELETE SET NULL,

  reference_number         TEXT NOT NULL,
  decision_type            TEXT NOT NULL
                             CHECK (decision_type IN ('approved', 'approved_with_conditions', 'denied')),
  plan_number              TEXT,
  elevation                TEXT,
  summary                  TEXT NOT NULL,
  reasoning                TEXT,
  conditions               TEXT,
  materials_snapshot       JSONB NOT NULL DEFAULT '{}'::jsonb,

  decided_at               TIMESTAMPTZ NOT NULL,
  embedding                VECTOR(1536),
  embedding_model          TEXT,
  extraction_confidence    NUMERIC(3,2),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_builder_precedents_community
  ON builder_precedents(community_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_builder_precedents_builder_plan
  ON builder_precedents(builder_company_id, plan_number, elevation);
-- IVFFLAT index on embedding deferred until populated (per migration 050 pattern).
-- Create with:
--   CREATE INDEX idx_builder_precedents_embedding ON builder_precedents
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ----------------------------------------------------------------------------
-- 9) Portal user role extension — add 'builder' role
-- ----------------------------------------------------------------------------
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE portal_users
  ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('board_member', 'homeowner', 'staff', 'admin', 'franchisee', 'builder'));

-- ----------------------------------------------------------------------------
-- 10) portal_user_builders — which builder company a portal user represents
--     A coordinator at DRB Group can submit on behalf of DRB only.
--     A coordinator at multiple builders gets multiple rows.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_user_builders (
  portal_user_id           UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  builder_company_id       UUID NOT NULL REFERENCES builder_companies(id) ON DELETE CASCADE,
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by               TEXT,
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  notes                    TEXT,
  PRIMARY KEY (portal_user_id, builder_company_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_user_builders_active
  ON portal_user_builders(portal_user_id, builder_company_id)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 11) Communities table extensions — per-community builder ARC config
--     Each developer community sets its own fee, SLA, design guidelines URL.
--     builder_arc_active is the kill switch: off by default so the module
--     is opt-in per community.
-- ----------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS builder_arc_active                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS builder_arc_fee_cents             INTEGER,
  ADD COLUMN IF NOT EXISTS builder_arc_sla_business_days     INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS builder_arc_fast_track_business_days  INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS builder_arc_design_guidelines_url TEXT,
  ADD COLUMN IF NOT EXISTS builder_arc_reference_prefix      TEXT;
  -- builder_arc_reference_prefix lets a community override the default community-prefix
  -- (e.g., 'AM' for August Meadows). When NULL, falls back to first 2-3 chars of slug.

COMMENT ON COLUMN communities.builder_arc_active IS
  'Kill switch: off by default so builder ARC ingest/portal is opt-in per community. Flip to TRUE when DRB onboarding is complete and SLA + fee are set.';
COMMENT ON COLUMN communities.builder_arc_fee_cents IS
  'New-construction ARC review fee per submission (cents). Industry range $250-500. Resident-modification fees ($35-75) are tracked separately.';

-- ----------------------------------------------------------------------------
-- 12) View — v_builder_queue: manager-facing review queue snapshot
--     Surfaces the data the ARC Review tab needs without N+1 fetches.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_builder_queue AS
SELECT
  ba.id                                    AS application_id,
  ba.community_id,
  c.name                                   AS community_name,
  c.slug                                   AS community_slug,
  ba.builder_company_id,
  bc.company_name                          AS builder_company_name,
  ba.reference_number,
  ba.submitter_email,
  ba.submitter_name,
  ba.source,
  ba.street_address,
  ba.lot_number,
  ba.plan_number,
  ba.elevation,
  ba.master_plan_id,
  mp.status                                AS master_plan_status,
  ba.fast_track,
  ba.status,
  ba.assessment_recommended_action,
  ba.submitted_at,
  ba.decided_at,
  ba.decided_by,
  EXTRACT(EPOCH FROM (NOW() - ba.submitted_at)) / 86400.0 AS age_days,
  -- Attachment count for queue badge
  (SELECT COUNT(*) FROM builder_application_attachments baa
    WHERE baa.application_id = ba.id)      AS attachment_count
FROM builder_applications ba
JOIN communities c          ON c.id = ba.community_id
JOIN builder_companies bc   ON bc.id = ba.builder_company_id
LEFT JOIN master_plans mp   ON mp.id = ba.master_plan_id;

-- ----------------------------------------------------------------------------
-- 13) RPC — match_builder_precedents() for AI retrieval
--     Mirrors match_arc_decisions() pattern. Optional community filter.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_builder_precedents(
  query_embedding  VECTOR(1536),
  match_count      INT DEFAULT 5,
  community_filter UUID DEFAULT NULL,
  builder_filter   UUID DEFAULT NULL
)
RETURNS TABLE (
  id                  UUID,
  reference_number    TEXT,
  decision_type       TEXT,
  plan_number         TEXT,
  elevation           TEXT,
  summary             TEXT,
  conditions          TEXT,
  decided_at          TIMESTAMPTZ,
  similarity          NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    bp.id,
    bp.reference_number,
    bp.decision_type,
    bp.plan_number,
    bp.elevation,
    bp.summary,
    bp.conditions,
    bp.decided_at,
    (1 - (bp.embedding <=> query_embedding))::NUMERIC AS similarity
  FROM builder_precedents bp
  WHERE bp.embedding IS NOT NULL
    AND (community_filter IS NULL OR bp.community_id = community_filter)
    AND (builder_filter   IS NULL OR bp.builder_company_id = builder_filter)
  ORDER BY bp.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ----------------------------------------------------------------------------
-- 14) Grants
--     Builder-application tables follow the community_applications pattern
--     (anon + authenticated + service_role) because the public submission
--     form needs write access via anon key.
--     portal_user_builders + builder_companies (admin surface) are
--     service_role only.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  builder_applications,
  builder_application_assessments,
  builder_application_responses,
  builder_application_attachments,
  builder_precedents,
  master_plans,
  master_plan_community_approvals
  TO anon, authenticated, service_role;

GRANT ALL ON
  builder_companies,
  portal_user_builders
  TO service_role;

GRANT SELECT ON v_builder_queue TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION match_builder_precedents(VECTOR(1536), INT, UUID, UUID)
  TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- 15) Comments
-- ----------------------------------------------------------------------------
COMMENT ON TABLE builder_applications IS
  'Builder-driven new construction ARC submissions. Separate from community_applications (resident modifications). Same backend review queue, separate intake + precedent storage.';
COMMENT ON TABLE master_plans IS
  'Builder-specific plan library. Community approval tracked in master_plan_community_approvals — a plan can be approved at one community and require fresh approval at another.';
COMMENT ON TABLE builder_precedents IS
  'Finalized builder decisions promoted for AI precedent retrieval. Kept separate from arc_historical_decisions to prevent builder volume from polluting resident-modification retrieval.';
COMMENT ON FUNCTION match_builder_precedents IS
  'Semantic retrieval over finalized builder decisions. Mirrors match_arc_decisions(). Use community_filter when reviewing a submission for a specific community; builder_filter for cross-community precedent for the same builder.';

COMMIT;

-- ============================================================================
-- VERIFY (run after migration):
--   SELECT count(*) FROM builder_applications;          -- 0
--   SELECT count(*) FROM master_plans;                  -- 0
--   \d+ builder_applications
--   \d+ master_plan_community_approvals
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='communities' AND column_name LIKE 'builder_arc%';
--   -- Should return 6 rows: active, fee_cents, sla_business_days,
--   -- fast_track_business_days, design_guidelines_url, reference_prefix
-- ============================================================================
