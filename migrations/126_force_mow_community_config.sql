-- ============================================================================
-- 126_force_mow_community_config.sql
-- ----------------------------------------------------------------------------
-- Adds per-community configuration for the lawn 10-day certified force-mow
-- letter (templates/lawn-force-mow-letter.gold-standard.md +
-- lib/lawn_force_mow_renderer.js).
--
-- Different communities have different Declarations with different recording
-- info, different article numbers authorizing force-mow, and different fee
-- schedules. The renderer pulls these from the community row at render time;
-- the template stays community-agnostic.
--
-- Apply AFTER 125. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS declaration_doc_number          TEXT,
  ADD COLUMN IF NOT EXISTS declaration_county              TEXT,
  ADD COLUMN IF NOT EXISTS declaration_short_name          TEXT,
  ADD COLUMN IF NOT EXISTS force_mow_section_full          TEXT,
  ADD COLUMN IF NOT EXISTS force_mow_admin_fee_cents       INTEGER DEFAULT 2500;

COMMENT ON COLUMN communities.declaration_doc_number IS
  'Recording document number for the Declaration of CC&Rs. e.g., 1999106014. Used in force-mow letter citation.';
COMMENT ON COLUMN communities.declaration_county IS
  'County where the Declaration is recorded. e.g., Fort Bend.';
COMMENT ON COLUMN communities.declaration_short_name IS
  'Subdivision name as cited in the Declaration. e.g., Eaglewood. Falls back to community.name if NULL.';
COMMENT ON COLUMN communities.force_mow_section_full IS
  'Declaration section authorizing force-mow + self-help. e.g., "Article 6.16 of the Declaration". Required for force-mow letter generation.';
COMMENT ON COLUMN communities.force_mow_admin_fee_cents IS
  'Administrative fee disclosed under §209.006(b)(1). Default 2500 = $25.00.';

-- Seed Eaglewood from the known template (Article 6.16, doc 1999106014, Fort Bend)
UPDATE communities
SET
  declaration_short_name = COALESCE(declaration_short_name, 'Eaglewood'),
  declaration_doc_number = COALESCE(declaration_doc_number, '1999106014'),
  declaration_county = COALESCE(declaration_county, 'Fort Bend'),
  force_mow_section_full = COALESCE(force_mow_section_full, 'Article 6.16 of the Declaration')
WHERE name = 'Eaglewood'
  AND management_company_id = '00000000-0000-0000-0000-000000000001';

COMMIT;
