-- ============================================================================
-- 229_builder_application_pdf_hash.sql
-- ----------------------------------------------------------------------------
-- Track the SHA-256 hash of the source PDF on builder_applications so the
-- upload-on-behalf endpoint can dedupe accidental re-uploads.
--
-- Problem this solves (Ed 2026-06-17, multi-PDF Karla run):
--   Karla's batch landed AM-BLD-2026-0010 and 0013 -- but then 0011 and 0014
--   came in as byte-identical duplicates (same address, lot, plan, elevation,
--   submitter). The folder she drag-and-dropped from probably had the same
--   PDF twice. Without a hash check the endpoint cheerfully created two rows
--   for the same submission.
--
-- Fix: hash the buffer at the top of upload-on-behalf; if a row exists for
-- the same community with the same hash within the last 24h, return 409
-- with the existing reference number instead of inserting a duplicate.
--
-- Why 24h not forever: a builder can legitimately resubmit the same PDF
-- after a rejection / revision later. Tight window catches the accidental
-- double-click case without blocking legitimate workflow.
-- ============================================================================

BEGIN;

ALTER TABLE builder_applications
  ADD COLUMN IF NOT EXISTS source_pdf_sha256 TEXT;

-- Partial index keyed on (community_id, hash, created_at) for the dedup
-- lookup. Partial because old rows pre-this-migration have NULL hash and
-- we don't want them in the index.
CREATE INDEX IF NOT EXISTS idx_builder_applications_pdf_hash_recent
  ON builder_applications (community_id, source_pdf_sha256, created_at DESC)
  WHERE source_pdf_sha256 IS NOT NULL;

COMMENT ON COLUMN builder_applications.source_pdf_sha256 IS
  'SHA-256 of the original submission PDF buffer. Populated by upload-on-behalf for dedup; portal-submitted rows leave it NULL.';

COMMIT;
