-- ============================================================================
-- 391 — Seed Drama Creek Estates (the fictional demo community) with real
--       amenity records, so the demo renders through the SAME production API as
--       a live community instead of hardcoded mock data that drifts.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-26: "the demo won't work right compared to the actual community."
-- Root cause: demo mode built amenities in page code. Fix: give the fictional
-- demo community real DB records and point its map at the live endpoint. Safe —
-- Drama Creek has no real homeowners, so nothing real is exposed. Fictional
-- coordinates cluster around one fake location; the map centers on their
-- average (Drama Creek has no boundary).
--
-- Record ownership: association_record (community amenity data), but for a
-- fictional demo community.
-- ============================================================================
BEGIN;

-- Clean re-seed so the demo is deterministic and idempotent.
DELETE FROM amenities WHERE community_id = 'dc100000-0000-4000-a000-000000000000';

INSERT INTO amenities (community_id, amenity_type, name, description, hours_text, lat, lng, status, display_order, is_rentable, rental_max_attendees,
                       season_rule, season_open_md, season_close_md, offseason_status, management_vendor_name, contact_name, contact_phone, security_details)
VALUES
  ('dc100000-0000-4000-a000-000000000000', 'clubhouse', 'Drama Creek Clubhouse',
   'Community clubhouse with event space and kitchen. Reservable for private events.',
   'Reservable Sun-Thu until 10pm, Fri-Sat until midnight', 29.70000, -95.76000, 'active', 1, true, 60,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),

  ('dc100000-0000-4000-a000-000000000000', 'pool', 'Community Pool',
   'Outdoor swimming pool. Key fob access required.',
   'Weekends only 10 am - 8 pm in the early and late season; daily except Mondays 10 am - 8 pm while school is out (late May to mid-August). Closed the rest of the year.', 29.70030, -95.75970, 'active', 2, false, NULL,
   'fixed', '05-02', '09-27', 'closed', 'Splash Pros Pool Management, LLC', 'Splash Pros Pool Management', '(281) 555-0142', NULL),

  ('dc100000-0000-4000-a000-000000000000', 'park', 'Creekside Park',
   'Green space with picnic tables and a walking loop.',
   'Dawn to dusk', 29.70100, -95.76100, 'active', 3, false, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),

  ('dc100000-0000-4000-a000-000000000000', 'baseball_field', 'Baseball Field',
   'Community baseball field.', 'Dawn to dusk', 29.70150, -95.76050, 'active', 4, false, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),

  ('dc100000-0000-4000-a000-000000000000', 'soccer_field', 'Soccer Field',
   'Community soccer field.', 'Dawn to dusk', 29.70080, -95.75850, 'active', 5, false, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),

  ('dc100000-0000-4000-a000-000000000000', 'security', 'Community Patrol',
   'Contract deputy patrol for Drama Creek Estates. For emergencies always call 911.',
   'Patrol 6:00 AM - 2:00 PM, Monday through Friday', 29.70010, -95.76020, 'active', 6, false, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   jsonb_build_object(
     'officer_name', 'Deputy Ramirez',
     'patrol_hours', '6:00 AM - 2:00 PM, Monday through Friday',
     'sheriff',   jsonb_build_object('name', 'County Sheriff (non-emergency)', 'phone', '281-555-0100'),
     'constable', jsonb_build_object('name', 'Constable, Precinct 4', 'phone', '281-555-0177'),
     'emergency', '911'));

COMMIT;

NOTIFY pgrst, 'reload schema';
