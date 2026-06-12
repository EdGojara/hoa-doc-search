-- ============================================================================
-- 216_builder_attachments_kind_submission_packet.sql
-- ----------------------------------------------------------------------------
-- Expand builder_application_attachments.kind to allow 'submission_packet'.
--
-- Scar caught 2026-06-11 while backfilling Lennar's pre-portal submissions
-- at Still Creek Ranch (SCR-BLD-2026-0001 through 0007). The DRB Group
-- submission page (builder-submit-drb-am.html) and the new Lennar page
-- (builder-submit-still-creek-lennar.html) both POST attachments with
-- kind='submission_packet' — the semantic intent is "the whole packet PDF,
-- not a single elevation/site plan/etc." But the original migration 080
-- CHECK constraint only allowed the per-document-type values
-- (site_plan, front_elevation, ..., 'other'). 'submission_packet' was
-- rejected silently — the PDF uploaded to storage but the row insert into
-- builder_application_attachments failed, leaving the application without
-- a linked PDF in the review queue.
--
-- This was a latent bug: no DRB submissions had been received in production
-- yet (per audit at script time). Lennar's first portal submission would
-- have hit it. Fixing now before deploy.
--
-- Why expand rather than rewrite forms to use 'other':
--   • 'submission_packet' is more descriptive than 'other' and conveys
--     the operator intent (this is the whole packet, not a stray
--     attachment).
--   • Forms can split attachments out later (one for site_plan, one for
--     elevations, etc.) without breaking the submission_packet semantics.
--   • Rewriting two forms + the form-side intent is more change than
--     one-line constraint update.
--
-- Idempotent. Apply after 215.
-- ============================================================================

BEGIN;

ALTER TABLE builder_application_attachments
  DROP CONSTRAINT IF EXISTS builder_application_attachments_kind_check;

ALTER TABLE builder_application_attachments
  ADD CONSTRAINT builder_application_attachments_kind_check
  CHECK (kind IN (
    'site_plan', 'front_elevation', 'rear_elevation',
    'left_side_elevation', 'right_side_elevation',
    'floor_plan', 'color_board', 'material_sample',
    'plat', 'survey',
    'submission_packet',   -- added 2026-06-11
    'other'
  ));

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- -- Should show the expanded list:
-- SELECT pg_get_constraintdef(c.oid)
-- FROM pg_constraint c
-- JOIN pg_class t ON t.oid = c.conrelid
-- WHERE t.relname = 'builder_application_attachments'
--   AND c.conname = 'builder_application_attachments_kind_check';
--
-- -- Insert sanity check:
-- INSERT INTO builder_application_attachments
--   (application_id, kind, storage_path)
--   VALUES ((SELECT id FROM builder_applications LIMIT 1), 'submission_packet', 'test')
--   ON CONFLICT DO NOTHING;
