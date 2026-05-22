-- ============================================================================
-- 097_waterview_contacts_full_seed.sql
-- ----------------------------------------------------------------------------
-- Fetched the live waterviewestates.info/important-contacts page and seeded
-- everything that wasn't covered in 096's initial seed. Adds:
--   - Center Point Energy (street light outages)
--   - Richmond Post Office
--   - Best Trash email + full collection rules
--   - "Key Contacts" / management team (Martha Bravo, Jennifer Flores, Celina
--     Deleon, Waterview Clubhouse address, Swim Houston pool management)
--   - Expanded trash schedule with recycling day + heavy-trash rules
--
-- Also adds a 'management' category to community_contacts so the Bedrock
-- team contacts get their own section instead of being mixed in with
-- community vendors.
--
-- Apply after 096. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Add 'management' category to the CHECK constraint
-- ----------------------------------------------------------------------------
ALTER TABLE community_contacts DROP CONSTRAINT IF EXISTS community_contacts_category_check;
ALTER TABLE community_contacts ADD CONSTRAINT community_contacts_category_check
  CHECK (category IN ('emergency', 'utility', 'trash', 'tv_internet',
                      'management', 'community', 'other'));

-- ----------------------------------------------------------------------------
-- 2) Backfill the rest of Waterview's contacts
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  wv_id UUID;
BEGIN
  SELECT id INTO wv_id FROM communities WHERE slug = 'waterview' LIMIT 1;
  IF wv_id IS NULL THEN
    RAISE NOTICE 'Waterview community not found — skipping seed';
    RETURN;
  END IF;

  -- Missing utility contacts: Center Point + Post Office
  -- Only insert if not already present (matches by name)
  INSERT INTO community_contacts (community_id, category, name, phone, url, notes, display_order)
  SELECT wv_id, 'utility', 'Center Point Energy (street light outage)',
         '(713) 207-2222', 'https://cnp.centerpointenergy.com/outage',
         'Report streetlights that are out, flickering, or dim.', 30
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name LIKE 'Center Point%'
  );

  INSERT INTO community_contacts (community_id, category, name, notes, display_order)
  SELECT wv_id, 'utility', 'Richmond Post Office',
         '5560 FM 1640, Richmond, TX 77469', 40
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name = 'Richmond Post Office'
  );

  -- Update Best Trash with email + expanded notes (if exists)
  UPDATE community_contacts SET
    email = 'customerservice@besttrashtexas.com',
    notes = '19430 FM 1093 Rd., Richmond, TX 77407 · Place trash at curb by 7:00 AM on collection days · Heavy trash: branches max 4" diameter and 4'' length, furniture/appliances limited to 2 per day · Holiday schedule: collections shift to next regular day'
  WHERE community_id = wv_id AND name = 'Best Trash';

  -- Management / Bedrock team contacts
  INSERT INTO community_contacts (community_id, category, name, phone, email, display_order)
  SELECT wv_id, 'management', 'Martha Bravo — Community Manager',
         '(832) 588-2485', 'mbravo@bedrocktx.com', 10
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name LIKE 'Martha Bravo%'
  );

  INSERT INTO community_contacts (community_id, category, name, phone, email, notes, display_order)
  SELECT wv_id, 'management', 'Jennifer Flores — Deed Restriction Violations (DRV)',
         '(832) 588-2485', 'jflores@bedrocktx.com',
         'Questions about compliance notices, violations, or cure timelines.', 20
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name LIKE 'Jennifer Flores%'
  );

  INSERT INTO community_contacts (community_id, category, name, phone, email, notes, display_order)
  SELECT wv_id, 'management', 'Celina Deleon — Accounting',
         '(832) 588-2485', 'cdeleon@bedrocktx.com',
         'Questions about assessments, account balance, statements, payment posting.', 30
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name LIKE 'Celina Deleon%'
  );

  -- Community-specific contacts (Clubhouse address, pool management vendor)
  INSERT INTO community_contacts (community_id, category, name, phone, email, notes, display_order)
  SELECT wv_id, 'community', 'Waterview Clubhouse',
         '(346) 867-9010', 'info@bedrocktx.com',
         '5110 Waterview Estates Trail, Richmond, TX 77407', 10
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name = 'Waterview Clubhouse'
  );

  INSERT INTO community_contacts (community_id, category, name, phone, url, notes, display_order)
  SELECT wv_id, 'community', 'Swim Houston — Pool Management',
         '(832) 701-7946', 'https://www.swimhoustonpools.com',
         'Pool operations, lifeguard scheduling, equipment issues during swim season.', 20
  WHERE NOT EXISTS (
    SELECT 1 FROM community_contacts
    WHERE community_id = wv_id AND name LIKE 'Swim Houston%'
  );

  -- Expanded trash schedule with recycling day + curbside rules
  UPDATE communities SET trash_schedule = jsonb_build_object(
    'collection_days', jsonb_build_array('tuesday', 'friday'),
    'recycling_days', jsonb_build_array('friday'),
    'heavy_trash_pattern', NULL,
    'curbside_deadline', '7:00 AM',
    'holidays_no_service', TRUE,
    'notes', 'Trash collected Tuesday & Friday; recycling collected Friday. Place containers at curb by 7:00 AM. Heavy trash: branches max 4" diameter and 4'' length; furniture/appliances limited to 2 per day. Holiday weeks shift collection to the next regular day.'
  )
  WHERE id = wv_id;
END $$;

COMMIT;
