-- ============================================================================
-- 137_builder_company_communities.sql
-- ----------------------------------------------------------------------------
-- Adds builder_companies.active_community_ids JSONB to capture which
-- communities each builder is currently building at. Today this is a 1:1
-- mapping at Bedrock (DRB → August Meadows, Lennar → Still Creek Ranch)
-- but the structure supports many-to-many for future communities where
-- multiple builders share a section, or builders span multiple
-- communities.
--
-- Why JSONB instead of a join table:
--   • Today's volume is 2 builders × 1-2 communities each — a join table
--     is over-engineered for that scale.
--   • The relationship is rare-change: a builder gets added to a community
--     when Bedrock signs a developer agreement. Once or twice a year.
--   • Querying "what communities does this builder build at" is a single
--     JSONB read; "what builders build at this community" is a JSONB
--     `?` operator with GIN index — both fast.
--   • Future migration to a proper join table is trivial if needed.
--
-- Seeds:
--   DRB Group → August Meadows
--   Lennar    → Still Creek Ranch
--
-- Idempotent. Apply after 136.
-- ============================================================================

BEGIN;

ALTER TABLE builder_companies
  ADD COLUMN IF NOT EXISTS active_community_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN builder_companies.active_community_ids IS
  'JSONB array of community UUIDs this builder is currently building at. Drives the auto-check-community-on-builder-pick UX in bulk + single master plan upload modals (2026-05-29 build). Updated by ops when Bedrock signs a new developer agreement bringing a builder to a community.';

-- GIN index for the inverse query ("which builders build at community X")
CREATE INDEX IF NOT EXISTS idx_builder_companies_active_communities
  ON builder_companies USING GIN (active_community_ids);

-- Seed: DRB Group → August Meadows
UPDATE builder_companies
SET active_community_ids = (
  SELECT COALESCE(jsonb_agg(DISTINCT c.id), '[]'::jsonb)
  FROM communities c
  WHERE c.management_company_id = '00000000-0000-0000-0000-000000000001'
    AND c.name = 'August Meadows'
)
WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
  AND LOWER(company_name) = 'drb group';

-- Seed: Lennar → Still Creek Ranch
UPDATE builder_companies
SET active_community_ids = (
  SELECT COALESCE(jsonb_agg(DISTINCT c.id), '[]'::jsonb)
  FROM communities c
  WHERE c.management_company_id = '00000000-0000-0000-0000-000000000001'
    AND c.name = 'Still Creek Ranch'
)
WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
  AND LOWER(company_name) = 'lennar';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT bc.company_name, jsonb_array_length(bc.active_community_ids) AS community_count,
--        (SELECT string_agg(c.name, ', ' ORDER BY c.name)
--         FROM communities c
--         WHERE c.id::text = ANY(SELECT jsonb_array_elements_text(bc.active_community_ids)))
--          AS community_names
-- FROM builder_companies bc
-- WHERE bc.management_company_id = '00000000-0000-0000-0000-000000000001'
-- ORDER BY bc.company_name;
