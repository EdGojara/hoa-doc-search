-- 162: Enable the Messages tile on the homeowner portal for every existing
-- community that already has a portal_module_config. New communities pick it
-- up automatically via defaultDemoModuleConfig.
--
-- Pattern documented in CLAUDE.md "Showing tiles as 'live' without enabling
-- them in the gate" — two-step enable: MODULES entry + this backfill.
--
-- Messages tile is association_record-adjacent (the underlying threads/messages
-- tables in migration 161 store homeowner ↔ Bedrock correspondence on behalf
-- of the association). Tile gate itself is a presentation flag, no data risk.

BEGIN;

UPDATE communities
SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
  || jsonb_build_object('messages', jsonb_build_object('status', 'live'))
WHERE NOT (COALESCE(portal_module_config, '{}'::jsonb) ? 'messages');

COMMIT;
