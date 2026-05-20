-- ============================================================================
-- 079_enforcement_authority_citation.sql
-- ----------------------------------------------------------------------------
-- Adds a per-community enforcement-authority citation that prints inside the
-- Authority statement on every violation letter.
--
-- WHY THIS EXISTS:
--   Today every letter says "...pursuant to the Association's CC&Rs which
--   grants the Board the authority to enforce architectural and covenant
--   standards." That's true but generic — a homeowner reading a courtesy
--   notice has no way to point to a specific article/section. This field
--   lets staff (or counsel review) drop in the exact citation, e.g.:
--     "Article VII, Section 7.3 of the Declaration"
--   which then renders inside the existing authority paragraph.
--
-- IDEMPOTENT: re-runnable via ADD COLUMN IF NOT EXISTS.
-- ============================================================================

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS enforcement_authority_citation TEXT;

COMMENT ON COLUMN communities.enforcement_authority_citation IS
  'Per-community CC&R article/section citation injected into the Authority statement on every violation letter. Example: "Article VII, Section 7.3 of the Declaration". Optional — falls back to the generic CC&R reference when blank.';
