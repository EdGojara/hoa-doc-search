-- ============================================================================
-- 421_claire_language_zh.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Mei (Mandarin) sessions were rejected: claire_sessions.language had a CHECK
-- of ('en','es') from mig 366, so starting a zh visit violated it. Widen the
-- language CHECK on claire_sessions (and claire_explainers, same constraint) to
-- the full supported set — matching contacts.preferred_language (mig 107:
-- en/es/zh/vi/ko) so it's one consistent language list and future languages
-- (Vietnamese, Korean) don't hit this again.
-- ============================================================================
BEGIN;

ALTER TABLE claire_sessions   DROP CONSTRAINT IF EXISTS claire_sessions_language_check;
ALTER TABLE claire_sessions   ADD  CONSTRAINT claire_sessions_language_check
  CHECK (language IN ('en', 'es', 'zh', 'vi', 'ko'));

ALTER TABLE claire_explainers DROP CONSTRAINT IF EXISTS claire_explainers_language_check;
ALTER TABLE claire_explainers ADD  CONSTRAINT claire_explainers_language_check
  CHECK (language IN ('en', 'es', 'zh', 'vi', 'ko'));

COMMIT;

-- Verify:
--   INSERT ... language='zh' into claire_sessions should now succeed.
