-- ============================================================================
-- 021_community_applications.sql
-- ----------------------------------------------------------------------------
-- Phase 1 of the ACC application portal: schema for owner-facing applications
-- (ARC, pool/amenity, gate, gym, pet) with per-community service configuration,
-- AI assessment, audit trail, and forward-compatible payment fields.
--
-- All tables idempotent. Safe to re-run.
-- Apply AFTER 020.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) communities: add reference_prefix column for application numbers
-- ----------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS reference_prefix TEXT;

-- Seed reference prefixes for known Bedrock communities (idempotent — only
-- sets if NULL, so re-running doesn't overwrite Ed's later edits)
UPDATE communities SET reference_prefix = 'LPF' WHERE name ILIKE 'Lakes of Pine Forest%' AND reference_prefix IS NULL;
UPDATE communities SET reference_prefix = 'EAG' WHERE name ILIKE 'Eaglewood%' AND reference_prefix IS NULL;
UPDATE communities SET reference_prefix = 'WAT' WHERE name ILIKE 'Waterview%' AND reference_prefix IS NULL;
UPDATE communities SET reference_prefix = 'CG'  WHERE name ILIKE 'Canyon Gate%' AND reference_prefix IS NULL;
UPDATE communities SET reference_prefix = 'QR'  WHERE name ILIKE 'Quail Ridge%' AND reference_prefix IS NULL;
UPDATE communities SET reference_prefix = 'SCR' WHERE name ILIKE 'Still Creek Ranch%' AND reference_prefix IS NULL;
UPDATE communities SET reference_prefix = 'AM'  WHERE name ILIKE 'August Meadows%' AND reference_prefix IS NULL;

-- Auto-prefix any unmatched community from name (uppercase first 3 chars of slugified name)
UPDATE communities
   SET reference_prefix = UPPER(LEFT(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g'), 3))
 WHERE reference_prefix IS NULL AND name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_communities_reference_prefix
  ON communities(management_company_id, reference_prefix)
  WHERE reference_prefix IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) community_services: per-community service offerings + fee configuration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_services (
  id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id         UUID NOT NULL REFERENCES management_companies(id),
  community_id                  UUID NOT NULL REFERENCES communities(id),
  -- Service classification
  service_type                  TEXT NOT NULL
                                CHECK (service_type IN ('arc','pool_amenity','gate_vehicle','gym_access','pet','general')),
  service_reference_suffix      TEXT NOT NULL,  -- 'ARC','POOL','GATE','GYM','PET','GEN' — used in reference numbers
  enabled                       BOOLEAN NOT NULL DEFAULT TRUE,
  display_name_override         TEXT,  -- optional, defaults to standard service display name
  description_override          TEXT,
  -- Fee structure
  application_fee_usd           NUMERIC(10,2),  -- nullable: variable-fee services calculate per-app
  paid_by                       TEXT NOT NULL DEFAULT 'free'
                                CHECK (paid_by IN ('community','owner','free')),
  fee_structure_notes           TEXT,  -- e.g., 'First fob included; $25 replacement'
  -- Revenue routing (forward-compatible with Stripe Connect, manual today)
  revenue_destination           TEXT NOT NULL DEFAULT 'community'
                                CHECK (revenue_destination IN ('bedrock','community')),
  community_stripe_account_id   TEXT,  -- NULL until Stripe Connect onboarded
  platform_fee_usd              NUMERIC(10,2) DEFAULT 0,  -- Bedrock cut, if any
  payment_provider              TEXT NOT NULL DEFAULT 'manual'
                                CHECK (payment_provider IN ('manual','stripe_connect','stripe_direct')),
  -- Service-specific configuration (JSONB for flexibility)
  service_config                JSONB DEFAULT '{}'::jsonb,
  -- Examples:
  --   arc:           {"notice_days_required": 45, "work_types": [...]}
  --   pool_amenity:  {"first_unit_free": true, "max_per_household": 4}
  --   gate_vehicle:  {"max_vehicles_per_unit": 2}
  --   gym_access:    {"requires_age_certification": true}
  --   pet:           {"max_pets": 2, "breed_restrictions": true}
  -- Internal-only notes (never shown to owner)
  internal_billing_notes        TEXT,
  internal_notes                TEXT,
  -- Audit
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, service_type)
);

CREATE INDEX IF NOT EXISTS idx_community_services_enabled
  ON community_services(community_id, enabled) WHERE enabled = TRUE;

DROP TRIGGER IF EXISTS trg_community_services_updated_at ON community_services;
CREATE TRIGGER trg_community_services_updated_at
  BEFORE UPDATE ON community_services
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 3) community_addresses: address-to-community lookup for portal routing
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_addresses (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id             UUID NOT NULL REFERENCES communities(id),
  -- Structured address parts
  street_number            TEXT,
  street_name              TEXT,
  street_type              TEXT,    -- 'St', 'Dr', 'Ct', etc. (normalized)
  unit_number              TEXT,    -- apartment/unit for townhomes
  city                     TEXT,
  state                    TEXT,
  zip_code                 TEXT,
  -- Search optimization
  full_address_raw         TEXT,    -- original as imported, for display
  full_address_normalized  TEXT,    -- lowercase, abbreviated, for fuzzy match
  -- Lifecycle (developer communities have addresses added over time)
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  imported_from            TEXT
                           CHECK (imported_from IS NULL OR imported_from IN ('homewise','vantaca','county','manual','developer_export')),
  imported_at              TIMESTAMPTZ,
  imported_by              UUID,
  last_verified_at         TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_addresses_normalized
  ON community_addresses(full_address_normalized);
CREATE INDEX IF NOT EXISTS idx_community_addresses_zip
  ON community_addresses(zip_code);
CREATE INDEX IF NOT EXISTS idx_community_addresses_community
  ON community_addresses(community_id) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_community_addresses_updated_at ON community_addresses;
CREATE TRIGGER trg_community_addresses_updated_at
  BEFORE UPDATE ON community_addresses
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) application_reference_counters: atomic sequence per (community, service, year)
-- Powers reference number generation: 'LPF-ARC-2026-0001'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_reference_counters (
  community_id     UUID NOT NULL REFERENCES communities(id),
  service_type     TEXT NOT NULL,
  year             INTEGER NOT NULL,
  counter          INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, service_type, year)
);

-- ----------------------------------------------------------------------------
-- 5) community_applications: the main application record
-- Holds owner-submitted applications for ANY service type. Service-specific
-- form data lives in application_data JSONB to keep schema flexible.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_applications (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id       UUID NOT NULL REFERENCES management_companies(id),
  community_id                UUID NOT NULL REFERENCES communities(id),
  community_service_id        UUID NOT NULL REFERENCES community_services(id),
  reference_number            TEXT NOT NULL UNIQUE,   -- 'LPF-ARC-2026-0001'
  service_type                TEXT NOT NULL,           -- denormalized for query convenience
  -- Submitter
  submitter_name              TEXT NOT NULL,
  submitter_email             TEXT NOT NULL,
  submitter_phone             TEXT,
  property_address            TEXT NOT NULL,
  property_unit               TEXT,
  property_address_id         UUID REFERENCES community_addresses(id),
  -- Application content (service-specific shape in JSONB)
  application_data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AI assessment (latest snapshot — full history in application_assessments)
  assessment_status           TEXT
                              CHECK (assessment_status IS NULL OR assessment_status IN
                                ('likely_approved','incomplete','concerns_identified','manual_review')),
  assessment_summary          TEXT,
  assessment_missing_items    JSONB,
  assessment_concerns         JSONB,
  assessment_citations        JSONB,
  assessment_confidence       TEXT
                              CHECK (assessment_confidence IS NULL OR assessment_confidence IN ('high','medium','low')),
  last_assessment_at          TIMESTAMPTZ,
  -- Manager decision (final)
  final_status                TEXT NOT NULL DEFAULT 'draft'
                              CHECK (final_status IN ('draft','pending_committee_review','approved','denied','withdrawn','closed')),
  final_decided_at            TIMESTAMPTZ,
  final_decided_by            UUID,
  final_decision_reasoning    TEXT,
  final_decision_letter_path  TEXT,
  -- Payment (forward-compatible — Phase 1 uses manual, Phase 2 wires Stripe)
  calculated_fee_usd          NUMERIC(10,2),
  fee_basis                   TEXT,
  payment_status              TEXT NOT NULL DEFAULT 'not_required'
                              CHECK (payment_status IN
                                ('not_required','pending','paid','waived','refunded','failed')),
  payment_method              TEXT
                              CHECK (payment_method IS NULL OR payment_method IN
                                ('check','money_order','stripe','zelle','cash','ach','manual')),
  payment_reference           TEXT,
  paid_at                     TIMESTAMPTZ,
  -- Lifecycle
  submitted_at                TIMESTAMPTZ,
  application_locked          BOOLEAN NOT NULL DEFAULT FALSE,
  magic_link_token            TEXT,
  magic_link_expires_at       TIMESTAMPTZ,
  -- Notes
  notes                       TEXT,
  internal_notes              TEXT,
  -- Audit
  client_ip                   INET,
  user_agent                  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_apps_queue
  ON community_applications(management_company_id, community_id, final_status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_apps_status
  ON community_applications(final_status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_apps_assessment
  ON community_applications(assessment_status, last_assessment_at DESC)
  WHERE assessment_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_apps_payment_pending
  ON community_applications(management_company_id, payment_status)
  WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_community_apps_magic_link
  ON community_applications(magic_link_token)
  WHERE magic_link_token IS NOT NULL;

DROP TRIGGER IF EXISTS trg_community_applications_updated_at ON community_applications;
CREATE TRIGGER trg_community_applications_updated_at
  BEFORE UPDATE ON community_applications
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 6) application_attachments: photos, plans, supporting docs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_attachments (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id      UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  attachment_type     TEXT NOT NULL,
  -- 'site_plan' | 'photo_current' | 'photo_inspiration' | 'spec_sheet' |
  -- 'contractor_license' | 'insurance_certificate' | 'vehicle_registration' |
  -- 'vaccination_record' | 'identification' | 'other'
  file_path           TEXT NOT NULL,    -- supabase storage path
  file_size_bytes     INTEGER,
  file_mime_type      TEXT,
  file_hash           TEXT,             -- SHA-256 for dedup
  original_filename   TEXT,
  caption             TEXT,             -- owner-provided description
  display_order       INTEGER NOT NULL DEFAULT 0,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_attachments_app
  ON application_attachments(application_id, display_order);
CREATE INDEX IF NOT EXISTS idx_application_attachments_type
  ON application_attachments(application_id, attachment_type);

-- ----------------------------------------------------------------------------
-- 7) application_assessments: full history of every AI assessment run
-- Each submission/revision triggers a new row. Latest snapshot is denormalized
-- onto community_applications for quick query, but the audit trail lives here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_assessments (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id           UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  -- Assessment result
  status                   TEXT NOT NULL
                           CHECK (status IN ('likely_approved','incomplete','concerns_identified','manual_review')),
  summary                  TEXT,
  missing_items            JSONB,        -- [{item, required: true|false, hint}]
  concerns                 JSONB,        -- [{concern, citation, severity}]
  citations                JSONB,        -- [{document, section, quote}]
  confidence               TEXT
                           CHECK (confidence IN ('high','medium','low')),
  -- AI runtime metadata
  ai_model                 TEXT,
  ai_input_tokens          INTEGER,
  ai_output_tokens         INTEGER,
  ai_duration_ms           INTEGER,
  prompt_version           TEXT,         -- e.g., 'v1', 'v2' for tracking improvements
  -- Trigger context
  triggered_by             TEXT
                           CHECK (triggered_by IN ('initial_submission','revision','manual_remap','periodic_recheck')),
  triggered_by_user        UUID,
  -- Audit
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_assessments_app
  ON application_assessments(application_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 8) application_responses: log of manager actions and owner communications
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_responses (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id      UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  -- Action classification
  response_type       TEXT NOT NULL
                      CHECK (response_type IN (
                        'approval','denial','request_more_info','note','manual_override',
                        'email_sent','fee_marked_paid','status_change','withdraw'
                      )),
  -- Communication
  message_to_owner    TEXT,        -- if sent to owner (e.g., email body)
  internal_notes      TEXT,        -- never sent to owner
  -- Email tracking
  email_subject       TEXT,
  email_sent_at       TIMESTAMPTZ,
  email_to            TEXT,
  -- Audit
  action_by           UUID,        -- manager user (null until auth)
  action_by_name      TEXT,        -- denormalized for display
  action_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata            JSONB
);

CREATE INDEX IF NOT EXISTS idx_application_responses_app
  ON application_responses(application_id, action_at DESC);

-- ----------------------------------------------------------------------------
-- 9) RLS policies (tenant isolation by management_company_id)
-- ----------------------------------------------------------------------------
ALTER TABLE community_services             ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_addresses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_applications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_attachments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_assessments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_responses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_reference_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_community_services_tenant ON community_services;
CREATE POLICY p_community_services_tenant ON community_services
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_community_addresses_tenant ON community_addresses;
CREATE POLICY p_community_addresses_tenant ON community_addresses
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communities c
    WHERE c.id = community_addresses.community_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_community_applications_tenant ON community_applications;
CREATE POLICY p_community_applications_tenant ON community_applications
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_application_attachments_tenant ON application_attachments;
CREATE POLICY p_application_attachments_tenant ON application_attachments
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM community_applications a
    WHERE a.id = application_attachments.application_id
      AND a.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_application_assessments_tenant ON application_assessments;
CREATE POLICY p_application_assessments_tenant ON application_assessments
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM community_applications a
    WHERE a.id = application_assessments.application_id
      AND a.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_application_responses_tenant ON application_responses;
CREATE POLICY p_application_responses_tenant ON application_responses
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM community_applications a
    WHERE a.id = application_responses.application_id
      AND a.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_application_reference_counters_tenant ON application_reference_counters;
CREATE POLICY p_application_reference_counters_tenant ON application_reference_counters
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communities c
    WHERE c.id = application_reference_counters.community_id
      AND c.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ----------------------------------------------------------------------------
-- 10) Grants
-- ----------------------------------------------------------------------------
GRANT ALL ON community_services, community_addresses, community_applications,
             application_attachments, application_assessments, application_responses,
             application_reference_counters
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  community_services, community_addresses, community_applications,
  application_attachments, application_assessments, application_responses,
  application_reference_counters
  TO authenticated;

-- ============================================================================
-- SEED: community_services for Bedrock's known communities
-- ----------------------------------------------------------------------------
-- All seeds use INSERT ... ON CONFLICT DO NOTHING so they're idempotent and
-- Ed's later config changes via admin UI aren't overwritten.
-- ============================================================================

-- LAKES OF PINE FOREST: arc (community-paid) + pool_amenity (variable fee)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'community', NULL,
       'community', 'manual',
       '{"notice_days_required": 45, "review_committee": "Architectural Control Committee"}'::jsonb,
       'Community contract — billed monthly via management agreement'
FROM communities c WHERE c.name ILIKE 'Lakes of Pine Forest%'
ON CONFLICT (community_id, service_type) DO NOTHING;

INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'pool_amenity', 'POOL',
       25.00, 'owner', 'First fob included with residency; replacement fobs $25 each',
       'community', 'manual',
       '{"first_unit_free": true, "replacement_fee_usd": 25}'::jsonb
FROM communities c WHERE c.name ILIKE 'Lakes of Pine Forest%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- EAGLEWOOD: arc (community-paid) + pool_amenity (variable fee)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'community', NULL,
       'community', 'manual',
       '{"notice_days_required": 14, "review_committee": "Architectural Control Committee"}'::jsonb,
       'Community contract — billed monthly via management agreement'
FROM communities c WHERE c.name ILIKE 'Eaglewood%'
ON CONFLICT (community_id, service_type) DO NOTHING;

INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'pool_amenity', 'POOL',
       25.00, 'owner', 'First fob included with residency; replacement fobs $25 each',
       'community', 'manual',
       '{"first_unit_free": true, "replacement_fee_usd": 25}'::jsonb
FROM communities c WHERE c.name ILIKE 'Eaglewood%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- WATERVIEW ESTATES: arc (community-paid) + pool_amenity (variable fee, key fob)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'community', NULL,
       'community', 'manual',
       '{"notice_days_required": 30, "review_committee": "Architectural Control Committee"}'::jsonb,
       'Community contract — billed monthly via management agreement'
FROM communities c WHERE c.name ILIKE 'Waterview%'
ON CONFLICT (community_id, service_type) DO NOTHING;

INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'pool_amenity', 'POOL',
       25.00, 'owner', 'First key fob included with residency; replacement key fobs $25 each',
       'community', 'manual',
       '{"first_unit_free": true, "replacement_fee_usd": 25}'::jsonb
FROM communities c WHERE c.name ILIKE 'Waterview%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- QUAIL RIDGE: arc only (grandfathered, no charge anywhere — kept silent on UI)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'free', NULL,
       'community', 'manual',
       '{"notice_days_required": 30, "review_committee": "Architectural Control Committee"}'::jsonb,
       'Grandfathered — Bedrock absorbs cost of ARC review at no charge to community. Internal-only — do not surface to owner or community in communications.'
FROM communities c WHERE c.name ILIKE 'Quail Ridge%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- STILL CREEK RANCH: arc only (developer-active community)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'community', NULL,
       'community', 'manual',
       '{"notice_days_required": 30, "review_committee": "Architectural Control Committee", "developer_active": true}'::jsonb,
       'Developer-active community — new addresses added periodically as houses are built. Sync address list with developer sales office.'
FROM communities c WHERE c.name ILIKE 'Still Creek Ranch%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- AUGUST MEADOWS: arc only (developer-active community)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'community', NULL,
       'community', 'manual',
       '{"notice_days_required": 30, "review_committee": "Architectural Control Committee", "developer_active": true}'::jsonb,
       'Developer-active community — new addresses added periodically as houses are built. Sync address list with developer sales office.'
FROM communities c WHERE c.name ILIKE 'August Meadows%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- CANYON GATE: arc only seeded; pool_amenity / gate_vehicle / gym_access deferred
-- to admin UI (Ed populates once full service list is finalized — see Phase 1.5)
INSERT INTO community_services (management_company_id, community_id, service_type, service_reference_suffix,
                                application_fee_usd, paid_by, fee_structure_notes,
                                revenue_destination, payment_provider, service_config,
                                internal_billing_notes)
SELECT '00000000-0000-0000-0000-000000000001', c.id, 'arc', 'ARC',
       NULL, 'community', NULL,
       'community', 'manual',
       '{"notice_days_required": 30, "review_committee": "Architectural Control Committee"}'::jsonb,
       'Most service-complex community — pool fob, vehicle gate, gym access TBD. Ed to configure via admin UI when full service list is enumerated.'
FROM communities c WHERE c.name ILIKE 'Canyon Gate%'
ON CONFLICT (community_id, service_type) DO NOTHING;

-- ============================================================================
-- VERIFY (run as separate queries after applying):
--
--   SELECT c.name, c.reference_prefix, c.slug
--     FROM communities c
--    WHERE c.management_company_id = '00000000-0000-0000-0000-000000000001'
--    ORDER BY c.name;
--   -- expect all 7 communities to have reference_prefix populated
--
--   SELECT c.name, cs.service_type, cs.enabled, cs.paid_by,
--          cs.application_fee_usd, cs.fee_structure_notes
--     FROM community_services cs
--     JOIN communities c ON c.id = cs.community_id
--    WHERE cs.management_company_id = '00000000-0000-0000-0000-000000000001'
--    ORDER BY c.name, cs.service_type;
--   -- expect rows for each community per the seed table
--
--   SELECT COUNT(*) FROM community_applications;     -- 0 (fresh tables)
--   SELECT COUNT(*) FROM community_addresses;        -- 0 (Ed imports separately)
--
-- ============================================================================
