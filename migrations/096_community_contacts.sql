-- ============================================================================
-- 096_community_contacts.sql
-- ----------------------------------------------------------------------------
-- Per-community contact directory + trash schedule. Single source of truth
-- for "important numbers" that homeowners need (emergency, utilities, trash,
-- TV/internet, community-specific). Replaces the per-community static website
-- pages that managers have to maintain in parallel today.
--
-- Surfaces:
--   - Homeowner portal /portal/contacts (Local Contacts tile)
--   - New-homeowner welcome packet (future)
--   - Board "who do I call" lookup (future)
--   - AI email triage uses it to answer "where do I report X" inbound emails
--
-- Apply after 095. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) community_contacts — directory of important phone/email/url contacts
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  category            TEXT NOT NULL
    CHECK (category IN ('emergency', 'utility', 'trash', 'tv_internet',
                        'community', 'other')),

  name                TEXT NOT NULL,           -- "Sheriff", "Fort Bend MUD #143", "Best Trash"
  phone               TEXT,                    -- "(281) 341-4665"
  email               TEXT,
  url                 TEXT,                    -- vendor portal, payment site, etc.
  notes               TEXT,                    -- "Mon-Fri 8am-5pm" / mailing address / etc.

  display_order       INTEGER NOT NULL DEFAULT 100,
  is_published        BOOLEAN NOT NULL DEFAULT TRUE,  -- toggle off without deleting

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_contacts_community
  ON community_contacts(community_id, category, display_order)
  WHERE is_published = TRUE;

DROP TRIGGER IF EXISTS trg_community_contacts_updated_at ON community_contacts;
CREATE TRIGGER trg_community_contacts_updated_at
  BEFORE UPDATE ON community_contacts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE community_contacts IS
  'Per-community directory of important phone/email/url contacts (sheriff, utilities, trash, TV/internet). Surfaces to homeowner portal + future welcome packets + AI email triage. Replaces per-community static website maintenance.';

-- ----------------------------------------------------------------------------
-- 2) Trash schedule — small JSONB on communities (collection days + heavy trash)
-- ----------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS trash_schedule JSONB;

COMMENT ON COLUMN communities.trash_schedule IS
  'JSONB shape: { collection_days: ["tuesday","friday"], heavy_trash_pattern: "1st Wednesday", holidays_no_service: true, notes: "Free text", vendor_contact_id: UUID-of-community_contacts-row }';

-- ----------------------------------------------------------------------------
-- 3) Seed Waterview Estates' existing contacts from waterviewestates.info
-- ----------------------------------------------------------------------------
-- Hard-coded UUID for Waterview matches the seed-community pattern used
-- elsewhere in the codebase. Idempotent — ON CONFLICT DO NOTHING.
DO $$
DECLARE
  wv_id UUID;
BEGIN
  SELECT id INTO wv_id FROM communities WHERE slug = 'waterview' LIMIT 1;
  IF wv_id IS NULL THEN
    RAISE NOTICE 'Waterview community not found — skipping seed';
    RETURN;
  END IF;

  -- Emergency
  INSERT INTO community_contacts (community_id, category, name, phone, display_order)
  VALUES
    (wv_id, 'emergency', 'Emergency (Police / Fire / Medical)', '9-1-1', 10),
    (wv_id, 'emergency', 'Sheriff', '(281) 341-4665', 20),
    (wv_id, 'emergency', 'Animal Control', '(281) 342-1512', 30),
    (wv_id, 'emergency', 'Poison Control', '(800) 222-1222', 40)
  ON CONFLICT DO NOTHING;

  -- Utilities + services
  INSERT INTO community_contacts (community_id, category, name, phone, notes, display_order)
  VALUES
    (wv_id, 'utility', 'Fort Bend MUD #143 (Environmental Development Partners)',
     '(832) 467-1599',
     '17495 Village Green Drive, Houston, TX 77040 · Fax (832) 467-1610 · Monday–Friday 8:00am–5:00pm', 10),
    (wv_id, 'utility', 'Fort Bend County Road & Bridge Service Request',
     NULL,
     'Send requests directly via the County website — see Important Contacts page on community site for the form link.', 20)
  ON CONFLICT DO NOTHING;

  -- Trash
  INSERT INTO community_contacts (community_id, category, name, phone, notes, display_order)
  VALUES
    (wv_id, 'trash', 'Best Trash',
     '(281) 313-2378',
     '19430 FM 1093 Rd., Richmond, TX 77407', 10)
  ON CONFLICT DO NOTHING;

  -- TV / Internet
  INSERT INTO community_contacts (community_id, category, name, phone, notes, display_order)
  VALUES
    (wv_id, 'tv_internet', 'AT&T U-verse',
     '(800) 288-2020',
     'Customer Service + Technical Support · Mon–Fri 8am–7pm, Sat 8am–5pm local time', 10),
    (wv_id, 'tv_internet', 'Comcast / Xfinity',
     '(800) 934-6489',
     NULL, 20)
  ON CONFLICT DO NOTHING;

  -- Trash schedule (Tuesday/Friday is the Waterview pattern)
  UPDATE communities SET trash_schedule = jsonb_build_object(
    'collection_days', jsonb_build_array('tuesday', 'friday'),
    'heavy_trash_pattern', NULL,
    'holidays_no_service', TRUE,
    'notes', 'Place trash at curb by 7:00am on collection days. No service on federal holidays — collection delayed by one day.'
  )
  WHERE id = wv_id AND (trash_schedule IS NULL OR trash_schedule = '{}'::jsonb);
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON community_contacts
  TO anon, authenticated, service_role;

COMMIT;
