-- ============================================================================
-- 390 — Amenity map: security/patrol marker + baseball & soccer fields.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-26. Add a clickable patrol marker near the clubhouse (contract
-- deputy: officer, patrol hours, Sheriff + Constable contacts, 911) and mark
-- the baseball and soccer fields as amenities on the community map.
--
-- Three parts:
--   1. Expand the amenity_type CHECK to allow 'security', 'baseball_field',
--      'soccer_field'.
--   2. security_details JSONB — the multi-contact patrol block (the single
--      contact_name/phone/email columns can't hold deputy + Sheriff + Constable
--      + emergency).
--   3. Seed the three Waterview markers. Coordinates are approximate (near the
--      clubhouse for the patrol); staff fine-tune the exact pin in the amenities
--      admin. Idempotent — skips if that type already exists for the community.
--
-- Record ownership: association_record (community amenity data).
-- ============================================================================
BEGIN;

ALTER TABLE amenities DROP CONSTRAINT IF EXISTS amenities_amenity_type_check;
ALTER TABLE amenities ADD CONSTRAINT amenities_amenity_type_check
  CHECK (amenity_type IN ('clubhouse', 'pool', 'park', 'playground', 'sport_court',
                          'fitness', 'dog_park', 'walking_trail', 'gate', 'mailroom',
                          'baseball_field', 'soccer_field', 'security', 'other'));

ALTER TABLE amenities ADD COLUMN IF NOT EXISTS security_details JSONB;
COMMENT ON COLUMN amenities.security_details IS
  'For amenity_type=security: {officer_name, patrol_hours, sheriff:{name,phone}, constable:{name,phone}, emergency}. (mig 390)';

-- Waterview contract-deputy patrol, placed near the clubhouse / Oxford Chase Trl.
INSERT INTO amenities (community_id, amenity_type, name, description, hours_text, lat, lng, status, display_order, is_rentable, security_details)
SELECT c.id, 'security', 'Community Patrol',
       'Contract deputy patrol for Waterview Estates. For emergencies always call 911.',
       'Patrol 6:00 AM - 2:00 PM, Monday through Friday',
       29.66635, -95.72860, 'active', 5, false,
       jsonb_build_object(
         'officer_name', 'Deputy Ocampo',
         'patrol_hours', '6:00 AM - 2:00 PM, Monday through Friday',
         'sheriff',   jsonb_build_object('name', 'Fort Bend County Sheriff (non-emergency)', 'phone', '281-341-4665'),
         'constable', jsonb_build_object('name', 'Fort Bend County Constable, Precinct 4', 'phone', '281-341-4536'),
         'emergency', '911')
FROM communities c WHERE c.slug = 'waterview'
  AND NOT EXISTS (SELECT 1 FROM amenities a WHERE a.community_id = c.id AND a.amenity_type = 'security');

INSERT INTO amenities (community_id, amenity_type, name, description, hours_text, lat, lng, status, display_order, is_rentable)
SELECT c.id, 'baseball_field', 'Baseball Field', 'Community baseball field.', 'Dawn to dusk',
       29.66880, -95.73000, 'active', 30, false
FROM communities c WHERE c.slug = 'waterview'
  AND NOT EXISTS (SELECT 1 FROM amenities a WHERE a.community_id = c.id AND a.amenity_type = 'baseball_field');

INSERT INTO amenities (community_id, amenity_type, name, description, hours_text, lat, lng, status, display_order, is_rentable)
SELECT c.id, 'soccer_field', 'Soccer Field', 'Community soccer field.', 'Dawn to dusk',
       29.66720, -95.72680, 'active', 31, false
FROM communities c WHERE c.slug = 'waterview'
  AND NOT EXISTS (SELECT 1 FROM amenities a WHERE a.community_id = c.id AND a.amenity_type = 'soccer_field');

COMMIT;

NOTIFY pgrst, 'reload schema';
