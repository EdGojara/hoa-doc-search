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

-- Seed Bedrock's 7 communities. Source: Texas Property Code §209
-- public filings + each community's recorded CCRs.
UPDATE communities SET city = 'Richmond',     state = 'TX', zip = '77407'
  WHERE community_name ILIKE 'Waterview%';

UPDATE communities SET city = 'Katy',         state = 'TX', zip = '77494'
  WHERE community_name ILIKE 'Canyon Gate%';

UPDATE communities SET city = 'Houston',      state = 'TX', zip = '77084'
  WHERE community_name ILIKE 'Lakes of Pine Forest%';

UPDATE communities SET city = 'Houston',      state = 'TX', zip = '77084'
  WHERE community_name ILIKE 'Eaglewood%';

UPDATE communities SET city = 'Spring',       state = 'TX', zip = '77373'
  WHERE community_name ILIKE 'Quail Ridge%';

UPDATE communities SET city = 'Bryan',        state = 'TX', zip = '77808'
  WHERE community_name ILIKE 'Still Creek Ranch%';

UPDATE communities SET city = 'Houston',      state = 'TX', zip = '77073'
  WHERE community_name ILIKE 'August Meadows%';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT community_name, city, state, zip
-- FROM communities
-- ORDER BY community_name;
