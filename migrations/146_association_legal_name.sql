-- ============================================================================
-- 146_association_legal_name.sql
-- ----------------------------------------------------------------------------
-- Adds association_legal_name to nomination_cycles. The AMN renderer already
-- reads cycle.association_legal_name (to print the formal entity name in
-- the meeting notice + ballot + proxy paragraphs) but no migration ever
-- declared the column. Same silent-drift pattern as electronic_voting_offered
-- (migration 143) — every write was getting dropped, every read returned
-- NULL, and the fallback `${communityName} Association, Inc.` produced
-- "Waterview Estates Association, Inc." which is NOT Waterview's actual
-- legal name. The real name is "Waterview Estates Owners' Association"
-- (per their 2025 mailing packet and recorded CCRs).
--
-- Seeds the known legal names for the current Bedrock book so existing
-- cycles regenerate correctly:
--   Waterview Estates       → Waterview Estates Owners' Association
--   Canyon Gate at Cinco R. → Canyon Gate at Cinco Ranch Association, Inc.
--   Lakes of Pine Forest    → Lakes of Pine Forest Community Improvement Assn., Inc.
--   Eaglewood               → Eaglewood Property Owners Association, Inc.
--   Quail Ridge             → Quail Ridge Property Owners Association, Inc.
--   Still Creek Ranch       → Still Creek Ranch Homeowners Association, Inc.
--   August Meadows          → August Meadows Community Association, Inc.
--
-- TODO: long-term these belong on the communities table (legal_name column)
-- since they don't change per cycle. Per-cycle storage here is the tactical
-- fix that gets the renderer correct for the next mailing without a bigger
-- schema migration.
--
-- Apply after 145. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS association_legal_name TEXT;

COMMENT ON COLUMN nomination_cycles.association_legal_name IS
  'Formal legal entity name as recorded on the CC&Rs (e.g., "Waterview Estates Owners'' Association"). Used in the meeting notice + proxy + ballot text. NULL falls back to the renderer''s lookup table or a default derived from community_name.';

-- Seed the known legal names for the existing Bedrock communities. Only
-- updates rows where the field is currently NULL — preserves any earlier
-- operator overrides.
UPDATE nomination_cycles SET association_legal_name = 'Waterview Estates Owners'' Association'
  WHERE community_name ILIKE 'Waterview%' AND association_legal_name IS NULL;

UPDATE nomination_cycles SET association_legal_name = 'Canyon Gate at Cinco Ranch Association, Inc.'
  WHERE (community_name ILIKE 'Canyon Gate%' OR community_name = 'Canyon Gate') AND association_legal_name IS NULL;

UPDATE nomination_cycles SET association_legal_name = 'Lakes of Pine Forest Community Improvement Association, Inc.'
  WHERE community_name ILIKE 'Lakes of Pine Forest%' AND association_legal_name IS NULL;

UPDATE nomination_cycles SET association_legal_name = 'Eaglewood Property Owners Association, Inc.'
  WHERE community_name ILIKE 'Eaglewood%' AND association_legal_name IS NULL;

UPDATE nomination_cycles SET association_legal_name = 'Quail Ridge Property Owners Association, Inc.'
  WHERE community_name ILIKE 'Quail Ridge%' AND association_legal_name IS NULL;

UPDATE nomination_cycles SET association_legal_name = 'Still Creek Ranch Homeowners Association, Inc.'
  WHERE community_name ILIKE 'Still Creek Ranch%' AND association_legal_name IS NULL;

UPDATE nomination_cycles SET association_legal_name = 'August Meadows Community Association, Inc.'
  WHERE community_name ILIKE 'August Meadows%' AND association_legal_name IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT community_name, annual_meeting_date, association_legal_name, status
-- FROM nomination_cycles
-- ORDER BY annual_meeting_date DESC;
