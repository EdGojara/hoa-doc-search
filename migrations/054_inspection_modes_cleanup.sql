-- ============================================================================
-- Migration 054 — inspection modes cleanup
-- ----------------------------------------------------------------------------
-- Real Bedrock inspection modes are:
--   - drive_by       — community-wide walkthrough / drive (most inspections)
--   - resale         — single-property inspection triggered by title-co request;
--                       feeds the Resale Inspection Report (resale module)
--   - mounted_camera — future autonomous-vehicle drive-by support
--
-- Removing: 'foot' (theoretical), 'spot_check' (overlaps with drive_by).
--
-- Any existing rows with the old modes get reclassified to 'drive_by' so
-- the CHECK constraint can be reapplied cleanly.
-- ============================================================================

-- Reclassify any historical rows BEFORE altering the constraint
UPDATE inspections SET mode = 'drive_by' WHERE mode IN ('foot', 'spot_check');

-- Replace the constraint
ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_mode_check;
ALTER TABLE inspections
  ADD CONSTRAINT inspections_mode_check
  CHECK (mode IN ('drive_by','resale','mounted_camera'));
