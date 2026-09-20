-- ============================================================================
-- Migration 442 — canonical community-boundary dissolve from parcel polygons
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (community geography). No row-level tag.
--
-- WHY: migration 053's header anticipated this exactly — "longer-term we'll
-- auto-derive boundaries from the union of property parcels." That time is now:
-- the Drama Creek FBCAD substrate needs its boundary computed as the ACTUAL
-- geometric dissolve of its parcels, not a shared-vertex heuristic and not a
-- convex-hull / envelope approximation. A true ST_UnaryUnion can only run in
-- PostGIS, and supabase-js cannot execute arbitrary SQL, so the dissolve lives
-- here as a canonical, reusable function — the productization of the boundary-
-- from-parcels vision, not a throwaway probe.
--
-- WHAT: community_boundary_dissolve_from_wkts(community, wkt[]) unions the given
-- WGS84 polygon WKTs (ST_UnaryUnion over ST_Collect), verifies the result is
-- areal (Polygon | MultiPolygon) AND valid, and only then writes it through the
-- SAME communities.boundary column the canonical write path uses (migration 441
-- widened it to GEOGRAPHY(GEOMETRY,4326) with an areal CHECK). It returns the
-- geometry type, part count, and validity. If the union is empty, non-areal, or
-- invalid, it writes NOTHING and returns ok:false — no approximation, no silent
-- repair. The caller stops and reports rather than storing a degenerate shape.
-- Single source of truth preserved: the boundary is derived and stored once, in
-- the one boundary column; parcels are not persisted as a parallel store.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION community_boundary_dissolve_from_wkts(
  p_community_id UUID,
  p_wkts         TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g      geometry;
  gtype  text;
  nparts integer;
  valid  boolean;
BEGIN
  IF p_wkts IS NULL OR array_length(p_wkts, 1) IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'no_wkts');
  END IF;

  -- True dissolve: collect all parcel polygons, union them (merges shared
  -- edges; disjoint pieces remain separate parts of a MultiPolygon).
  SELECT ST_UnaryUnion(ST_Collect(geom))
    INTO g
    FROM (
      SELECT ST_GeographyFromText('SRID=4326;' || w)::geometry AS geom
        FROM unnest(p_wkts) AS w
    ) s;

  IF g IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'empty_union');
  END IF;

  gtype  := GeometryType(g);
  nparts := ST_NumGeometries(g);
  valid  := ST_IsValid(g);

  IF gtype NOT IN ('POLYGON', 'MULTIPOLYGON') THEN
    RETURN json_build_object('ok', false, 'error', 'non_areal_union',
                             'geometry_type', gtype);
  END IF;

  -- Do not store a degenerate boundary. Report and let the caller decide.
  IF NOT valid THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_union',
                             'geometry_type', gtype, 'num_parts', nparts,
                             'reason', ST_IsValidReason(g));
  END IF;

  UPDATE communities
     SET boundary          = g::geography,
         boundary_drawn_at  = NOW(),
         boundary_notes     = COALESCE(boundary_notes, 'FBCAD parcel dissolve')
   WHERE id = p_community_id;

  RETURN json_build_object('ok', true, 'geometry_type', gtype,
                           'num_parts', nparts, 'is_valid', valid);
END;
$$;

GRANT EXECUTE ON FUNCTION community_boundary_dissolve_from_wkts(UUID, TEXT[]) TO service_role;

COMMIT;
