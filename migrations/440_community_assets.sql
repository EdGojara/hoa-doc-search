-- 440_community_assets.sql
-- ----------------------------------------------------------------------------
-- The canonical physical-asset identity for Trusted (Ed 2026-09-20). One row per
-- physical thing an organization maintains: detention pond, landscape reserve,
-- monument, entrance, pool, clubhouse, irrigation system, playground, trail,
-- lighting, drainage, road, fence, building, mechanical equipment. This is the
-- physical IDENTITY, not a workflow or accounting view of the thing; amenities and
-- reserve_components describe facets and will later point AT this row, never the
-- reverse. Spend and condition history are DERIVED from linked operational records
-- and are never stored here.
--
-- Approved design + three modifications:
--   * NO primary_vendor_id (vendor links are operational/contractual, not identity).
--   * Relationship/audience scope is included NOW (Demo LMA is a planned next env),
--     reusing the fail-closed member-scope pattern (mig 436) with NO CLMA-specific
--     columns: an asset owned by one org can later serve other orgs via member_scope
--     + asset_member_scope, exactly like document_member_scope.
--   * Invariant: no duplicate OPERATIONAL identity. A member/assessable unit is a
--     `properties` row; an org-maintained physical thing is a `community_assets`
--     row. An asset may sit within/upon a tract without being that tract. (No new
--     parcel/tract subsystem here.)
--
-- Scope: canonical identity ONLY. NO asset_id is added to amenities /
-- reserve_components / property_observations / work_items / vendor_projects / AP /
-- communications / board decisions yet. common_areas is NOT retired yet. No map,
-- no FBCAD import, no Drama Creek changes.
--
-- Conventions matched to production: PostGIS GEOGRAPHY(,4326) + GIST (mig 050/053);
-- member-scope pattern (mig 436); trusted_set_updated_at trigger; GRANT to
-- service_role + SELECT to authenticated (app-layer/tenant scoping, not RLS, the
-- dominant convention); geography written via an RPC (supabase-js cannot write
-- GEOGRAPHY directly), the community_boundary_set precedent (mig 053).
-- Record ownership: `mixed` (delivered asset/map views = association_record;
-- internal cost analysis = workpaper), per CLAUDE.md ownership discipline.
BEGIN;

CREATE TABLE IF NOT EXISTS community_assets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant boundary + owning/responsible organization.
  management_company_id UUID NOT NULL,
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  -- Composite structure (North Entrance -> monument, bed, irrigation, lighting).
  parent_asset_id       UUID REFERENCES community_assets(id) ON DELETE SET NULL,
  -- Identity.
  name                  TEXT NOT NULL,
  description           TEXT,
  asset_class           TEXT NOT NULL CHECK (asset_class IN
                          ('landscape','water','structure','recreation','access',
                           'hardscape','utility','equipment','other')),
  asset_type            TEXT NOT NULL,            -- specific within class (app-validated vocabulary)
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','planned','retired')),
  condition             TEXT CHECK (condition IN
                          ('excellent','good','fair','poor','failing','unknown')),
  -- Geometry: one geometry per asset; any subtype (POINT/LINE/POLYGON/MULTI).
  geom                  GEOGRAPHY(GEOMETRY, 4326),
  centroid              GEOGRAPHY(POINT, 4326),
  location_description  TEXT,
  -- Generic provenance (the core never assumes FBCAD; source is a value).
  source_system         TEXT,
  source_ref            TEXT,
  photo_storage_path    TEXT,
  installed_year        INTEGER,
  -- Relationship/audience scope: fail-closed, same states as documents. Default
  -- 'unclassified' means invisible to any served/member organization until set.
  member_scope          TEXT NOT NULL DEFAULT 'unclassified'
                          CHECK (member_scope IN
                            ('internal_only','all_members','selected_members',
                             'not_applicable','unclassified')),
  record_ownership      TEXT NOT NULL DEFAULT 'mixed'
                          CHECK (record_ownership IN ('association_record','workpaper','mixed')),
  notes                 TEXT,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- An asset cannot be its own parent (direct self-reference; cycles beyond this
  -- are an app-layer concern).
  CONSTRAINT community_assets_parent_not_self CHECK (parent_asset_id IS NULL OR parent_asset_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_community_assets_community ON community_assets (community_id, asset_class);
CREATE INDEX IF NOT EXISTS idx_community_assets_mgmt_co   ON community_assets (management_company_id);
CREATE INDEX IF NOT EXISTS idx_community_assets_parent    ON community_assets (parent_asset_id);
CREATE INDEX IF NOT EXISTS idx_community_assets_geom      ON community_assets USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_community_assets_centroid  ON community_assets USING GIST (centroid);

DROP TRIGGER IF EXISTS trg_community_assets_updated_at ON community_assets;
CREATE TRIGGER trg_community_assets_updated_at BEFORE UPDATE ON community_assets
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON community_assets TO service_role;
GRANT SELECT ON community_assets TO authenticated;

-- Selected-member scope: explicit, FK-backed, used only when
-- member_scope='selected_members'. Same shape as document_member_scope (mig 436),
-- so the SAME fail-closed entitlement resolver applies. No CLMA-specific columns.
CREATE TABLE IF NOT EXISTS asset_member_scope (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id             UUID NOT NULL REFERENCES community_assets(id) ON DELETE CASCADE,
  member_community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, member_community_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_member_scope_member ON asset_member_scope (member_community_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_member_scope TO service_role;
GRANT SELECT ON asset_member_scope TO authenticated;

-- Geography WRITE primitive (supabase-js cannot write GEOGRAPHY directly). Accepts
-- WKT/EWKT ('POINT(...)', 'LINESTRING(...)', 'POLYGON((...))'; SRID defaults 4326),
-- sets geom and derives centroid. The community_boundary_set precedent (mig 053).
-- Not a map or an operational integration: the minimal write path for the column.
CREATE OR REPLACE FUNCTION community_asset_set_geometry(p_asset_id UUID, p_wkt TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE g GEOGRAPHY;
BEGIN
  g := ST_GeographyFromText(p_wkt);
  UPDATE community_assets
     SET geom      = g,
         centroid  = ST_PointOnSurface(g::geometry)::geography,
         updated_at = NOW()
   WHERE id = p_asset_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'asset_not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'geometry_type', ST_GeometryType(g::geometry), 'has_centroid', true);
END $$;
GRANT EXECUTE ON FUNCTION community_asset_set_geometry(UUID, TEXT) TO service_role, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
