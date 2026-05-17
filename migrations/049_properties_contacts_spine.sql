-- ============================================================================
-- 049_properties_contacts_spine.sql
-- ----------------------------------------------------------------------------
-- The data spine for every home in every Bedrock community. Properties are
-- the permanent backbone — every address that exists in a community gets one
-- row that lives forever. Contacts (people) are role-agnostic; ownership and
-- residency are time-bounded relationship tables, so historical queries
-- ("who owned this in 2022?", "rental ratio at LPF over time?") become a
-- single index lookup instead of audit-log archaeology.
--
-- Existing tables that intentionally stay separate for now (to be folded in
-- a later migration once this spine is in active use):
--   board_members (migration 037) — board roster. Tracks term dates + roles.
--     Future migration will reconcile contact_id <-> board_member rows.
--   nominations (migration 034) — annual-meeting candidates. Already keyed
--     by nominee_name + address; resolves to contact via name match later.
--   community_facts (migration 023) — vendor contacts etc. Different scope.
--
-- The Vantaca-sync model: every upload writes a vantaca_sync_log row with
-- the parsed data + computed diff. Nothing applies until staff explicitly
-- approves via the apply endpoint. This is the safety net — bad CSV doesn't
-- silently corrupt three years of records.
--
-- Apply AFTER 048. Idempotent.
-- ============================================================================

BEGIN;

-- ============================================================================
-- properties — the spine. One row per home, forever.
-- ============================================================================
CREATE TABLE IF NOT EXISTS properties (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          UUID NOT NULL REFERENCES communities(id),
  street_address        TEXT NOT NULL,
  unit                  TEXT NULL,
  city                  TEXT NULL,
  state                 TEXT NOT NULL DEFAULT 'TX',
  zip                   TEXT NULL,
  property_type         TEXT NULL,     -- 'sfh','townhouse','condo','duplex', etc.
  lot_number            TEXT NULL,     -- for HOAs with platted-lot identifiers
  vantaca_account_id    TEXT NULL,     -- key for sync — matches Vantaca row to our property
  notes                 TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, street_address, unit)
);

CREATE INDEX IF NOT EXISTS idx_properties_community
  ON properties (community_id, street_address);
CREATE INDEX IF NOT EXISTS idx_properties_vantaca
  ON properties (vantaca_account_id)
  WHERE vantaca_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_address_search
  ON properties (community_id, lower(street_address));

-- ============================================================================
-- contacts — people, role-agnostic. Mary Smith stays one row forever even
-- if she's a current owner at A, former owner at B, board member at C.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contacts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             TEXT NOT NULL,
  preferred_name        TEXT NULL,
  primary_email         TEXT NULL,
  primary_phone         TEXT NULL,
  secondary_email       TEXT NULL,
  secondary_phone       TEXT NULL,
  mailing_address       TEXT NULL,     -- if different from any property they own
  vantaca_account_id    TEXT NULL,     -- if synced from Vantaca
  notes                 TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_name
  ON contacts (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_contacts_email
  ON contacts (lower(primary_email))
  WHERE primary_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_vantaca
  ON contacts (vantaca_account_id)
  WHERE vantaca_account_id IS NOT NULL;

-- ============================================================================
-- property_ownerships — time-bounded owner-of-record relationships.
-- end_date NULL = current owner. Multiple rows possible (joint vesting,
-- ownership transfers create a new row).
-- ============================================================================
CREATE TABLE IF NOT EXISTS property_ownerships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  start_date      DATE NOT NULL,
  end_date        DATE NULL,
  vesting         TEXT NULL,          -- 'sole','joint','trust','LLC','tenancy_in_common', etc.
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,  -- when multiple owners, marks the primary contact
  source          TEXT NULL,          -- 'vantaca_import','manual','title_transfer', etc.
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ownerships_property_current
  ON property_ownerships (property_id, end_date NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_ownerships_contact
  ON property_ownerships (contact_id);

-- ============================================================================
-- property_residencies — time-bounded who-actually-lives-there. Compared
-- against ownerships, instantly tells you owner-occupied vs renter vs vacant.
-- For renters, the lease tracking fields let us mail expiration reminders
-- and surface lease-end-date in the property detail view.
-- ============================================================================
CREATE TABLE IF NOT EXISTS property_residencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  contact_id      UUID NULL REFERENCES contacts(id) ON DELETE RESTRICT,  -- NULL when vacant
  start_date      DATE NOT NULL,
  end_date        DATE NULL,
  residency_type  TEXT NOT NULL CHECK (residency_type IN ('owner_occupied','renter','family_member','vacant','unknown')),
  lease_end_date  DATE NULL,
  lease_pdf_path  TEXT NULL,          -- Supabase storage path to the uploaded lease PDF
  source          TEXT NULL,
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_residencies_property_current
  ON property_residencies (property_id, end_date NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_residencies_lease_expiring
  ON property_residencies (lease_end_date)
  WHERE lease_end_date IS NOT NULL AND residency_type = 'renter';

-- ============================================================================
-- vantaca_sync_log — every upload writes a row here BEFORE any data is
-- applied. The "preview diff" appears in diff_summary; the staff member
-- explicitly approves via the apply endpoint which fills applied_summary.
-- Nothing is destructive until apply succeeds.
-- ============================================================================
CREATE TABLE IF NOT EXISTS vantaca_sync_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NULL REFERENCES communities(id),  -- NULL when multi-community upload
  uploaded_by       TEXT NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_name         TEXT NULL,
  total_rows        INTEGER NOT NULL DEFAULT 0,
  column_mapping    JSONB NULL,           -- detected column-to-field mapping
  parsed_data       JSONB NULL,           -- all parsed rows (the raw evidence)
  diff_summary      JSONB NULL,           -- structured diff: new/updated/changed counts + per-row detail
  applied_at        TIMESTAMPTZ NULL,
  applied_by        TEXT NULL,
  applied_summary   JSONB NULL,           -- what actually got committed
  status            TEXT NOT NULL DEFAULT 'previewed'
                      CHECK (status IN ('previewed','applied','discarded')),
  notes             TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_vantaca_sync_community
  ON vantaca_sync_log (community_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_vantaca_sync_status
  ON vantaca_sync_log (status, uploaded_at DESC);

-- ============================================================================
-- Helpful views for the common queries.
-- ============================================================================

-- Current owner per property — one row per property, latest non-ended ownership.
-- For joint ownership, returns the row marked is_primary, falling back to
-- earliest start_date if no primary flag.
CREATE OR REPLACE VIEW v_current_property_owners AS
SELECT DISTINCT ON (p.id)
  p.id              AS property_id,
  p.community_id,
  p.street_address,
  p.unit,
  p.city,
  p.state,
  p.zip,
  p.property_type,
  p.lot_number,
  c.id              AS owner_contact_id,
  c.full_name       AS owner_name,
  c.primary_email   AS owner_email,
  c.primary_phone   AS owner_phone,
  c.mailing_address AS owner_mailing_address,
  o.start_date      AS owned_since,
  o.vesting,
  o.is_primary
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST;

-- Current resident per property — same shape, time-keyed by residency.
CREATE OR REPLACE VIEW v_current_residents AS
SELECT DISTINCT ON (p.id)
  p.id              AS property_id,
  p.community_id,
  p.street_address,
  p.unit,
  c.id              AS resident_contact_id,
  c.full_name       AS resident_name,
  c.primary_email   AS resident_email,
  c.primary_phone   AS resident_phone,
  r.residency_type,
  r.start_date      AS resident_since,
  r.lease_end_date,
  r.lease_pdf_path
FROM properties p
LEFT JOIN property_residencies r ON r.property_id = p.id AND r.end_date IS NULL
LEFT JOIN contacts c             ON c.id = r.contact_id
ORDER BY p.id, r.start_date DESC NULLS LAST;

-- Owner-occupancy summary per community — counts owner_occupied vs renter
-- vs vacant vs unknown. Critical metric for Bedrock board reporting.
CREATE OR REPLACE VIEW v_owner_occupancy_summary AS
SELECT
  c.id   AS community_id,
  c.name AS community_name,
  COUNT(DISTINCT p.id)                                                AS total_properties,
  COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type = 'owner_occupied') AS owner_occupied_count,
  COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type = 'renter')         AS renter_count,
  COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type = 'vacant')         AS vacant_count,
  COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type = 'family_member')  AS family_member_count,
  COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type IS NULL OR r.residency_type = 'unknown') AS unknown_count,
  ROUND(100.0 * COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type = 'owner_occupied')
        / NULLIF(COUNT(DISTINCT p.id), 0), 1) AS owner_occupied_pct,
  ROUND(100.0 * COUNT(DISTINCT p.id) FILTER (WHERE r.residency_type = 'renter')
        / NULLIF(COUNT(DISTINCT p.id), 0), 1) AS renter_pct
FROM communities c
LEFT JOIN properties p             ON p.community_id = c.id
LEFT JOIN property_residencies r   ON r.property_id = p.id AND r.end_date IS NULL
GROUP BY c.id, c.name;

GRANT SELECT, INSERT, UPDATE, DELETE ON properties              TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts                TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON property_ownerships     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON property_residencies    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON vantaca_sync_log        TO service_role;
GRANT SELECT ON v_current_property_owners      TO service_role;
GRANT SELECT ON v_current_residents            TO service_role;
GRANT SELECT ON v_owner_occupancy_summary      TO service_role;

COMMIT;

-- Verify:
--   SELECT * FROM v_owner_occupancy_summary;
--   SELECT * FROM v_current_property_owners LIMIT 5;
--   SELECT status, COUNT(*) FROM vantaca_sync_log GROUP BY status;
