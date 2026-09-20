-- ============================================================================
-- Migration 441 — community boundary: allow MultiPolygon (canonical contract)
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (the community's own geography). Single
-- class; documented at table level in migration 001/053. No row-level tag.
--
-- WHY: real community geography is legitimately NON-CONTIGUOUS — phases split by
-- public roads, detention/landscape tracts across a street, out-parcels. The
-- true dissolved footprint of such a community is a MultiPolygon, not a single
-- Polygon. Migration 053 pinned `boundary GEOGRAPHY(POLYGON,4326)`, which
-- rejects that reality and would force a convex-hull / envelope approximation
-- that claims land the association does not hold.
--
-- WHAT: widen the canonical type to the generic GEOGRAPHY(GEOMETRY,4326) — the
-- SAME choice migration 440 made for community_assets.geom — guarded by a CHECK
-- that permits ONLY Polygon and MultiPolygon (areal). Point/LineString/
-- GeometryCollection stay rejected. Existing Polygon rows remain valid AS-IS:
-- no ST_Multi() conversion, no backfill. Generic type => one column supports
-- both subtypes, so there is no parallel boundary representation.
--
-- The read RPC now also returns a PostGIS-derived map center
-- (ST_PointOnSurface) so no consumer traverses GeoJSON rings in JS. Chose
-- ST_PointOnSurface over ST_Centroid: the centroid of a concave / multi-part
-- geometry can fall in the gap between parts (off the land); PointOnSurface is
-- guaranteed to lie on the geometry — the safer center for irregular /
-- non-contiguous communities. Same operation migration 440 uses for assets.
-- Center is derived from the boundary column, not stored — single source of
-- truth preserved.
-- ============================================================================

BEGIN;

-- 1) Drop the GIST index before the type change, recreate it after (established
--    pattern — the index references the column being altered).
DROP INDEX IF EXISTS idx_communities_boundary_gist;

-- 2) Widen POLYGON -> generic GEOMETRY. Loosening the typmod; existing Polygon
--    values satisfy the generic type, so no data rewrite / conversion.
ALTER TABLE communities
  ALTER COLUMN boundary TYPE GEOGRAPHY(GEOMETRY, 4326)
  USING boundary::geography(Geometry, 4326);

-- 3) Areal-only CHECK: Polygon or MultiPolygon, nothing else. (Idempotent via
--    drop-then-add; Postgres has no ADD CONSTRAINT IF NOT EXISTS.)
ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_boundary_areal;
ALTER TABLE communities
  ADD CONSTRAINT communities_boundary_areal
  CHECK (
    boundary IS NULL
    OR GeometryType(boundary::geometry) IN ('POLYGON', 'MULTIPOLYGON')
  );

-- 4) Recreate the partial GIST index (works identically for Polygon and
--    MultiPolygon — it indexes bounding boxes).
CREATE INDEX IF NOT EXISTS idx_communities_boundary_gist
  ON communities USING GIST (boundary)
  WHERE boundary IS NOT NULL;

-- 5) Read RPC: unchanged boundary GeoJSON (already type-agnostic via
--    ST_AsGeoJSON) PLUS a PostGIS-derived center. Adding a field is
--    backward-compatible for existing callers.
CREATE OR REPLACE FUNCTION community_boundary_geojson(p_community_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
  pt     geometry;
BEGIN
  SELECT ST_PointOnSurface(boundary::geometry)
    INTO pt
    FROM communities
   WHERE id = p_community_id AND boundary IS NOT NULL;

  SELECT json_build_object(
    'boundary', CASE WHEN boundary IS NOT NULL
                     THEN ST_AsGeoJSON(boundary::geometry)::json ELSE NULL END,
    'center',   CASE WHEN pt IS NOT NULL
                     THEN json_build_object('lat', ST_Y(pt), 'lng', ST_X(pt))
                     ELSE NULL END,
    'drawn_at', boundary_drawn_at,
    'drawn_by', boundary_drawn_by,
    'notes',    boundary_notes
  )
  INTO result
  FROM communities
  WHERE id = p_community_id;
  RETURN result;
END;
$$;

-- community_boundary_set is unchanged: its body already casts arbitrary WKT via
-- ST_GeographyFromText, so a MULTIPOLYGON WKT now succeeds against the widened
-- column, and a POLYGON still succeeds. No modification required.

-- Re-issue grants (idempotent; CREATE OR REPLACE keeps them, but state them).
GRANT EXECUTE ON FUNCTION community_boundary_geojson(UUID) TO authenticated, service_role;

COMMIT;
