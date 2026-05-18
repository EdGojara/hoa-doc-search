-- ============================================================================
-- Migration 052 — inspection route traces (GPS pings during walkthrough)
-- ----------------------------------------------------------------------------
-- One row per ~5-second GPS poll during an active inspection. Backs the
-- "did we cover the whole community?" map layer:
--   - The trail (polyline) of where staff walked/drove
--   - Properties NOT within 50ft of the trail → flagged as "missed this pass"
--   - % of street miles covered, eventually
--
-- Inserted in batches by the client (every 30s, or on inspection end) so we
-- don't HTTP-thrash the server during a 90-minute walkthrough.
--
-- Retention: keep alongside the inspection row indefinitely (small data).
-- ============================================================================

CREATE TABLE IF NOT EXISTS inspection_route_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id   UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  captured_at     TIMESTAMPTZ NOT NULL,
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  accuracy_m      DOUBLE PRECISION NULL,          -- meters of expected accuracy
  heading_deg     DOUBLE PRECISION NULL,          -- compass heading 0-360
  speed_mps       DOUBLE PRECISION NULL,          -- meters per second
  point           GEOGRAPHY(POINT, 4326) NULL,    -- derived from lat/lng
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_traces_inspection
  ON inspection_route_traces (inspection_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_route_traces_point_gist
  ON inspection_route_traces USING GIST (point)
  WHERE point IS NOT NULL;

-- Auto-fill the GEOGRAPHY point from lat/lng on insert/update so the spatial
-- index works without the client having to know PostGIS syntax.
CREATE OR REPLACE FUNCTION fn_route_traces_set_point() RETURNS TRIGGER AS $$
BEGIN
  NEW.point := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::GEOGRAPHY;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_route_traces_set_point ON inspection_route_traces;
CREATE TRIGGER trg_route_traces_set_point
  BEFORE INSERT OR UPDATE ON inspection_route_traces
  FOR EACH ROW EXECUTE FUNCTION fn_route_traces_set_point();

GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_route_traces TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_route_traces TO service_role;
