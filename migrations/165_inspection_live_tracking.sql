-- 165: Live multi-tablet inspection tracking — the substrate for Ed's
-- "show the inspectors on a map" + auto-start geofence + two-tablet support.
--
-- Builds on the existing `inspections` table (migration 050) which already
-- has community_id + mode='drive_by' + status='in_progress' + the route-trace
-- ping store. What's missing for LIVE tracking:
--   - office geofence config (auto-start phase 2; manual start works without)
--   - per-inspection device label + cached last_ping_at for fast active queries
--   - link from inspection to the office it started at (audit trail)
--
-- Record ownership (per CLAUDE.md):
--   - bedrock_offices: WORKPAPER. Operational config; not an HOA record.
--     Per-franchise-operator-instance data when the model scales.
--   - inspection columns added here: same as parent (workpaper) — the parent
--     inspection record itself stays workpaper until observations get
--     promoted to delivered (association_record by then).
--
-- Single-source-of-truth: ping data already lives in inspection_route_traces.
-- last_ping_at on inspections is a CACHE for fast "active drives" queries —
-- the canonical truth is the latest row in inspection_route_traces. The
-- ping endpoint writes both atomically.

BEGIN;

-- ---------------------------------------------------------------------------
-- bedrock_offices — geofence anchor points. One row per Bedrock office today
-- (Sugar Land); franchise model adds rows per operator office. The mgmt_co_id
-- FK ties each office to its operating company, so a franchise can only see
-- its own office's geofences.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock_offices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mgmt_co_id uuid,                          -- FK to management_companies; nullable for early seed
  name text NOT NULL,                       -- "Bedrock Sugar Land HQ"
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  geofence_radius_m integer NOT NULL DEFAULT 150
    CHECK (geofence_radius_m BETWEEN 25 AND 5000),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bedrock_offices_mgmt_co
  ON bedrock_offices(mgmt_co_id) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_bedrock_offices_updated_at ON bedrock_offices;
CREATE TRIGGER trg_bedrock_offices_updated_at
  BEFORE UPDATE ON bedrock_offices
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Seed the current Bedrock office. Coordinates approximate — the geofence
-- radius (150m) absorbs ~50m of imprecision; tighten the lat/lng later
-- when we put a tablet at the front desk and capture the precise reading.
-- 12808 W Airport Blvd Ste 253, Sugar Land, TX 77478
INSERT INTO bedrock_offices (mgmt_co_id, name, address_line1, city, state, postal_code, latitude, longitude, geofence_radius_m, notes)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Bedrock Sugar Land HQ',
  '12808 W Airport Blvd Ste 253',
  'Sugar Land',
  'TX',
  '77478',
  29.6243,
  -95.6258,
  150,
  'Initial coordinates approximate — refine by capturing a precise GPS reading from a tablet at the office front door.'
WHERE NOT EXISTS (
  SELECT 1 FROM bedrock_offices
  WHERE name = 'Bedrock Sugar Land HQ'
);

-- ---------------------------------------------------------------------------
-- inspections — additive columns for live tracking
-- ---------------------------------------------------------------------------
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS device_label text;          -- "Tablet A" / "Tablet B" — operator-visible nickname
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS last_ping_at timestamptz;   -- cached from latest route_trace row; powers active-drives query
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS started_office_id uuid;     -- which office the drive originated from (audit + future auto-start)
ALTER TABLE inspections
  ADD COLUMN IF NOT EXISTS ended_office_id uuid;       -- which office it ended at (return-to-office detection)

-- FKs added separately so re-runs are idempotent when the columns already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inspections_started_office_fk'
  ) THEN
    ALTER TABLE inspections
      ADD CONSTRAINT inspections_started_office_fk
      FOREIGN KEY (started_office_id) REFERENCES bedrock_offices(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inspections_ended_office_fk'
  ) THEN
    ALTER TABLE inspections
      ADD CONSTRAINT inspections_ended_office_fk
      FOREIGN KEY (ended_office_id) REFERENCES bedrock_offices(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Hot path: dashboard "active drives" query.
-- "Show me every drive that's in_progress with a fresh ping in the last 5 min."
CREATE INDEX IF NOT EXISTS idx_inspections_active_live
  ON inspections (status, last_ping_at DESC)
  WHERE status = 'in_progress';

COMMIT;
