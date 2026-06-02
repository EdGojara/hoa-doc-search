-- ============================================================================
-- 148_community_default_geo_fix.sql
-- ----------------------------------------------------------------------------
-- Migration 147 failed because it referenced `community_name` (which only
-- exists on denormalized children like nomination_cycles), not `name`
-- (the actual column on the communities table). It also tried to add the
-- `state` column which already exists on communities since 001_foundation.
--
-- 148 does what 147 was supposed to: adds city + zip (state was already
-- there), seeds Waterview + Canyon Gate (the two single-city Bedrock
-- communities) using the correct `name` column. Other communities stay
-- NULL — the bridge validation flags them loudly when they go to vote,
-- prompting per-property data fixes (Eaglewood spans Sugar Land + Houston
-- so a single default would lie about half the community).
--
-- Apply after 147 (147 partially failed but had no effect — the BEGIN/
-- COMMIT block rolled back the ALTER TABLE too).
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS zip  TEXT;
-- state already exists since migration 001_foundation (line 99, DEFAULT 'TX').

COMMENT ON COLUMN communities.city IS 'Default city for outbound mail to this community. Used as fallback when an individual property record is missing city. NULL for communities spanning multiple cities (use per-property data instead).';
COMMENT ON COLUMN communities.zip  IS 'Default 5-digit ZIP for outbound mail. Same NULL semantics as city.';

UPDATE communities SET city = 'Richmond', zip = '77407'
  WHERE name ILIKE 'Waterview%';

UPDATE communities SET city = 'Katy',     zip = '77494'
  WHERE name ILIKE 'Canyon Gate%';

-- Intentionally NOT seeded (mixed-city or unverified): Lakes of Pine
-- Forest, Eaglewood, Quail Ridge, Still Creek Ranch, August Meadows.

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT name, city, state, zip FROM communities ORDER BY name;
