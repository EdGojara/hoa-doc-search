-- ============================================================================
-- 445 — board_map_reports: asset + project context (extend map reports to LMA)
-- ----------------------------------------------------------------------------
-- The residential Community Map "report an issue" flow writes board_map_reports
-- keyed to a property_id (393). The LMA Visual Operating Map reuses the SAME
-- report system, but the physical object a board member taps is a managed
-- common-area asset (a median, monument, irrigation zone), not a house.
--
-- This extends the existing table (no Demo-only messaging silo): property_id is
-- already nullable; add an optional community_asset_id (the tapped location)
-- and an optional related_project_id (when the report is about a known project).
-- The report retains full canonical context: community + asset (+ project) +
-- reporter + description + photo + status.
--
-- Additive + nullable. Record ownership unchanged (association_record, 393).
-- ============================================================================
BEGIN;

ALTER TABLE board_map_reports
  ADD COLUMN IF NOT EXISTS community_asset_id UUID NULL REFERENCES community_assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS related_project_id UUID NULL REFERENCES vendor_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_board_map_reports_asset
  ON board_map_reports (community_asset_id, created_at DESC) WHERE community_asset_id IS NOT NULL;

COMMENT ON COLUMN board_map_reports.community_asset_id IS
  'The managed common-area asset a field report was filed against (LMA map). Property or asset context; both nullable. Same table/flow as residential house reports — no Demo-only report silo.';

COMMIT;
