-- ============================================================================
-- 375_portal_events_tile.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- Turns on the Community Calendar tile in the homeowner portal.
--
-- Ed: "i want to also add events tile in portal" and "we need to connect it to
-- our calendar for each community."
--
-- The tile serves /portal/events, which reads GET /api/portal/community-calendar
-- and aggregates three existing sources rather than introducing a fourth:
--   events            community events and board meetings
--   amenity_rentals   the dates an amenity is already taken
--
-- Nothing is copied into a calendar table. A booking copied into an events row
-- is a second copy of a fact that drifts the moment the booking moves or
-- cancels, which is the parallel-silo problem this codebase has paid for twice.
--
-- WHAT A HOMEOWNER SEES OF A NEIGHBOUR'S BOOKING. Ed 2026-08-20: "homeowners
-- and boards see it is booked but staff sees who is booking it", and "they just
-- see reserved or event or not available". So a booking renders as the single
-- word "Reserved" against a date and an amenity. No renter, no party, no
-- headcount. The renter never agreed to be published to their neighbours, and
-- the only thing a neighbour actually needs is whether the date is free.
--
-- Two-step tile enable per the CLAUDE.md scar: MODULES + defaultDemoModuleConfig
-- are in public/portal.html; this is the per-community half, without which the
-- tile renders as "Coming soon".
--
-- IDEMPOTENT: only writes communities that have no 'events' key yet, so a
-- community deliberately switched off stays off.
-- ============================================================================

BEGIN;

UPDATE communities
   SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
       || jsonb_build_object('events', jsonb_build_object('status', 'live'))
 WHERE NOT (COALESCE(portal_module_config, '{}'::jsonb) ? 'events');

COMMIT;

-- Verify:
--   SELECT name, portal_module_config -> 'events' AS events_tile
--     FROM communities ORDER BY name;
