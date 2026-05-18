-- ============================================================================
-- Migration 053 — community boundary polygon
-- ----------------------------------------------------------------------------
-- Adds a manual perimeter polygon to each community. Drawn once via the
-- Inspect-tab boundary tool (click points on the map → save), then rendered
-- as a tinted overlay on every map view that scopes by community.
--
-- Used for:
--   - Visual context on the inspection map (you can see the community edge)
--   - "% of community covered" stat (Phase 2 extension)
--   - Wrong-house detection (capture outside boundary → flag for review)
--   - Future parcel-data imports (clip Harris County GIS to boundary)
--
-- Harris County GIS publishes parcel data; longer-term we'll auto-derive
-- boundaries from the union of property parcels. For now, manual draw is the
-- pragmatic move — every Bedrock community gets traced in <5 minutes.
-- ============================================================================

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS boundary GEOGRAPHY(POLYGON, 4326) NULL,
  ADD COLUMN IF NOT EXISTS boundary_drawn_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS boundary_drawn_by UUID NULL,
  ADD COLUMN IF NOT EXISTS boundary_notes TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_communities_boundary_gist
  ON communities USING GIST (boundary)
  WHERE boundary IS NOT NULL;

-- ----------------------------------------------------------------------------
-- RPC helpers — supabase-js can't write PostGIS GEOGRAPHY directly, so the
-- API calls these instead. Read returns GeoJSON; write takes WKT.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION community_boundary_geojson(p_community_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'boundary',  CASE WHEN boundary IS NOT NULL THEN ST_AsGeoJSON(boundary::geometry)::json ELSE NULL END,
    'drawn_at',  boundary_drawn_at,
    'drawn_by',  boundary_drawn_by,
    'notes',     boundary_notes
  )
  INTO result
  FROM communities
  WHERE id = p_community_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION community_boundary_set(
  p_community_id UUID,
  p_wkt          TEXT,
  p_notes        TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE communities
  SET boundary           = ST_GeographyFromText('SRID=4326;' || p_wkt),
      boundary_drawn_at  = NOW(),
      boundary_notes     = COALESCE(p_notes, boundary_notes)
  WHERE id = p_community_id;
  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION community_boundary_geojson(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION community_boundary_set(UUID, TEXT, TEXT) TO authenticated, service_role;
