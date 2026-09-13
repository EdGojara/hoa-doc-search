-- ============================================================================
-- 427_video_shares_expiry.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Auto-expiring share links, for security. A one-off video link can now retire
-- itself after a set window (default 48h) instead of relying on someone to take
-- it down. Expiry only closes the door: the file and the row stay, so the video
-- can be re-issued. NULL = never expires.
-- ============================================================================
BEGIN;

ALTER TABLE video_shares ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMIT;
