-- ============================================================================
-- 443 — vendor_projects.asset_id → community_assets (canonical project↔asset)
-- ----------------------------------------------------------------------------
-- The Visual Operating Map organizes work around managed physical assets. The
-- architecture trace found vendor_projects identifies its asset only through
-- the free-text `asset` column (321:35). This adds the proper structured
-- relationship so a project resolves to a real community_assets row (and, via
-- community_assets.parent_asset_id, to its parent location).
--
-- Additive + nullable. Existing production projects stay NULL — we do NOT infer
-- or backfill an asset relationship. The descriptive `asset` text is preserved
-- for compatibility/history; asset_id becomes the canonical link going forward.
-- ON DELETE SET NULL: an asset can be retired without destroying project history.
--
-- Record ownership unchanged (association_record, per migration 321).
-- ============================================================================
BEGIN;

ALTER TABLE vendor_projects
  ADD COLUMN IF NOT EXISTS asset_id UUID NULL REFERENCES community_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_projects_asset
  ON vendor_projects (asset_id) WHERE asset_id IS NOT NULL;

COMMENT ON COLUMN vendor_projects.asset_id IS
  'Canonical FK to community_assets (the managed location/asset this project is for). The legacy free-text vendor_projects.asset is kept for history. NULL = no known structured asset; never inferred/backfilled.';

COMMIT;
