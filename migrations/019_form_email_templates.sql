-- ============================================================================
-- 019_form_email_templates.sql
-- ----------------------------------------------------------------------------
-- Per-category email templates for the Forms & Applications send-to-owner
-- workflow. Each template has a subject + body with placeholder variables
-- that get substituted at send time:
--   {community_name}   → "Eaglewood"
--   {form_title}       → "Eaglewood ARC Application"
--   {download_link}    → full URL to /api/documents/:id/download
--   {bedrock_phone}    → "(832) 588-2485"
--   {bedrock_email}    → "info@bedrocktx.com"
--   {recipient_name}   → optional, if user provides one
--
-- Apply AFTER 018. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS form_email_templates (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  category                 TEXT NOT NULL REFERENCES document_categories(category),
  subject_template         TEXT NOT NULL,
  body_template            TEXT NOT NULL,
  notes                    TEXT,
  updated_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (management_company_id, category)
);

DROP TRIGGER IF EXISTS trg_form_email_templates_updated_at ON form_email_templates;
CREATE TRIGGER trg_form_email_templates_updated_at
  BEFORE UPDATE ON form_email_templates
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE form_email_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_form_email_templates_tenant ON form_email_templates;
CREATE POLICY p_form_email_templates_tenant ON form_email_templates
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

GRANT ALL ON form_email_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON form_email_templates TO authenticated;

-- Seed defaults for the three form categories.
-- These are the OPENING DEFAULTS — Ed can edit them in-app and the edits
-- persist (one editable template per management_company × category).
INSERT INTO form_email_templates (management_company_id, category, subject_template, body_template) VALUES
  ('00000000-0000-0000-0000-000000000001', 'arc_application',
   '{community_name} Architectural Review Application',
   E'Hi{recipient_name_or_empty},\n\nThank you for reaching out about the architectural review process at {community_name}. Linked below is the application form you''ll need to complete and submit before beginning your project.\n\nA few things to keep in mind:\n\n  • Submit the completed application at least 14 days before you plan to begin work\n  • Include all required attachments (site plan or survey, photos, color samples, material specs, contractor bid if applicable)\n  • The Architectural Control Committee reviews submissions on a rolling basis and we''ll respond within 30 days\n\nDownload the application form here:\n{download_link}\n\nIf you have questions about the process or need help completing the form, just reply to this email or reach us at {bedrock_phone}.\n\nThanks,\nBedrock Association Management\n{bedrock_phone} · {bedrock_email}'),
  ('00000000-0000-0000-0000-000000000001', 'key_fob_form',
   '{community_name} Pool / Amenity Access Request',
   E'Hi{recipient_name_or_empty},\n\nHere''s the key fob / amenity access application form for {community_name}.\n\nTo request a fob:\n\n  1. Download the form using the link below\n  2. Complete it with your unit address and contact info\n  3. Return it by email ({bedrock_email}) or drop it off at our office\n  4. We''ll process the request and contact you when the fob is ready for pickup\n\nForm: {download_link}\n\nA quick note: please keep your fob secure. Lost or stolen fobs require a replacement fee, and we''re required to deactivate the missing one to protect the community.\n\nThanks,\nBedrock Association Management\n{bedrock_phone} · {bedrock_email}'),
  ('00000000-0000-0000-0000-000000000001', 'forms_and_applications',
   '{community_name} — {form_title}',
   E'Hi{recipient_name_or_empty},\n\nHere''s the form you requested for {community_name}:\n\n{form_title}\n\nDownload: {download_link}\n\nPlease complete the form and return it to us at {bedrock_email}, or reach out if you have any questions about how to fill it out.\n\nThanks,\nBedrock Association Management\n{bedrock_phone} · {bedrock_email}')
ON CONFLICT (management_company_id, category) DO NOTHING;

-- Verify:
--   SELECT category, subject_template FROM form_email_templates
--    WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--    ORDER BY category;
--   -- expect 3 rows
