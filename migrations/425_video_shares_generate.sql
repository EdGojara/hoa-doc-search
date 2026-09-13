-- ============================================================================
-- 425_video_shares_generate.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Let Video Links GENERATE a video in place (type a script, pick the teammate,
-- render via HeyGen) instead of only hosting an uploaded file. A generated
-- one-off stays PRIVATE (the videos bucket + per-view signed URL), unlike the
-- public explainer library. These columns track the render so the page can poll
-- it to completion, then the finished mp4 is copied into the private bucket.
-- ============================================================================
BEGIN;

ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'upload';  -- 'upload' | 'generated'
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS provider_video_id text;   -- HeyGen video id while rendering
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS render_status    text;    -- 'rendering' | 'ready' | 'failed' (null for uploads)
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS render_error     text;
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS language         text;
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS script           text;    -- the script used, so it can be seen/reused
ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS duration_seconds integer;

COMMIT;
