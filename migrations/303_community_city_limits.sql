-- ============================================================================
-- 303_community_city_limits.sql  (Ed 2026-07-16)
-- ----------------------------------------------------------------------------
-- Ed: "waterview eaglewood still creek august meadows quail ridge are not in
-- city limits they are county only. i need to check about lakes of pine forest
-- and canyon gate."
--
-- The mailing city (communities.city) is NOT the same as being inside a city's
-- limits. August Meadows has a "Needville" mailing address but sits in
-- unincorporated Fort Bend County — so for law enforcement, noise ordinances,
-- and nuisance complaints the COUNTY has jurisdiction, not a city. Claire told a
-- homeowner to "contact the city" about a noise ordinance; for these communities
-- that sends them to an agency with no authority over them. This flag lets every
-- reply point to the right government body.
--
--   in_city_limits = FALSE  -> unincorporated; the county handles ordinances
--   in_city_limits = TRUE   -> inside a city's limits; the city applies
--   in_city_limits = NULL   -> not yet confirmed (say so; don't assert a city)
--
-- Record ownership: association_record (per community).
-- ============================================================================

BEGIN;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS in_city_limits BOOLEAN;

COMMENT ON COLUMN communities.in_city_limits IS
  'TRUE = inside a city''s limits (the city has ordinance/enforcement jurisdiction). FALSE = unincorporated, county-only (mailing city is not the jurisdiction). NULL = not yet confirmed. Ed 2026-07-16.';

-- Confirmed county-only (Ed 2026-07-16).
UPDATE communities SET in_city_limits = FALSE
 WHERE name ILIKE ANY (ARRAY['%waterview%', '%eaglewood%', '%still creek%', '%august meadows%', '%quail ridge%']);

-- Lakes of Pine Forest and Canyon Gate are deliberately left NULL until Ed
-- confirms — an unconfirmed guess is worse than "we'll check."

COMMIT;
