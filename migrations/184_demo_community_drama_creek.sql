-- ============================================================================
-- 184_demo_community_drama_creek.sql
-- ----------------------------------------------------------------------------
-- Drama Creek Estates — Bedrock's demo community.
--
-- WHY THIS EXISTS:
--   Showing a prospective board member real Waterview (or any live client)
--   data is a fair-housing / member-confidentiality / IP-protection issue.
--   The named-insider-threat memory note for Waterview specifically makes
--   this acute. We need a fully realistic synthetic community we can hand
--   to prospects without exposing real homeowners. This same community
--   doubles as:
--     - Ed's test surface for portal/UX changes (log in as demo homeowner)
--     - Bedrock University screenshot source for training modules
--     - The franchise sales asset for selling to second-act operators
--     - Marketing-site live demo replacement for static screenshots
--
-- WHAT'S IN THIS MIGRATION (Day 1 foundation):
--   - communities.is_demo flag — drives all watermarking behavior
--     downstream so a demo community can never be confused for a real one
--   - Drama Creek Estates community row + portal config
--   - 5 board members with the agreed comedic-archetype names
--     (Sunny Meadows, Byron T. Bylaw, Cassandra Complaine,
--      Tally Hawthorne, Felix Goodneighbor)
--   - 8 demo homeowners covering common scenarios (model owner, active
--     enforcement, payment plan, ACC in review, at-legal, new owner,
--     long-tenured, investor/landlord)
--   - 80 properties on 5 peaceful-named streets (Tranquility, Serenity,
--     Harmony, Peaceful Pond, Calm Waters) — quiet dramatic irony with
--     the community name
--   - Property ownership linkages for the 13 named contacts
--   - Portal users wired to email + property so magic-link auth works
--   - Board roster (board_members table)
--
-- WHAT'S NOT YET IN (Day 2-3):
--   - AR snapshots (account balances per scenario)
--   - DRV cycle history (violations, courtesy letters, fines)
--   - ACC pipeline (recent submissions, approvals, denials)
--   - Financials (GL, budget, board packet)
--   - Reserve study with components
--   - Vendor contracts (landscape, pool, gate)
--   - Sample homeowner email threads
--   - Annual meeting cycle / ballots
--   - Reserve invoices
--
-- IDEMPOTENT:
--   All inserts guarded by ON CONFLICT DO NOTHING (on stable UUIDs and
--   natural unique constraints). Safe to re-run.
--
-- STABLE UUID PATTERN:
--   dc100000-... = Drama Creek community
--   dc100001-... through dc10000d-... = the 13 contacts (5 board + 8 homeowners)
--   dc110001-... through dc110050-... = 80 properties (hex 1-50 = 80)
--   dc120001-... through dc120005-... = board_members rows
--   dc130001-... through dc13000d-... = property_ownerships rows
--   dc140001-... through dc14000d-... = portal_users rows
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) is_demo flag on communities
-- ----------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN communities.is_demo IS
  'TRUE = synthetic community used for demos / prospect walkthroughs / training. Drives the watermark ribbon on every page and the DEMO stamp on rendered PDFs. Never assign to a real community — visible disclosure protects both us and the homeowner.';

CREATE INDEX IF NOT EXISTS idx_communities_is_demo
  ON communities (is_demo) WHERE is_demo = TRUE;

-- ----------------------------------------------------------------------------
-- 2) Drama Creek Estates community
-- ----------------------------------------------------------------------------
INSERT INTO communities (
  id, management_company_id, name, legal_name,
  vantaca_code, county, state, total_lots,
  slug, website_url,
  portal_module_config, portal_active, portal_welcome_message,
  is_demo, active, notes
) VALUES (
  'dc100000-0000-4000-a000-000000000000',
  '00000000-0000-0000-0000-000000000001',
  'Drama Creek Estates',
  'Drama Creek Estates Homeowners Association, Inc.',
  'DCE',
  'Fictional County',
  'TX',
  80,
  'drama-creek',
  'https://www.dramacreekhoa.demo',
  -- Every tile live so prospects see the full platform
  jsonb_build_object(
    'balance',          jsonb_build_object('status', 'live'),
    'compliance',       jsonb_build_object('status', 'live'),
    'property_summary', jsonb_build_object('status', 'live'),
    'messages',         jsonb_build_object('status', 'live'),
    'arc',              jsonb_build_object('status', 'live'),
    'key_fob',          jsonb_build_object('status', 'live'),
    'clubhouse',        jsonb_build_object('status', 'live'),
    'documents',        jsonb_build_object('status', 'live'),
    'financials',       jsonb_build_object('status', 'live'),
    'meetings',         jsonb_build_object('status', 'live'),
    'contacts',         jsonb_build_object('status', 'live')
  ),
  TRUE,
  'Welcome to Drama Creek Estates. This is a demo community used to walk prospective boards through the Bedrock platform. All data shown is fictional.',
  TRUE,
  TRUE,
  'Demo community. Seeded by migration 184. Do not use for real operations.'
) ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      legal_name = EXCLUDED.legal_name,
      portal_module_config = EXCLUDED.portal_module_config,
      portal_active = EXCLUDED.portal_active,
      portal_welcome_message = EXCLUDED.portal_welcome_message,
      is_demo = EXCLUDED.is_demo,
      slug = EXCLUDED.slug,
      website_url = EXCLUDED.website_url,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 3) Contacts — 5 board + 8 demo homeowners (13 total)
--    Each board member is also a homeowner (Texas HOA boards must be members).
-- ----------------------------------------------------------------------------
INSERT INTO contacts (id, full_name, preferred_name, primary_email, primary_phone, notes) VALUES
  -- Board members
  ('dc100001-0000-4000-a000-000000000000', 'Sunny Meadows',          'Sunny',     'sunny@dramacreekhoa.demo',     '(832) 555-0101', 'Demo board member — President. Archetype: the optimist.'),
  ('dc100002-0000-4000-a000-000000000000', 'Byron T. Bylaw',         'Byron',     'byron@dramacreekhoa.demo',     '(832) 555-0102', 'Demo board member — VP / Architectural Committee Chair. Archetype: the rules-quoter.'),
  ('dc100003-0000-4000-a000-000000000000', 'Cassandra Complaine',    'Cassie',    'cassandra@dramacreekhoa.demo', '(832) 555-0103', 'Demo board member — Secretary. Archetype: the worrier.'),
  ('dc100004-0000-4000-a000-000000000000', 'Tally Hawthorne',        'Tally',     'tally@dramacreekhoa.demo',     '(832) 555-0104', 'Demo board member — Treasurer. Archetype: the numbers person.'),
  ('dc100005-0000-4000-a000-000000000000', 'Felix Goodneighbor',     'Felix',     'felix@dramacreekhoa.demo',     '(832) 555-0105', 'Demo board member — Member-at-Large. Archetype: the harmony-keeper.'),
  -- Demo homeowner scenarios
  ('dc100006-0000-4000-a000-000000000000', 'Robert "Bob" Steady',    'Bob',       'bob@dramacreekhoa.demo',       '(832) 555-0106', 'Demo homeowner — the model owner. Clean compliance record, current on dues.'),
  ('dc100007-0000-4000-a000-000000000000', 'Jennifer Lateleaves',    'Jennifer',  'jennifer@dramacreekhoa.demo',  '(832) 555-0107', 'Demo homeowner — active enforcement scenario. Courtesy notice for landscaping.'),
  ('dc100008-0000-4000-a000-000000000000', 'Marcus Behindbills',     'Marcus',    'marcus@dramacreekhoa.demo',    '(832) 555-0108', 'Demo homeowner — payment plan scenario. Working with accounting team.'),
  ('dc100009-0000-4000-a000-000000000000', 'Patricia Newpaint',      'Patricia',  'patricia@dramacreekhoa.demo',  '(832) 555-0109', 'Demo homeowner — ACC in review scenario. Submitted exterior repaint request.'),
  ('dc10000a-0000-4000-a000-000000000000', 'Greg Yardgone',          'Greg',      'greg@dramacreekhoa.demo',      '(832) 555-0110', 'Demo homeowner — at-legal scenario. Multiple escalations, attorney involved.'),
  ('dc10000b-0000-4000-a000-000000000000', 'Sarah Welcome',          'Sarah',     'sarah@dramacreekhoa.demo',     '(832) 555-0111', 'Demo homeowner — new owner scenario. Closed within last 30 days.'),
  ('dc10000c-0000-4000-a000-000000000000', 'Margaret Foundingmember','Margaret',  'margaret@dramacreekhoa.demo',  '(832) 555-0112', 'Demo homeowner — long-tenured scenario. Original buyer from community build-out.'),
  ('dc10000d-0000-4000-a000-000000000000', 'Tom Investorson',        'Tom',       'tom@dramacreekhoa.demo',       '(832) 555-0113', 'Demo homeowner — investor/landlord scenario. Rental property, off-site mailing.')
ON CONFLICT (id) DO UPDATE
  SET full_name = EXCLUDED.full_name,
      preferred_name = EXCLUDED.preferred_name,
      primary_email = EXCLUDED.primary_email,
      primary_phone = EXCLUDED.primary_phone,
      notes = EXCLUDED.notes,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 4) Properties — 80 lots across 5 peaceful-named streets
--    16 lots per street, sequential odd or even numbering for street-side feel.
--    City = "Drama Creek, TX 77479" — the city matches the community to keep
--    it clearly thematic; zip is a real Sugar Land zip so addresses look
--    plausible to anyone glancing.
-- ----------------------------------------------------------------------------
INSERT INTO properties (id, community_id, street_address, city, state, zip, property_type, lot_number) VALUES
  -- Tranquility Trail (101-131 odd, 16 lots)
  ('dc110001-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '101 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '101'),
  ('dc110002-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '103 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '103'),
  ('dc110003-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '105 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '105'),
  ('dc110004-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '107 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '107'),
  ('dc110005-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '109 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '109'),
  ('dc110006-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '111 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '111'),
  ('dc110007-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '113 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '113'),
  ('dc110008-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '115 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '115'),
  ('dc110009-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '117 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '117'),
  ('dc11000a-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '119 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '119'),
  ('dc11000b-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '121 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '121'),
  ('dc11000c-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '123 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '123'),
  ('dc11000d-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '125 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '125'),
  ('dc11000e-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '127 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '127'),
  ('dc11000f-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '129 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '129'),
  ('dc110010-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '131 Tranquility Trail', 'Drama Creek', 'TX', '77479', 'sfh', '131'),
  -- Serenity Court (102-132 even, 16 lots)
  ('dc110011-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '102 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '102'),
  ('dc110012-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '104 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '104'),
  ('dc110013-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '106 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '106'),
  ('dc110014-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '108 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '108'),
  ('dc110015-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '110 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '110'),
  ('dc110016-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '112 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '112'),
  ('dc110017-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '114 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '114'),
  ('dc110018-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '116 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '116'),
  ('dc110019-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '118 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '118'),
  ('dc11001a-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '120 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '120'),
  ('dc11001b-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '122 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '122'),
  ('dc11001c-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '124 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '124'),
  ('dc11001d-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '126 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '126'),
  ('dc11001e-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '128 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '128'),
  ('dc11001f-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '130 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '130'),
  ('dc110020-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '132 Serenity Court', 'Drama Creek', 'TX', '77479', 'sfh', '132'),
  -- Harmony Lane (201-231 odd, 16 lots)
  ('dc110021-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '201 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '201'),
  ('dc110022-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '203 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '203'),
  ('dc110023-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '205 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '205'),
  ('dc110024-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '207 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '207'),
  ('dc110025-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '209 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '209'),
  ('dc110026-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '211 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '211'),
  ('dc110027-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '213 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '213'),
  ('dc110028-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '215 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '215'),
  ('dc110029-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '217 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '217'),
  ('dc11002a-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '219 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '219'),
  ('dc11002b-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '221 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '221'),
  ('dc11002c-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '223 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '223'),
  ('dc11002d-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '225 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '225'),
  ('dc11002e-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '227 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '227'),
  ('dc11002f-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '229 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '229'),
  ('dc110030-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '231 Harmony Lane', 'Drama Creek', 'TX', '77479', 'sfh', '231'),
  -- Peaceful Pond Drive (202-232 even, 16 lots)
  ('dc110031-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '202 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '202'),
  ('dc110032-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '204 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '204'),
  ('dc110033-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '206 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '206'),
  ('dc110034-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '208 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '208'),
  ('dc110035-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '210 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '210'),
  ('dc110036-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '212 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '212'),
  ('dc110037-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '214 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '214'),
  ('dc110038-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '216 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '216'),
  ('dc110039-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '218 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '218'),
  ('dc11003a-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '220 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '220'),
  ('dc11003b-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '222 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '222'),
  ('dc11003c-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '224 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '224'),
  ('dc11003d-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '226 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '226'),
  ('dc11003e-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '228 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '228'),
  ('dc11003f-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '230 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '230'),
  ('dc110040-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '232 Peaceful Pond Drive', 'Drama Creek', 'TX', '77479', 'sfh', '232'),
  -- Calm Waters Way (301-331 odd, 16 lots)
  ('dc110041-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '301 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '301'),
  ('dc110042-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '303 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '303'),
  ('dc110043-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '305 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '305'),
  ('dc110044-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '307 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '307'),
  ('dc110045-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '309 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '309'),
  ('dc110046-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '311 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '311'),
  ('dc110047-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '313 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '313'),
  ('dc110048-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '315 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '315'),
  ('dc110049-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '317 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '317'),
  ('dc11004a-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '319 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '319'),
  ('dc11004b-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '321 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '321'),
  ('dc11004c-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '323 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '323'),
  ('dc11004d-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '325 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '325'),
  ('dc11004e-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '327 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '327'),
  ('dc11004f-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '329 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '329'),
  ('dc110050-0000-4000-a000-000000000000', 'dc100000-0000-4000-a000-000000000000', '331 Calm Waters Way', 'Drama Creek', 'TX', '77479', 'sfh', '331')
ON CONFLICT (id) DO UPDATE
  SET street_address = EXCLUDED.street_address,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      zip = EXCLUDED.zip,
      property_type = EXCLUDED.property_type,
      lot_number = EXCLUDED.lot_number,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 5) Property ownerships — link 13 contacts to 13 specific properties
--    Board members are spread across all five streets so the demo prospect
--    sees a credible neighborhood mix.
-- ----------------------------------------------------------------------------
INSERT INTO property_ownerships (id, property_id, contact_id, start_date, vesting, is_primary, source, notes) VALUES
  -- Board members
  ('dc130001-0000-4000-a000-000000000000', 'dc110005-0000-4000-a000-000000000000', 'dc100001-0000-4000-a000-000000000000', '2018-04-12', 'sole',  TRUE, 'manual', 'Sunny Meadows — President. 109 Tranquility Trail.'),
  ('dc130002-0000-4000-a000-000000000000', 'dc110031-0000-4000-a000-000000000000', 'dc100002-0000-4000-a000-000000000000', '2015-08-22', 'sole',  TRUE, 'manual', 'Byron T. Bylaw — VP. 202 Peaceful Pond Drive.'),
  ('dc130003-0000-4000-a000-000000000000', 'dc110023-0000-4000-a000-000000000000', 'dc100003-0000-4000-a000-000000000000', '2019-11-03', 'sole',  TRUE, 'manual', 'Cassandra Complaine — Secretary. 205 Harmony Lane.'),
  ('dc130004-0000-4000-a000-000000000000', 'dc110015-0000-4000-a000-000000000000', 'dc100004-0000-4000-a000-000000000000', '2016-06-30', 'sole',  TRUE, 'manual', 'Tally Hawthorne — Treasurer. 110 Serenity Court.'),
  ('dc130005-0000-4000-a000-000000000000', 'dc110043-0000-4000-a000-000000000000', 'dc100005-0000-4000-a000-000000000000', '2020-02-14', 'joint', TRUE, 'manual', 'Felix Goodneighbor — Member-at-Large. 305 Calm Waters Way.'),
  -- Demo homeowner scenarios
  ('dc130006-0000-4000-a000-000000000000', 'dc110001-0000-4000-a000-000000000000', 'dc100006-0000-4000-a000-000000000000', '2017-03-15', 'sole',  TRUE, 'manual', 'Bob Steady — model owner. 101 Tranquility Trail.'),
  ('dc130007-0000-4000-a000-000000000000', 'dc110011-0000-4000-a000-000000000000', 'dc100007-0000-4000-a000-000000000000', '2019-07-22', 'sole',  TRUE, 'manual', 'Jennifer Lateleaves — active enforcement. 102 Serenity Court.'),
  ('dc130008-0000-4000-a000-000000000000', 'dc110021-0000-4000-a000-000000000000', 'dc100008-0000-4000-a000-000000000000', '2014-12-01', 'sole',  TRUE, 'manual', 'Marcus Behindbills — payment plan. 201 Harmony Lane.'),
  ('dc130009-0000-4000-a000-000000000000', 'dc110035-0000-4000-a000-000000000000', 'dc100009-0000-4000-a000-000000000000', '2021-05-18', 'joint', TRUE, 'manual', 'Patricia Newpaint — ACC in review. 210 Peaceful Pond Drive.'),
  ('dc13000a-0000-4000-a000-000000000000', 'dc110041-0000-4000-a000-000000000000', 'dc10000a-0000-4000-a000-000000000000', '2013-09-09', 'sole',  TRUE, 'manual', 'Greg Yardgone — at-legal. 301 Calm Waters Way.'),
  ('dc13000b-0000-4000-a000-000000000000', 'dc110050-0000-4000-a000-000000000000', 'dc10000b-0000-4000-a000-000000000000', '2026-05-15', 'sole',  TRUE, 'manual', 'Sarah Welcome — new owner. 331 Calm Waters Way. Closed last month.'),
  ('dc13000c-0000-4000-a000-000000000000', 'dc110010-0000-4000-a000-000000000000', 'dc10000c-0000-4000-a000-000000000000', '1998-04-01', 'sole',  TRUE, 'manual', 'Margaret Foundingmember — original buyer. 131 Tranquility Trail.'),
  ('dc13000d-0000-4000-a000-000000000000', 'dc110030-0000-4000-a000-000000000000', 'dc10000d-0000-4000-a000-000000000000', '2022-10-04', 'LLC',   TRUE, 'manual', 'Tom Investorson — rental property. 231 Harmony Lane.')
ON CONFLICT (id) DO UPDATE
  SET start_date = EXCLUDED.start_date,
      vesting = EXCLUDED.vesting,
      is_primary = EXCLUDED.is_primary,
      source = EXCLUDED.source,
      notes = EXCLUDED.notes,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 6) Board members roster
-- ----------------------------------------------------------------------------
INSERT INTO board_members (id, management_company_id, community_id, community_name, name, position, term_start, term_end, email, phone, is_active, notes) VALUES
  ('dc120001-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'Drama Creek Estates', 'Sunny Meadows',       'President',                       '2026-01-15', '2027-01-14', 'sunny@dramacreekhoa.demo',     '(832) 555-0101', TRUE, 'Demo board member.'),
  ('dc120002-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'Drama Creek Estates', 'Byron T. Bylaw',      'Vice President / ACC Chair',      '2026-01-15', '2027-01-14', 'byron@dramacreekhoa.demo',     '(832) 555-0102', TRUE, 'Demo board member.'),
  ('dc120003-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'Drama Creek Estates', 'Cassandra Complaine', 'Secretary',                       '2026-01-15', '2027-01-14', 'cassandra@dramacreekhoa.demo', '(832) 555-0103', TRUE, 'Demo board member.'),
  ('dc120004-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'Drama Creek Estates', 'Tally Hawthorne',     'Treasurer',                       '2026-01-15', '2027-01-14', 'tally@dramacreekhoa.demo',     '(832) 555-0104', TRUE, 'Demo board member.'),
  ('dc120005-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'dc100000-0000-4000-a000-000000000000', 'Drama Creek Estates', 'Felix Goodneighbor',  'Member-at-Large',                 '2026-01-15', '2027-01-14', 'felix@dramacreekhoa.demo',     '(832) 555-0105', TRUE, 'Demo board member.')
ON CONFLICT (id) DO UPDATE
  SET community_id = EXCLUDED.community_id,
      position = EXCLUDED.position,
      term_start = EXCLUDED.term_start,
      term_end = EXCLUDED.term_end,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      is_active = EXCLUDED.is_active,
      notes = EXCLUDED.notes,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 7) Portal users — wire magic-link auth for all 13 demo identities
--    Board members get role='board_member' (they see both homeowner + board
--    portal). Homeowners get role='homeowner'.
-- ----------------------------------------------------------------------------
INSERT INTO portal_users (id, management_company_id, email, full_name, role, status, contact_id, notes) VALUES
  -- Board members
  ('dc140001-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'sunny@dramacreekhoa.demo',     'Sunny Meadows',          'board_member', 'active', 'dc100001-0000-4000-a000-000000000000', 'Demo board access.'),
  ('dc140002-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'byron@dramacreekhoa.demo',     'Byron T. Bylaw',         'board_member', 'active', 'dc100002-0000-4000-a000-000000000000', 'Demo board access.'),
  ('dc140003-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'cassandra@dramacreekhoa.demo', 'Cassandra Complaine',    'board_member', 'active', 'dc100003-0000-4000-a000-000000000000', 'Demo board access.'),
  ('dc140004-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'tally@dramacreekhoa.demo',     'Tally Hawthorne',        'board_member', 'active', 'dc100004-0000-4000-a000-000000000000', 'Demo board access.'),
  ('dc140005-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'felix@dramacreekhoa.demo',     'Felix Goodneighbor',     'board_member', 'active', 'dc100005-0000-4000-a000-000000000000', 'Demo board access.'),
  -- Homeowners
  ('dc140006-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'bob@dramacreekhoa.demo',       'Robert "Bob" Steady',    'homeowner',    'active', 'dc100006-0000-4000-a000-000000000000', 'Demo homeowner — model owner.'),
  ('dc140007-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'jennifer@dramacreekhoa.demo',  'Jennifer Lateleaves',    'homeowner',    'active', 'dc100007-0000-4000-a000-000000000000', 'Demo homeowner — active enforcement.'),
  ('dc140008-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'marcus@dramacreekhoa.demo',    'Marcus Behindbills',     'homeowner',    'active', 'dc100008-0000-4000-a000-000000000000', 'Demo homeowner — payment plan.'),
  ('dc140009-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'patricia@dramacreekhoa.demo',  'Patricia Newpaint',      'homeowner',    'active', 'dc100009-0000-4000-a000-000000000000', 'Demo homeowner — ACC in review.'),
  ('dc14000a-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'greg@dramacreekhoa.demo',      'Greg Yardgone',          'homeowner',    'active', 'dc10000a-0000-4000-a000-000000000000', 'Demo homeowner — at-legal.'),
  ('dc14000b-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'sarah@dramacreekhoa.demo',     'Sarah Welcome',          'homeowner',    'active', 'dc10000b-0000-4000-a000-000000000000', 'Demo homeowner — new owner.'),
  ('dc14000c-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'margaret@dramacreekhoa.demo',  'Margaret Foundingmember','homeowner',    'active', 'dc10000c-0000-4000-a000-000000000000', 'Demo homeowner — long-tenured.'),
  ('dc14000d-0000-4000-a000-000000000000', '00000000-0000-0000-0000-000000000001', 'tom@dramacreekhoa.demo',       'Tom Investorson',        'homeowner',    'active', 'dc10000d-0000-4000-a000-000000000000', 'Demo homeowner — investor/landlord.')
ON CONFLICT (management_company_id, email) DO UPDATE
  SET full_name = EXCLUDED.full_name,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      contact_id = EXCLUDED.contact_id,
      notes = EXCLUDED.notes,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- 8) Portal user ↔ property grants
--    Each portal user is scoped to the property they own. Magic-link auth
--    will land them on the right property tile when they sign in.
-- ----------------------------------------------------------------------------
INSERT INTO portal_user_properties (portal_user_id, property_id, granted_by, notes) VALUES
  -- Board
  ('dc140001-0000-4000-a000-000000000000', 'dc110005-0000-4000-a000-000000000000', 'migration_184', 'Demo board grant.'),
  ('dc140002-0000-4000-a000-000000000000', 'dc110031-0000-4000-a000-000000000000', 'migration_184', 'Demo board grant.'),
  ('dc140003-0000-4000-a000-000000000000', 'dc110023-0000-4000-a000-000000000000', 'migration_184', 'Demo board grant.'),
  ('dc140004-0000-4000-a000-000000000000', 'dc110015-0000-4000-a000-000000000000', 'migration_184', 'Demo board grant.'),
  ('dc140005-0000-4000-a000-000000000000', 'dc110043-0000-4000-a000-000000000000', 'migration_184', 'Demo board grant.'),
  -- Homeowners
  ('dc140006-0000-4000-a000-000000000000', 'dc110001-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc140007-0000-4000-a000-000000000000', 'dc110011-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc140008-0000-4000-a000-000000000000', 'dc110021-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc140009-0000-4000-a000-000000000000', 'dc110035-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc14000a-0000-4000-a000-000000000000', 'dc110041-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc14000b-0000-4000-a000-000000000000', 'dc110050-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc14000c-0000-4000-a000-000000000000', 'dc110010-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.'),
  ('dc14000d-0000-4000-a000-000000000000', 'dc110030-0000-4000-a000-000000000000', 'migration_184', 'Demo homeowner grant.')
ON CONFLICT (portal_user_id, property_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 9) Board-portal community grant — board members see this community
--    in the portal_user_communities table.
-- ----------------------------------------------------------------------------
INSERT INTO portal_user_communities (portal_user_id, community_id, granted_by, notes)
SELECT pu.id, 'dc100000-0000-4000-a000-000000000000'::uuid, 'migration_184', 'Demo board community grant.'
FROM portal_users pu
WHERE pu.email IN (
  'sunny@dramacreekhoa.demo',
  'byron@dramacreekhoa.demo',
  'cassandra@dramacreekhoa.demo',
  'tally@dramacreekhoa.demo',
  'felix@dramacreekhoa.demo'
)
ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After applying, expected counts:
--
--   SELECT count(*) FROM communities WHERE is_demo = TRUE;              -- 1
--   SELECT count(*) FROM properties WHERE community_id = 'dc100000-0000-4000-a000-000000000000';   -- 80
--   SELECT count(*) FROM contacts WHERE primary_email LIKE '%@dramacreekhoa.demo';                 -- 13
--   SELECT count(*) FROM property_ownerships WHERE notes LIKE '%Demo%' OR property_id IN
--     (SELECT id FROM properties WHERE community_id = 'dc100000-0000-4000-a000-000000000000');     -- 13
--   SELECT count(*) FROM board_members WHERE community_id = 'dc100000-0000-4000-a000-000000000000';-- 5
--   SELECT count(*) FROM portal_users WHERE email LIKE '%@dramacreekhoa.demo';                     -- 13
-- ============================================================================
