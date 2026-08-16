-- ============================================================================
-- 367_enable_claire_tile.sql  (Ed 2026-08-16)
-- ----------------------------------------------------------------------------
-- Turn the "Ask Claire" portal tile on for existing communities.
--
-- Adding a tile to MODULES in public/portal.html is only half of shipping it.
-- The tile renders as "Coming soon" until the key exists in the community's
-- portal_module_config, and the miss is invisible in testing because demo mode
-- reads defaultDemoModuleConfig() instead. That exact mistake shipped once with
-- the Local Contacts tile and needed a migration to undo, so the migration is
-- part of the change now rather than a follow-up.
--
-- Only sets the key where it is absent, so a community that has deliberately
-- switched Claire off is not switched back on by a re-run.
-- ============================================================================
BEGIN;

UPDATE communities
   SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
                              || jsonb_build_object('claire', jsonb_build_object('status', 'live'))
 WHERE NOT (COALESCE(portal_module_config, '{}'::jsonb) ? 'claire');

COMMIT;
