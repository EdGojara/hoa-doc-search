-- ============================================================================
-- 050_drv_and_memory_foundation.sql
-- ----------------------------------------------------------------------------
-- Schema foundation for the DRV (Deed Restriction Violation) module AND the
-- memory layer that sits underneath it. These two builds share a data model
-- because letters, observations, and history all flow through one corpus.
--
-- What this migration creates (in dependency order):
--   1. Extensions: PostGIS (for property polygon matching during inspections)
--                  pgvector (for semantic retrieval against the interaction
--                  corpus — embedding column exists today; population is a
--                  background job built later)
--   2. ALTER properties to add boundary polygon + lat/lng
--   3. common_areas             — amenities/zones that get inspected
--   4. enforcement_categories   — canonical list (trees, mildew, lawn, etc.),
--                                 seeded with 21 standard categories
--   5. community_enforcement_priorities — per-community per-category weight,
--                                 time-bounded (board recalibration surface),
--                                 seeded with 'standard' for every (community,
--                                 category) pair so queries always find a row
--   6. inspections              — drive events / walk-through sessions
--   7. inspection_photos        — raw captures with GPS + heading + verification
--                                 metadata (5-signal wrong-house defense)
--   8. property_observations    — AI output per photo, supervisor-reviewable
--   9. violations               — case file (only when observation escalates)
--  10. interactions             — ALL communications (letters, emails, calls,
--                                 in-person notes); single source of truth for
--                                 every property/contact history
--  11. corrections              — links a flagged interaction to what should
--                                 have been said (negative example + positive
--                                 precedent paired)
--  12. fine_posting_queue       — admin batch surface; assessed fines wait here
--                                 to be posted to Vantaca GL
--
-- What this migration does NOT do (intentional, deferred):
--   - Common-areas seeding per community: data import per community, separate.
--   - Harris County parcel polygon import: separate data-import script.
--   - Vector embedding population: background job, built later.
--   - Views: query-pattern-driven, add when usage patterns emerge.
--   - RLS policies: deferred until auth model fully landed.
--
-- Apply AFTER 049. Idempotent (CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- ============================================================================

BEGIN;

-- ============================================================================
-- Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- ALTER properties — add geographic columns for inspection-time matching.
-- boundary: parcel polygon (loaded later from Harris County GIS data, per-
-- community). latitude/longitude: centroid for proximity queries when no
-- polygon yet.
-- ============================================================================
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS boundary  GEOGRAPHY(POLYGON, 4326) NULL,
  ADD COLUMN IF NOT EXISTS latitude  NUMERIC(10, 7) NULL,
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 7) NULL;

-- GIST index for spatial queries (point-in-polygon, nearest-property).
CREATE INDEX IF NOT EXISTS idx_properties_boundary_gist
  ON properties USING GIST (boundary)
  WHERE boundary IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_centroid
  ON properties (community_id, latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;


-- ============================================================================
-- common_areas — amenities and zones within a community that get inspected.
-- Distinct from properties (which are homeowner-owned lots). Examples:
-- playgrounds, pools, monument signs, gates, common landscape zones,
-- mailbox clusters, retention ponds.
-- ============================================================================
CREATE TABLE IF NOT EXISTS common_areas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        UUID NOT NULL REFERENCES communities(id),
  area_type           TEXT NOT NULL,  -- 'playground','pool','gate','monument_sign','landscape_zone','mailbox_cluster','retention_pond','common_landscape','other'
  name                TEXT NOT NULL,  -- e.g. "North entrance playground", "Clubhouse pool"
  location_description TEXT NULL,
  latitude            NUMERIC(10, 7) NULL,
  longitude           NUMERIC(10, 7) NULL,
  boundary            GEOGRAPHY(POLYGON, 4326) NULL,
  current_condition_score INTEGER NULL CHECK (current_condition_score BETWEEN 1 AND 10),
  last_inspected_at   TIMESTAMPTZ NULL,
  notes               TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_common_areas_community
  ON common_areas (community_id, area_type);


-- ============================================================================
-- enforcement_categories — the canonical list of conditions trustEd will flag
-- during inspections and enforce against. Seeded below with 21 standard
-- categories. New categories can be added without migrations.
-- ============================================================================
CREATE TABLE IF NOT EXISTS enforcement_categories (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     TEXT NOT NULL UNIQUE,  -- machine-friendly key, e.g. 'tree_overgrowth'
  label                    TEXT NOT NULL,         -- human-readable, e.g. 'Tree overgrowth'
  description              TEXT NULL,             -- what the AI/inspector looks for
  default_priority_weight  TEXT NOT NULL DEFAULT 'standard'
                             CHECK (default_priority_weight IN ('standard','elevated','aggressive','disabled')),
  display_order            INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enforcement_categories_order
  ON enforcement_categories (display_order, slug);


-- ============================================================================
-- community_enforcement_priorities — per-community per-category weight, time-
-- bounded so board recalibrations preserve history. The unique partial index
-- enforces "exactly one active row per (community, category)".
--
-- end_date NULL = currently active. To change a priority: end-date the old
-- row, insert a new one with the new weight + board vote ref.
-- ============================================================================
CREATE TABLE IF NOT EXISTS community_enforcement_priorities (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id),
  category_id              UUID NOT NULL REFERENCES enforcement_categories(id),
  priority_weight          TEXT NOT NULL
                             CHECK (priority_weight IN ('standard','elevated','aggressive','disabled')),
  start_date               DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date                 DATE NULL,
  set_by_board_vote_date   DATE NULL,
  board_meeting_minutes_ref TEXT NULL,  -- e.g. "Eaglewood 2026-04-15 Annual Meeting, Item 7"
  set_by_user_id           UUID NULL,
  notes                    TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly one currently-active priority per (community, category).
CREATE UNIQUE INDEX IF NOT EXISTS idx_priorities_one_active_per_pair
  ON community_enforcement_priorities (community_id, category_id)
  WHERE end_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_priorities_lookup
  ON community_enforcement_priorities (community_id, category_id, end_date NULLS FIRST);


-- ============================================================================
-- inspections — a drive event or walkthrough session. One row per visit;
-- many photos hang off it. Tracks who, when, what mode, what route.
-- ============================================================================
CREATE TABLE IF NOT EXISTS inspections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    UUID NOT NULL REFERENCES communities(id),
  operator_id     UUID NULL,  -- user that conducted the inspection
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ NULL,
  mode            TEXT NOT NULL DEFAULT 'foot'
                    CHECK (mode IN ('foot','drive_by','mounted_camera','spot_check')),
  route_label     TEXT NULL,    -- 'full_community','street_X','complaint_followup', etc.
  total_photos    INTEGER NOT NULL DEFAULT 0,
  total_observations INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','captured','ai_analyzed','reviewed','closed','voided')),
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspections_community_started
  ON inspections (community_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspections_status
  ON inspections (status, started_at DESC);


-- ============================================================================
-- inspection_photos — raw captures from the field. Each photo carries five
-- independent signals for wrong-house verification:
--   1. gps_lat, gps_lng (where the camera was)
--   2. compass_heading (which way it was pointing)
--   3. polygon_match_property_id (parcel polygon intersection from GPS+heading)
--   4. ai_detected_house_number (Claude vision reads the address plaque/curb)
--   5. reviewer_confirmed_property_id (human catches the rare disagreement)
-- address_confidence_score is the aggregate: high = all signals agree.
-- ============================================================================
CREATE TABLE IF NOT EXISTS inspection_photos (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id                 UUID NOT NULL REFERENCES inspections(id) ON DELETE RESTRICT,
  storage_path                  TEXT NOT NULL,         -- supabase storage ref
  captured_at                   TIMESTAMPTZ NOT NULL,  -- from EXIF or upload time
  gps_lat                       NUMERIC(10, 7) NULL,
  gps_lng                       NUMERIC(10, 7) NULL,
  gps_accuracy_m                NUMERIC(8, 2) NULL,    -- meters, from device
  compass_heading_deg           NUMERIC(6, 2) NULL,    -- 0-360, compass direction
  capture_geo                   GEOGRAPHY(POINT, 4326) NULL,  -- derived from gps_lat/lng
  polygon_match_property_id     UUID NULL REFERENCES properties(id) ON DELETE SET NULL,
  ai_detected_house_number      TEXT NULL,             -- 'unknown' if AI couldn't read it
  address_confidence_score      NUMERIC(4, 3) NULL CHECK (address_confidence_score BETWEEN 0 AND 1),
  reviewer_confirmed_property_id UUID NULL REFERENCES properties(id) ON DELETE SET NULL,
  reviewer_user_id              UUID NULL,
  reviewed_at                   TIMESTAMPTZ NULL,
  notes                         TEXT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspection_photos_inspection
  ON inspection_photos (inspection_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_inspection_photos_property_match
  ON inspection_photos (polygon_match_property_id)
  WHERE polygon_match_property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inspection_photos_geo_gist
  ON inspection_photos USING GIST (capture_geo)
  WHERE capture_geo IS NOT NULL;


-- ============================================================================
-- property_observations — AI output per photo. One photo can produce multiple
-- observations (a single house photo might flag "lawn height" and "fence
-- damage" as two separate observations). Most observations never escalate to
-- violations — clean houses get observations too ("no issues") for the record.
-- ============================================================================
CREATE TABLE IF NOT EXISTS property_observations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id         UUID NOT NULL REFERENCES inspections(id) ON DELETE RESTRICT,
  inspection_photo_id   UUID NOT NULL REFERENCES inspection_photos(id) ON DELETE RESTRICT,
  property_id           UUID NULL REFERENCES properties(id) ON DELETE RESTRICT,
  common_area_id        UUID NULL REFERENCES common_areas(id) ON DELETE RESTRICT,
  community_id          UUID NOT NULL REFERENCES communities(id),
  category_id           UUID NULL REFERENCES enforcement_categories(id),
  severity              TEXT NULL
                          CHECK (severity IN ('clean','minor','moderate','severe')),
  ai_description        TEXT NULL,             -- what the AI saw
  ai_recommended_action TEXT NULL,             -- what the AI suggests (no action / courtesy / etc.)
  ai_confidence         TEXT NULL
                          CHECK (ai_confidence IN ('low','medium','high')),
  reviewer_status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK (reviewer_status IN ('pending','confirmed','rejected','deferred')),
  reviewer_user_id      UUID NULL,
  reviewer_notes        TEXT NULL,
  reviewed_at           TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Either property_id or common_area_id should be set (XOR-ish; we enforce
  -- at-least-one but not exclusivity since a fence between a property and a
  -- common area could conceivably be both).
  CONSTRAINT chk_observation_target
    CHECK (property_id IS NOT NULL OR common_area_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_observations_property_recent
  ON property_observations (property_id, created_at DESC)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_common_area
  ON property_observations (common_area_id, created_at DESC)
  WHERE common_area_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_inspection
  ON property_observations (inspection_id, reviewer_status);
CREATE INDEX IF NOT EXISTS idx_observations_pending_review
  ON property_observations (community_id, reviewer_status, created_at DESC)
  WHERE reviewer_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_observations_category
  ON property_observations (community_id, category_id, created_at DESC)
  WHERE category_id IS NOT NULL;


-- ============================================================================
-- violations — the case file. Only created when an observation rises to
-- enforcement (i.e., reviewer confirmed + severity meets threshold given the
-- current community priority for that category). State machine: courtesy_1
-- → courtesy_2 → certified_209 → fine_assessed → cured/closed.
-- ============================================================================
CREATE TABLE IF NOT EXISTS violations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                 UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  community_id                UUID NOT NULL REFERENCES communities(id),
  opened_from_observation_id  UUID NULL REFERENCES property_observations(id) ON DELETE SET NULL,
  primary_category_id         UUID NOT NULL REFERENCES enforcement_categories(id),
  -- Snapshot of the community priority for this category at the moment the
  -- violation was opened. Preserves the "why was this enforced" answer even
  -- if the board recalibrates later.
  board_priority_at_open      TEXT NOT NULL
                                CHECK (board_priority_at_open IN ('standard','elevated','aggressive')),
  current_stage               TEXT NOT NULL DEFAULT 'courtesy_1'
                                CHECK (current_stage IN ('courtesy_1','courtesy_2','certified_209','fine_assessed','cured','closed','voided')),
  current_stage_started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cure_period_ends_at         TIMESTAMPTZ NULL,
  opened_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by_user_id           UUID NULL,
  resolved_at                 TIMESTAMPTZ NULL,
  resolved_via                TEXT NULL
                                CHECK (resolved_via IN ('cured','fine','withdrawn','voided')),
  resolved_notes              TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violations_property
  ON violations (property_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_violations_community_open
  ON violations (community_id, current_stage, opened_at DESC)
  WHERE current_stage NOT IN ('cured','closed','voided');
CREATE INDEX IF NOT EXISTS idx_violations_cure_period
  ON violations (cure_period_ends_at)
  WHERE cure_period_ends_at IS NOT NULL
    AND current_stage NOT IN ('cured','closed','voided');


-- ============================================================================
-- interactions — the memory layer foundation. Every email, letter, call, in-
-- person note logged here. Single source of truth for all property/contact
-- history. Letters generated by the DRV workflow live here, tagged with
-- violation_id. Future memory layer features (history-aware Draft mode,
-- corrections workflow, vector retrieval) all build on this table.
-- ============================================================================
CREATE TABLE IF NOT EXISTS interactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          UUID NOT NULL REFERENCES communities(id),
  property_id           UUID NULL REFERENCES properties(id) ON DELETE RESTRICT,
  contact_id            UUID NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  common_area_id        UUID NULL REFERENCES common_areas(id) ON DELETE RESTRICT,
  violation_id          UUID NULL REFERENCES violations(id) ON DELETE SET NULL,
  inspection_id         UUID NULL REFERENCES inspections(id) ON DELETE SET NULL,
  observation_id        UUID NULL REFERENCES property_observations(id) ON DELETE SET NULL,

  -- What kind of interaction
  type                  TEXT NOT NULL CHECK (type IN (
                          'email_inbound','email_outbound',
                          'letter_courtesy_1','letter_courtesy_2','letter_209',
                          'letter_other','phone','in_person','sms',
                          'board_communication','vendor_communication',
                          'ai_draft','observation_note','internal_note'
                        )),
  direction             TEXT NULL CHECK (direction IN ('inbound','outbound','internal')),

  -- The content + metadata
  subject               TEXT NULL,
  content               TEXT NULL,
  delivery_method       TEXT NULL CHECK (delivery_method IN (
                          'email','first_class_mail','certified_mail',
                          'in_person','phone','sms','portal','other'
                        )),
  certified_tracking_number TEXT NULL,
  attachments           JSONB NULL,           -- [{type, storage_path, label}, ...]

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'sent'
                          CHECK (status IN ('draft','approved','sent','rejected','received')),
  sent_at               TIMESTAMPTZ NULL,
  sent_by_user_id       UUID NULL,
  received_at           TIMESTAMPTZ NULL,

  -- AI provenance
  ai_drafted            BOOLEAN NOT NULL DEFAULT FALSE,
  ai_model              TEXT NULL,            -- 'claude-sonnet-4-6', etc.
  supervisor_approved_by UUID NULL,
  supervisor_approved_at TIMESTAMPTZ NULL,

  -- Quality + outcome (memory layer signals)
  quality_status        TEXT NOT NULL DEFAULT 'unreviewed'
                          CHECK (quality_status IN ('validated','unreviewed','flagged')),
  outcome               TEXT NULL CHECK (outcome IN (
                          'resolved','escalated','complaint','unresolved','pending'
                        )),

  -- Provenance for backfill vs forward-flow
  source                TEXT NOT NULL DEFAULT 'forward'
                          CHECK (source IN (
                            'forward','m365_backfill','vantaca_import',
                            'acc_history_migration','pdf_ocr','manual'
                          )),
  original_external_id  TEXT NULL,            -- for dedup across backfills
  confidence_score      NUMERIC(4, 3) NULL CHECK (confidence_score BETWEEN 0 AND 1),

  -- Semantic retrieval (populated by background job; nullable today)
  embedding             vector(1536) NULL,

  notes                 TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interactions_property_history
  ON interactions (community_id, property_id, sent_at DESC NULLS LAST)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interactions_contact_history
  ON interactions (community_id, contact_id, sent_at DESC NULLS LAST)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interactions_community_recent
  ON interactions (community_id, sent_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_interactions_violation
  ON interactions (violation_id, sent_at)
  WHERE violation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interactions_quality
  ON interactions (community_id, quality_status, sent_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_interactions_external_dedup
  ON interactions (source, original_external_id)
  WHERE original_external_id IS NOT NULL;
-- Vector index added separately AFTER embeddings start being populated
-- (creating an empty HNSW/IVFFLAT index on an unpopulated column is
-- wasteful; we'll add it in a later migration once data is flowing).


-- ============================================================================
-- corrections — pairs a flagged interaction with what should have been said.
-- Every mistake becomes a paired learning event: a negative example
-- (original_interaction_id) and a positive precedent (corrected_response +
-- linked_playbook_entry_id).
-- ============================================================================
CREATE TABLE IF NOT EXISTS corrections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_interaction_id  UUID NOT NULL REFERENCES interactions(id) ON DELETE RESTRICT,
  correction_type          TEXT NOT NULL CHECK (correction_type IN (
                             'wrong_approach','wrong_information',
                             'wrong_tone','policy_violation','outdated_advice','other'
                           )),
  what_went_wrong          TEXT NULL,        -- short summary of the issue
  corrected_response       TEXT NULL,        -- what should have been said
  linked_playbook_entry_id UUID NULL,        -- playbook entry codifying the right answer
  created_by_user_id       UUID NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corrections_original
  ON corrections (original_interaction_id);


-- ============================================================================
-- fine_posting_queue — when a violation hits fine_assessed stage, an entry
-- lands here for an admin to post into Vantaca's GL. The decoupling is
-- intentional: the operating system (trustEd) doesn't need Vantaca to be up
-- to keep working, and the admin batches the postings once or twice a week.
-- ============================================================================
CREATE TABLE IF NOT EXISTS fine_posting_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id        UUID NOT NULL REFERENCES violations(id) ON DELETE RESTRICT,
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  community_id        UUID NOT NULL REFERENCES communities(id),
  amount              NUMERIC(10, 2) NOT NULL,
  assessed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessed_by_user_id UUID NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','posted','reversed','error')),
  posted_to_vantaca_at TIMESTAMPTZ NULL,
  posted_by_user_id   UUID NULL,
  vantaca_charge_ref  TEXT NULL,             -- the Vantaca-side identifier after posting
  error_message       TEXT NULL,
  notes               TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fine_queue_status
  ON fine_posting_queue (status, assessed_at);
CREATE INDEX IF NOT EXISTS idx_fine_queue_community
  ON fine_posting_queue (community_id, status, assessed_at DESC);


-- ============================================================================
-- Seed: enforcement_categories. Canonical list of conditions trustEd flags.
-- Slugs are stable; labels can be edited via the admin UI later. New
-- categories can be added without a migration (just INSERT).
-- ============================================================================
INSERT INTO enforcement_categories (slug, label, description, display_order)
VALUES
  ('tree_overgrowth',          'Tree overgrowth',           'Branches extending beyond property line; canopy encroachment', 10),
  ('tree_dead_dying',          'Dead or dying tree',        'Visible decline, dead limbs, hazard potential',                15),
  ('mildew_mold_visible',      'Mildew / mold (visible)',   'Mildew or mold on siding, roof, fence, or pavement',           20),
  ('lawn_height',              'Lawn height',               'Grass exceeds community maintenance standard',                  30),
  ('lawn_dead_patches',        'Lawn dead patches',         'Large dead or dirt patches in front yard',                      35),
  ('weeds',                    'Weeds',                     'Weed coverage in beds, driveway cracks, or lawn',               40),
  ('landscaping_overgrown',    'Landscaping overgrown',     'Overgrown beds, encroaching shrubs, blocked sidewalk',          45),
  ('paint_peeling',            'Paint peeling',             'Paint condition below standard on visible exterior',            50),
  ('siding_damage',            'Siding damage',             'Visible siding damage, missing pieces, weathering',             55),
  ('roof_damage',              'Roof damage',               'Missing shingles, debris, visible damage from street',          60),
  ('fence_damage',             'Fence damage',              'Damaged, leaning, or missing fence sections',                   65),
  ('fence_unauthorized',       'Unauthorized fence',        'Fence installed without ACC approval or out of compliance',     70),
  ('vehicle_inoperable',       'Inoperable vehicle',        'Vehicle without current registration, on blocks, or non-running',75),
  ('vehicle_commercial',       'Commercial vehicle',        'Commercial vehicle parked overnight per covenants',             80),
  ('vehicle_rv',               'RV / boat / trailer',       'RV, boat, or trailer parked in violation of covenants',         85),
  ('trash_visible',            'Trash bins visible',        'Trash bins visible from street outside collection window',     90),
  ('holiday_decorations_late', 'Holiday decorations',       'Holiday decorations remaining past seasonal deadline',         95),
  ('mailbox_damage',           'Mailbox condition',         'Damaged, missing, or non-conforming mailbox',                  100),
  ('unauthorized_modification','Unauthorized exterior mod', 'Visible exterior modification without ACC approval',           105),
  ('parking_violation',        'Parking violation',         'Vehicle parked in violation of community parking rules',       110),
  ('pet_violation',            'Pet violation',             'Pet outside leash/containment, waste left, etc.',              115)
ON CONFLICT (slug) DO NOTHING;


-- ============================================================================
-- Seed: community_enforcement_priorities. Default every (community, category)
-- pair to 'standard'. This means queries always find a row (no NULL handling
-- in the lookup path). Idempotent — only inserts pairs that don't already
-- have an active row.
-- ============================================================================
INSERT INTO community_enforcement_priorities
  (community_id, category_id, priority_weight, notes)
SELECT c.id, ec.id, 'standard', 'Default at migration 050 install'
FROM communities c
CROSS JOIN enforcement_categories ec
WHERE NOT EXISTS (
  SELECT 1 FROM community_enforcement_priorities cep
   WHERE cep.community_id = c.id
     AND cep.category_id  = ec.id
     AND cep.end_date IS NULL
);


-- ============================================================================
-- Grants — service_role only (the API service key). Anon access is gated
-- by application code at the endpoint level; no RLS yet.
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON common_areas                      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON enforcement_categories            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_enforcement_priorities  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON inspections                       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_photos                 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON property_observations             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON violations                        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON interactions                      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON corrections                       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON fine_posting_queue                TO service_role;

COMMIT;

-- Verify:
--   SELECT COUNT(*) FROM enforcement_categories;
--     -- 21
--   SELECT COUNT(*) FROM community_enforcement_priorities WHERE end_date IS NULL;
--     -- (number of communities) × 21
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'properties' AND column_name IN ('boundary','latitude','longitude');
--   SELECT extname FROM pg_extension WHERE extname IN ('postgis','vector');
