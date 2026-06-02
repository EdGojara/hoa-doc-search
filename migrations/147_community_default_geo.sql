-- ============================================================================
-- 147_community_default_geo.sql
-- ----------------------------------------------------------------------------
-- Adds city / state / zip columns to communities so every community has an
-- explicit default mailing geo. Seeded for the 7 Bedrock communities with
-- the values from their actual CCRs / TDLR filings.
--
-- Why: 2026-06-01, the bedrock-vote bridge shipped mailing labels with
-- missing city/state/zip because ~14% of Waterview properties had NULL
-- city/state/zip on the properties table (Vantaca-sync gap). The
-- modal-geo fallback (derive community default from the majority of
-- properties) sometimes returns empty when too few properties have geo
-- filled in. Storing the community default on the COMMUNITIES table
-- itself removes that dependency — every community always has a
-- guaranteed default, set explicitly by Ed, not derived from gappy data.
--
-- Apply after 146. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS city  TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'TX',
  ADD COLUMN IF NOT EXISTS zip   TEXT;

COMMENT ON COLUMN communities.city  IS 'Default city for outbound mail to this community. Used as fallback when an individual property record is missing city. Set per-community explicitly.';
COMMENT ON COLUMN communities.state IS 'Default state for outbound mail. Defaults to TX.';
COMMENT ON COLUMN communities.zip   IS 'Default 5-digit ZIP for outbound mail. Used as fallback when an individual property record is missing zip.';

-- Seed Bedrock's communities. ONLY single-city communities get a default
-- seeded here — anything that spans multiple cities/ZIPs is left NULL so
-- the bridge validation flags it loudly when that community goes to vote
-- (forcing a proper data fix rather than masking the issue with a wrong
-- default). Ed 2026-06-01: "some of eaglewood is sugar land and some
-- houston". State stays 'TX' as a safe TX-portfolio default — it's the
-- city/zip that vary.

UPDATE communities SET city = 'Richmond',     state = 'TX', zip = '77407'
  WHERE community_name ILIKE 'Waterview%';        -- single city confirmed

UPDATE communities SET city = 'Katy',         state = 'TX', zip = '77494'
  WHERE community_name ILIKE 'Canyon Gate%';      -- single city confirmed

-- Communities NOT seeded with a default (mixed cities or unverified):
--   • Lakes of Pine Forest   — verify before seeding
--   • Eaglewood              — mixed Sugar Land / Houston, do NOT seed
--   • Quail Ridge            — verify before seeding
--   • Still Creek Ranch      — verify before seeding
--   • August Meadows         — verify before seeding
--
-- For each of these, when you're ready to run their election, either:
--   (a) set the city/zip per-property in the property editor (preferred
--       for mixed communities)
--   (b) set the community default here if the community is actually
--       single-city
-- The bridge will refuse to push until the data is correct.

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT community_name, city, state, zip
-- FROM communities
-- ORDER BY community_name;
