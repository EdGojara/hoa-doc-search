-- ============================================================================
-- 020_community_slugs.sql
-- ----------------------------------------------------------------------------
-- Add URL-safe slugs to communities so owner-facing URLs can be human-readable.
--
-- Before: my.bedrocktxai.com/f/01db4b77-1760-4f78-be42-aca5a88d4e48
-- After:  my.bedrocktxai.com/f/lpf-arc
--
-- The slug resolves to the CURRENT version of a (community, form_category)
-- combination. New uploads auto-supersede; the slug stays the same and
-- always serves the latest. URLs in old emails keep working forever.
--
-- Apply AFTER 019. Idempotent.
-- ============================================================================

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS slug TEXT;

-- Unique within a management company. NULL allowed for any not-yet-set.
CREATE UNIQUE INDEX IF NOT EXISTS ux_communities_slug_per_mgmt
  ON communities(management_company_id, slug)
  WHERE slug IS NOT NULL;

-- Seed Bedrock's known communities with curated slugs.
-- Curated > auto-generated for owner-facing URLs (lpf > lakes-of-pine-forest).
-- WHERE slug IS NULL guard makes this idempotent.
UPDATE communities SET slug = 'lpf'         WHERE name ILIKE 'Lakes of Pine Forest%' AND slug IS NULL;
UPDATE communities SET slug = 'eaglewood'   WHERE name ILIKE 'Eaglewood%'            AND slug IS NULL;
UPDATE communities SET slug = 'canyon-gate' WHERE name ILIKE 'Canyon Gate%'          AND slug IS NULL;
UPDATE communities SET slug = 'waterview'   WHERE name ILIKE 'Waterview%'            AND slug IS NULL;
UPDATE communities SET slug = 'quail-ridge' WHERE name ILIKE 'Quail Ridge%'          AND slug IS NULL;
UPDATE communities SET slug = 'august-meadows' WHERE name ILIKE 'August Meadows%'    AND slug IS NULL;

-- Auto-slug anything still without a slug (URL-safe lowercase with dashes).
-- e.g., "Some Other HOA" → "some-other-hoa"
-- Trims leading/trailing dashes. Ed can override via admin UI later if needed.
UPDATE communities
   SET slug = TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g')))
 WHERE slug IS NULL
   AND name IS NOT NULL;

-- Verify:
--   SELECT name, slug FROM communities
--    WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--    ORDER BY name;
