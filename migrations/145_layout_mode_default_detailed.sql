-- ============================================================================
-- 145_layout_mode_default_detailed.sql
-- ----------------------------------------------------------------------------
-- Ed reviewed both layouts and prefers the detailed Canyon Gate-style packet
-- (separate notice / voting-instructions / proxy-ballot pages). The compact
-- single-page format saved postage but lost the polished feel.
--
-- Reverts the Waterview cycle (set to 'compact' by migration 144) back to
-- 'detailed' so its next render matches the format Ed prefers. New cycles
-- default to 'detailed' via the renderer (changed in same commit).
--
-- Apply after 144. Idempotent.
-- ============================================================================

BEGIN;

UPDATE nomination_cycles
SET layout_mode = 'detailed'
WHERE community_name ILIKE 'Waterview%' AND layout_mode = 'compact';

NOTIFY pgrst, 'reload schema';

COMMIT;
