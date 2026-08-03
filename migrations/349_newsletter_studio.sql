-- 349_newsletter_studio.sql
-- Ed 2026-08-03 — Newsletter Studio (first publication type of the eventual
-- Communications Studio). A newsletter is ASSEMBLED from data already in the
-- platform (calendar events, board, amenities, violation trends, announcements)
-- into modular sections, then rendered to web / email / PDF from ONE source.
--
-- Record ownership: MIXED. A PUBLISHED newsletter is delivered to residents, so
-- it is an association_record; a draft that is never published is a workpaper
-- (Bedrock's internal production process). The row carries record_ownership so
-- the termination export can split them: published issues export, drafts don't.
--
-- section_type is intentionally NOT CHECK-constrained: the section library grows
-- as we add block types, and a DB CHECK would force a migration per new type
-- (the "invent a value" scar). It is validated in app code against
-- NEWSLETTER_SECTION_TYPES (lib/newsletters/section_types.js).

BEGIN;

CREATE TABLE IF NOT EXISTS newsletter_issues (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  management_company_id uuid,
  title                 text NOT NULL,
  slug                  text NOT NULL,
  issue_month           date NOT NULL,               -- first of the issue month
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','review','approved','published','archived')),
  format_key            text NOT NULL DEFAULT 'community_update'
                          CHECK (format_key IN ('community_update','community_magazine','announcement')),
  template_key          text NOT NULL DEFAULT 'community-update',
  cover_image_url       text,
  introduction          text,
  published_at          timestamptz,
  record_ownership      text NOT NULL DEFAULT 'association_record',
  created_by            uuid,
  created_by_name       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, slug)
);

CREATE TABLE IF NOT EXISTS newsletter_sections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_issue_id uuid NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
  section_type        text NOT NULL,                 -- validated in app (NEWSLETTER_SECTION_TYPES)
  title               text,
  subtitle            text,
  body_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_url           text,
  display_order       integer NOT NULL DEFAULT 0,
  page_break_before   boolean NOT NULL DEFAULT false,
  visibility          text[] NOT NULL DEFAULT ARRAY['web','email','pdf'],
  ai_generated        boolean NOT NULL DEFAULT false,
  needs_review        boolean NOT NULL DEFAULT false, -- AI flagged missing/uncertain info
  approval_status     text NOT NULL DEFAULT 'draft'
                        CHECK (approval_status IN ('draft','approved','rejected')),
  source_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS newsletter_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid REFERENCES communities(id) ON DELETE CASCADE,  -- null = global template
  name          text NOT NULL,
  template_key  text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_issues_community ON newsletter_issues (community_id, issue_month DESC);
CREATE INDEX IF NOT EXISTS idx_newsletter_issues_status    ON newsletter_issues (status);
CREATE INDEX IF NOT EXISTS idx_newsletter_sections_issue   ON newsletter_sections (newsletter_issue_id, display_order);

DROP TRIGGER IF EXISTS trg_newsletter_issues_updated_at ON newsletter_issues;
CREATE TRIGGER trg_newsletter_issues_updated_at
  BEFORE UPDATE ON newsletter_issues
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_newsletter_sections_updated_at ON newsletter_sections;
CREATE TRIGGER trg_newsletter_sections_updated_at
  BEFORE UPDATE ON newsletter_sections
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_issues   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_sections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_templates TO service_role;
GRANT SELECT ON newsletter_issues   TO authenticated;
GRANT SELECT ON newsletter_sections TO authenticated;
GRANT SELECT ON newsletter_templates TO authenticated;

COMMIT;
