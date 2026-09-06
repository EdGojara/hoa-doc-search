-- ============================================================================
-- 410_enable_share_news_tile.sql  (Ed 2026-09-06)
-- ----------------------------------------------------------------------------
-- Turn on the "Share Community News" portal tile (key: share_news) for every
-- community. The portal renders tiles from communities.portal_module_config;
-- without an entry the tile would show "coming soon" (the documented tile-gate
-- scar). Pairs with migration 409 + the share_news MODULE + defaultDemoModuleConfig
-- in public/portal.html. Idempotent — only sets it where absent.
-- ============================================================================
BEGIN;

UPDATE communities
SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
    || jsonb_build_object('share_news', jsonb_build_object('status', 'live'))
WHERE NOT (COALESCE(portal_module_config, '{}'::jsonb) ? 'share_news');

COMMIT;
