-- ============================================================================
-- 275_vendor_w9_versions.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- W-9 versioning: a vendor has ONE current W-9, but we keep prior W-9s as
-- history when a genuinely different one is uploaded (new TIN, entity/name, or
-- classification) — while NOT creating a new record for a re-upload of the same
-- W-9 (identical file, or same TIN + name + classification).
--
--   is_current      — the live W-9 (exactly one per vendor, enforced below).
--   superseded_at    — when a prior W-9 was replaced.
--   file_hash        — sha256 of the PDF bytes (exact-duplicate guard).
--   content_hash     — hash of the substantive fields (legal name + TIN +
--                      classification) so a re-scan of the SAME W-9 is treated
--                      as a duplicate, not a new version.
--
-- Applies to doc_type='w9' only; other vendor_documents (contract/COI) are
-- unaffected by the one-current rule.
-- ============================================================================
BEGIN;

ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS file_hash     TEXT;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS content_hash  TEXT;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS is_current    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vendor_documents ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Demote any pre-existing duplicate-current W-9s (keep only the newest current)
-- so the partial unique index below can be created safely.
UPDATE vendor_documents d
   SET is_current = FALSE,
       superseded_at = COALESCE(superseded_at, now())
 WHERE d.doc_type = 'w9'
   AND d.is_current = TRUE
   AND EXISTS (
     SELECT 1 FROM vendor_documents d2
      WHERE d2.vendor_id = d.vendor_id
        AND d2.doc_type = 'w9'
        AND d2.uploaded_at > d.uploaded_at
   );

-- Exactly one current W-9 per vendor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_w9_current
  ON vendor_documents (vendor_id) WHERE is_current = TRUE AND doc_type = 'w9';

CREATE INDEX IF NOT EXISTS idx_vendor_docs_current
  ON vendor_documents (vendor_id, doc_type, is_current);

COMMIT;
