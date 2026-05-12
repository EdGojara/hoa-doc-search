-- ============================================================================
-- 026_roster_and_preregistration.sql
-- ----------------------------------------------------------------------------
-- Adds the Vantaca-imported homeowner roster + pre-registration / check-in
-- features for events:
--
--   community_homeowners   per-community roster, imported from Vantaca export
--   event_signatures gets: party_size, additional_attendee_names,
--                          homeowner_id, pre_registered_at, checked_in_by
--   events gets:           staff_checkin_code (6-digit gate for staff page)
--
-- Apply AFTER 025b. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. community_homeowners — the roster
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS community_homeowners (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id   UUID NOT NULL REFERENCES management_companies(id),
  community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  -- Identity (any of these can be the dedup key)
  first_name              TEXT,
  last_name               TEXT,
  full_name               TEXT,                                  -- denormalized: first + ' ' + last
  address                 TEXT,
  address_normalized      TEXT,                                  -- lowercase + collapsed whitespace for matching
  unit                    TEXT,                                  -- apt/unit/suite if applicable
  email                   TEXT,
  phone                   TEXT,

  -- Vantaca / external system identifiers (for re-import without duplication)
  vantaca_id              TEXT,                                  -- account / member id from Vantaca
  external_id             TEXT,                                  -- generic external id if not Vantaca
  account_status          TEXT,                                  -- 'active' | 'past_due' | 'inactive' | 'closed'
  is_owner_occupied       BOOLEAN,
  household_size_hint     INTEGER,                               -- "how many in this household" if Vantaca exposes it

  -- Audit / sync
  last_synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                  TEXT NOT NULL DEFAULT 'vantaca_import'
                            CHECK (source IN ('vantaca_import', 'csv_upload', 'manual', 'api')),
  notes                   TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup by (community, vantaca_id) when vantaca_id exists — that's the strong key.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_community_homeowners_vantaca
  ON community_homeowners (community_id, vantaca_id) WHERE vantaca_id IS NOT NULL;
-- Soft dedup by address as fallback (warn rather than block — apartments share addresses)
CREATE INDEX IF NOT EXISTS idx_community_homeowners_address
  ON community_homeowners (community_id, address_normalized) WHERE address_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_homeowners_email
  ON community_homeowners (community_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_homeowners_name
  ON community_homeowners (community_id, lower(last_name), lower(first_name));

DROP TRIGGER IF EXISTS trg_community_homeowners_updated_at ON community_homeowners;
CREATE TRIGGER trg_community_homeowners_updated_at
  BEFORE UPDATE ON community_homeowners
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. event_signatures — extend for pre-registration + party_size + staff check-in
-- ----------------------------------------------------------------------------

ALTER TABLE event_signatures
  ADD COLUMN IF NOT EXISTS party_size                 INTEGER,
  ADD COLUMN IF NOT EXISTS additional_attendee_names  JSONB,        -- array of strings: ["Sarah Smith", "Jacob Smith"]
  ADD COLUMN IF NOT EXISTS homeowner_id               UUID REFERENCES community_homeowners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pre_registered_at          TIMESTAMPTZ,  -- when they signed up before event (null = walk-up at door)
  ADD COLUMN IF NOT EXISTS checked_in_by              TEXT;         -- staff identifier (free text for now)

CREATE INDEX IF NOT EXISTS idx_event_signatures_homeowner
  ON event_signatures(homeowner_id) WHERE homeowner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_signatures_pre_reg
  ON event_signatures(event_id, pre_registered_at) WHERE pre_registered_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. events — staff_checkin_code (6-digit gate) + computed pre-reg metrics view
-- ----------------------------------------------------------------------------

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS staff_checkin_code         TEXT,
  ADD COLUMN IF NOT EXISTS pre_registration_enabled   BOOLEAN NOT NULL DEFAULT TRUE;

-- ----------------------------------------------------------------------------
-- 4. v_event_attendance — REPLACE with party-size aware aggregates
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_event_attendance AS
SELECT
  e.id          AS event_id,
  e.community_id,
  e.name        AS event_name,
  e.scheduled_start_at,
  COUNT(s.id)                                                AS signatures_count,
  COUNT(s.id) FILTER (WHERE s.is_homeowner)                  AS homeowner_count,
  COUNT(s.id) FILTER (WHERE NOT s.is_homeowner)              AS guest_count,
  COUNT(s.id) FILTER (WHERE s.is_minor)                      AS minor_count,
  -- New pre-reg / check-in metrics
  COUNT(s.id) FILTER (WHERE s.pre_registered_at IS NOT NULL) AS pre_registered_count,
  COUNT(s.id) FILTER (WHERE s.pre_registered_at IS NULL)     AS walkup_count,
  COUNT(s.id) FILTER (WHERE s.checked_in_at IS NOT NULL)     AS checked_in_count,
  -- Total people including party size (so "87 households / 231 people")
  COALESCE(SUM(COALESCE(s.party_size, 1)), 0)                AS total_people_registered,
  COALESCE(SUM(COALESCE(s.party_size, 1))
    FILTER (WHERE s.checked_in_at IS NOT NULL), 0)           AS total_people_checked_in
FROM events e
LEFT JOIN event_signatures s ON s.event_id = e.id
GROUP BY e.id, e.community_id, e.name, e.scheduled_start_at;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT COUNT(*) FROM community_homeowners;
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='event_signatures' AND column_name IN
--       ('party_size','homeowner_id','pre_registered_at','checked_in_by');
--   SELECT * FROM v_event_attendance LIMIT 3;
-- ----------------------------------------------------------------------------
