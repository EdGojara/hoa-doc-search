-- 350_newsletter_flyer_format.sql
-- Ed 2026-08-03 — Add 'flyer' as a publication format. A flyer is a single-page
-- event poster: the SAME issue+section infrastructure as the newsletter, with
-- format_key='flyer' and one section (section_type='flyer') holding the event
-- fields. Reuses list / preview / PDF; adds a poster renderer + PNG + email.

BEGIN;

ALTER TABLE newsletter_issues DROP CONSTRAINT IF EXISTS newsletter_issues_format_key_check;
ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_format_key_check
  CHECK (format_key IN ('community_update','community_magazine','announcement','flyer'));

COMMIT;
