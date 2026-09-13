-- ============================================================================
-- 422_language_hindi.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Add Hindi ('hi') as a supported language for Priya (Hindi front-office
-- persona), mirroring the zh add (mig 421). Widen the language CHECKs on
-- claire_sessions + claire_explainers, and contacts.preferred_language, to
-- include 'hi'. Keeping the three lists in sync so a Hindi session/contact
-- doesn't hit a constraint the way Mandarin did.
-- ============================================================================
BEGIN;

ALTER TABLE claire_sessions   DROP CONSTRAINT IF EXISTS claire_sessions_language_check;
ALTER TABLE claire_sessions   ADD  CONSTRAINT claire_sessions_language_check
  CHECK (language IN ('en', 'es', 'zh', 'vi', 'ko', 'hi'));

ALTER TABLE claire_explainers DROP CONSTRAINT IF EXISTS claire_explainers_language_check;
ALTER TABLE claire_explainers ADD  CONSTRAINT claire_explainers_language_check
  CHECK (language IN ('en', 'es', 'zh', 'vi', 'ko', 'hi'));

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_preferred_language_check;
ALTER TABLE contacts ADD  CONSTRAINT contacts_preferred_language_check
  CHECK (preferred_language IS NULL OR preferred_language IN ('en', 'es', 'zh', 'vi', 'ko', 'hi'));

COMMIT;
