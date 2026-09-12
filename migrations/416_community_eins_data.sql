-- ============================================================================
-- 416_community_eins_data.sql  (Ed 2026-09-12)
-- ----------------------------------------------------------------------------
-- Populate each HOA's EIN + tax classification so the W-9 generator (/admin/w9)
-- can produce a filled Form W-9 per association. Values verified per entity
-- against each association's own IRS record (CP 575 / Form 1120-H), never
-- guessed. This is the SQL equivalent of scripts/set_community_eins.js so the
-- whole rollout is one paste in the Supabase SQL editor (no Node script).
--
-- Depends on migration 415 (adds communities.ein + tax_classification).
-- Idempotent: safe to re-run; UPDATE by name match, legal name only set if blank.
--
-- August Meadows is intentionally omitted: SS-4 application only, no EIN issued
-- yet. Add it here once the IRS assigns one.
-- ============================================================================
BEGIN;

-- Waterview Estates
UPDATE communities SET
  ein = '20-1283917',
  tax_classification = 'Homeowners association (files Form 1120-H)',
  hoa_legal_name = COALESCE(NULLIF(hoa_legal_name, ''), 'Waterview Estates Owners Association, Inc.')
WHERE name ILIKE '%Waterview Estates%';

-- Canyon Gate at Cinco Ranch
UPDATE communities SET
  ein = '76-0555731',
  tax_classification = 'Homeowners association (files Form 1120-H)',
  hoa_legal_name = COALESCE(NULLIF(hoa_legal_name, ''), 'Canyon Gate at Cinco Ranch Owners Association, Inc.')
WHERE name ILIKE '%Canyon Gate%';

-- Lakes of Pine Forest
UPDATE communities SET
  ein = '81-0633206',
  tax_classification = 'Homeowners association (files Form 1120-H)',
  hoa_legal_name = COALESCE(NULLIF(hoa_legal_name, ''), 'Lakes of Pine Forest Homeowners Association, Inc.')
WHERE name ILIKE '%Lakes of Pine Forest%';

-- Eaglewood
UPDATE communities SET
  ein = '76-0652489',
  tax_classification = 'Homeowners association (files Form 1120-H)',
  hoa_legal_name = COALESCE(NULLIF(hoa_legal_name, ''), 'Eaglewood Homeowners Association, Inc.')
WHERE name ILIKE '%Eaglewood%';

-- Quail Ridge
UPDATE communities SET
  ein = '83-0643630',
  tax_classification = 'Homeowners association (files Form 1120-H)',
  hoa_legal_name = COALESCE(NULLIF(hoa_legal_name, ''), 'Quail Ridge Homeowners Association, Inc.')
WHERE name ILIKE '%Quail Ridge%';

-- Still Creek Ranch
UPDATE communities SET
  ein = '83-4450035',
  tax_classification = 'Homeowners association (files Form 1120-H)',
  hoa_legal_name = COALESCE(NULLIF(hoa_legal_name, ''), 'Still Creek Ranch Homeowners Association, Inc.')
WHERE name ILIKE '%Still Creek Ranch%';

COMMIT;

-- Verify:
--   SELECT name, hoa_legal_name, ein, tax_classification FROM communities
--   WHERE ein IS NOT NULL ORDER BY name;
