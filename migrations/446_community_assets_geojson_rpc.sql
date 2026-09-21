-- ============================================================================
-- 446 — community_assets_geojson RPC (canonical asset geometry read for the map)
-- ----------------------------------------------------------------------------
-- The Visual Operating Map renders community_assets as real geometry. supabase-js
-- cannot read a PostGIS GEOGRAPHY column as GeoJSON, so — exactly like the
-- existing community_boundary_geojson (053) — this RPC returns each asset's
-- geometry as GeoJSON plus identity/condition/hierarchy. Operational state
-- (active project, spend, vendor, board approval) is joined in the API layer
-- from vendor_projects.asset_id + ap_invoice_lines.project_id, so this RPC stays
-- geometry-only and reusable. Community-scoped param; callers enforce access.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION community_assets_geojson(p_community_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(json_agg(row ORDER BY nm), '[]'::json)
  FROM (
    SELECT
      a.name AS nm,
      json_build_object(
        'id', a.id,
        'name', a.name,
        'asset_class', a.asset_class,
        'asset_type', a.asset_type,
        'status', a.status,
        'condition', a.condition,
        'parent_asset_id', a.parent_asset_id,
        'location_description', a.location_description,
        'geometry', CASE WHEN a.geom IS NOT NULL
                         THEN ST_AsGeoJSON(a.geom::geometry)::json ELSE NULL END,
        'centroid', CASE WHEN a.centroid IS NOT NULL
                         THEN json_build_object('lat', ST_Y(a.centroid::geometry),
                                                'lng', ST_X(a.centroid::geometry))
                         ELSE NULL END
      ) AS row
    FROM community_assets a
    WHERE a.community_id = p_community_id
  ) s;
$$;

GRANT EXECUTE ON FUNCTION community_assets_geojson(UUID) TO authenticated, service_role;

COMMIT;
