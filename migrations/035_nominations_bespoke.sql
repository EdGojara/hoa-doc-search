-- ============================================================================
-- 035_nominations_bespoke.sql
-- ----------------------------------------------------------------------------
-- Per-cycle customization knobs so each community's call-for-nominations
-- feels like itself — bio prompt style, on-site drop-off, proxy teaser,
-- expectations blurb, reference (prior year) letter upload.
--
-- Apply AFTER 034. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS bio_prompt_style          TEXT NOT NULL DEFAULT 'simple'
    CHECK (bio_prompt_style IN ('simple','structured')),
  ADD COLUMN IF NOT EXISTS onsite_drop_off           JSONB NOT NULL DEFAULT '{"enabled":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS proxy_teaser              BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS expectations_blurb        TEXT NULL,
  ADD COLUMN IF NOT EXISTS reference_letter_path     TEXT NULL;

-- Structured-bio fields on nominations (only used when cycle.bio_prompt_style='structured')
ALTER TABLE nominations
  ADD COLUMN IF NOT EXISTS occupation                TEXT NULL,
  ADD COLUMN IF NOT EXISTS education                 TEXT NULL,
  ADD COLUMN IF NOT EXISTS outside_activities        TEXT NULL,
  ADD COLUMN IF NOT EXISTS asset_reason              TEXT NULL;

COMMIT;

-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='nomination_cycles' AND column_name IN
--      ('bio_prompt_style','onsite_drop_off','proxy_teaser','expectations_blurb','reference_letter_path');
