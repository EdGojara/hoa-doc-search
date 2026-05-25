-- ============================================================================
-- 109_portal_financials_tile_default.sql
-- ----------------------------------------------------------------------------
-- Splits the Financials tile out of Governing Documents so it can be toggled
-- independently per community (Ed needs to hide it when monthly statements
-- aren't ready for a community, without hiding ALL governing docs).
--
-- This migration only updates per-community config. The tile itself is
-- defined in public/portal.html (MODULES catalog); status = coming_soon by
-- default means it shows on the portal as "Coming soon" until staff flip
-- it to "live" via the tile-visibility admin panel.
--
-- Why coming_soon (not live) as the default:
--   - Most communities don't yet have monthly unaudited financials uploaded
--     to the documents library. Going live by default would mean an empty
--     tile for every community on first sight — bad first impression.
--   - Operators flip to "live" per community as financials get posted.
--   - The existing Governing Documents tile still includes financials in
--     its grouped view, so homeowners aren't blocked from seeing financials
--     while the standalone tile is coming-soon.
--
-- Idempotent: jsonb_build_object with ? guard means re-running the migration
-- doesn't overwrite an already-set financials key for a community where
-- staff already flipped it.
-- ============================================================================

BEGIN;

UPDATE communities
   SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
     || jsonb_build_object('financials', jsonb_build_object('status', 'coming_soon'))
 WHERE NOT (COALESCE(portal_module_config, '{}'::jsonb) ? 'financials');

COMMIT;
