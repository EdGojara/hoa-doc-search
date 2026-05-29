-- ============================================================================
-- 131_user_home_tiles.sql
-- ----------------------------------------------------------------------------
-- Add per-user preferences to user_profiles so each operator can personalize
-- their trustEd home screen. Phase 1 of the home-dashboard build: static
-- tile shortcuts. The preferences JSONB also gives us a place to land
-- future per-user knobs (default community, table sort preferences, theme,
-- etc.) without proliferating columns.
--
-- WHY THIS MATTERS:
--   - 17+ tabs in the nav; everyone scrolls past the ones they don't use
--   - Ed (admin), Jennifer (enforcement), Laurie (AR) have totally
--     different daily-use modules
--   - Friction-as-margin-lever (see project_friction_as_margin_lever.md):
--     30 seconds saved per task × 200 tasks/day × 50 franchise instances
--     = real money
--
-- SHAPE OF preferences JSONB:
--   {
--     "home_tiles": ["inspect", "drafts", "manual_violation", "asked",
--                    "community_profile", "owner_ar"]
--   }
--
-- Default tiles for new users (handled in the backend, not DB default):
--   ["asked", "inspect", "drafts", "manual_violation",
--    "community_profile", "owner_ar"]
--
-- Record-ownership bucket: workpaper (per-user state, never delivered to
-- a board, never transfers on HOA termination).
--
-- Apply after 130. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN user_profiles.preferences IS
  'Per-user preferences. Phase 1 holds home_tiles (array of tile keys for the customizable home dashboard). Future shape: default community, table sort preferences, etc.';

COMMIT;
