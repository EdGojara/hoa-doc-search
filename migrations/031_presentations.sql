-- ============================================================================
-- 031_presentations.sql
-- ----------------------------------------------------------------------------
-- Tables for the in-app Presentations module. A "presentation" is one generated
-- .pptx file produced from a template + form variables + optional uploaded
-- images. We index every generation so the user can re-download past decks and
-- so we can mine pitch history later (who we pitched, what we offered, win/loss
-- — that's the compound-learning play).
--
-- Apply AFTER 030. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS presentation_instances (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id   UUID NOT NULL,
  community_id            UUID NULL,
  template_slug           TEXT NOT NULL,
  title                   TEXT NOT NULL,
  variables               JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_storage_path     TEXT NULL,
  output_filename         TEXT NULL,
  status                  TEXT NOT NULL DEFAULT 'generated'
                            CHECK (status IN ('draft', 'generated', 'failed')),
  created_by              TEXT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS presentation_assets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id             UUID NOT NULL REFERENCES presentation_instances(id) ON DELETE CASCADE,
  slot_key                TEXT NOT NULL,
  storage_path            TEXT NOT NULL,
  mime_type               TEXT NULL,
  display_order           INT NOT NULL DEFAULT 0,
  meta                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_presentation_instances_mgmt_created
  ON presentation_instances (management_company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_presentation_instances_template
  ON presentation_instances (template_slug);

CREATE INDEX IF NOT EXISTS idx_presentation_assets_instance
  ON presentation_assets (instance_id);

-- Belt-and-suspenders permission grants (same pattern as 030)
GRANT SELECT, INSERT, UPDATE, DELETE ON presentation_instances TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON presentation_assets    TO anon, authenticated, service_role;

COMMIT;

-- Verify:
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('presentation_instances','presentation_assets');
