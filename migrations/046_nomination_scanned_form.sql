-- ============================================================================
-- 046_nomination_scanned_form.sql
-- ----------------------------------------------------------------------------
-- Adds a path for an uploaded scanned-form file (PDF or image) attached to
-- a nomination. Parallels photo_storage_path (migration 044) and supports
-- the dual-path public form: homeowners can either fill the form online OR
-- upload a snapshot/scan of a handwritten paper form. Either way, the
-- nomination row flows through the same on_slate → ballot pipeline.
--
-- Apply AFTER 045. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nominations
  ADD COLUMN IF NOT EXISTS scanned_form_path  TEXT NULL,
  ADD COLUMN IF NOT EXISTS scanned_form_mime  TEXT NULL;

COMMIT;

-- Verify:
--   SELECT id, nominee_name,
--          (photo_storage_path IS NOT NULL) AS has_photo,
--          (scanned_form_path  IS NOT NULL) AS has_scanned_form
--     FROM nominations ORDER BY created_at DESC LIMIT 10;
