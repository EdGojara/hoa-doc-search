-- ============================================================================
-- 424_video_shares_demo_cta.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Video Links go to prospects and referral sources, so the watch page is a
-- sales impression. Add two optional touches, off by default:
--   * caption — a one-line "what you just watched", under the video.
--   * demo    — when true, show a soft call-to-action ("Want this for your
--               community?") with a way to get in touch. Kept off for a plain
--               personal message so a resident never sees a sales prompt.
-- ============================================================================
BEGIN;

ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS caption text;
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;

COMMIT;
