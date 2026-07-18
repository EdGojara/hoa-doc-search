BEGIN;

-- ============================================================================
-- 310_evidence_archive.sql  (Ed 2026-07-18)
-- ----------------------------------------------------------------------------
-- THE LOCKED EVIDENCE BEHIND EACH LETTER.
--
-- Companion to 309 (sent_letter_archive). A §209 case that escalates to legal
-- has to produce not just the letter but the PROOF: the inspection photo, WHEN
-- it was taken, and that it hasn't been altered. Inspection photos live in the
-- mutable `documents` bucket and have code paths that delete them (inspection
-- discard, photo cleanup). If a photo behind a finalized/escalated violation is
-- deleted, the evidence for that notice is gone.
--
-- This seals a write-once copy of every evidence photo into the
-- `evidence-archive` bucket and records its SHA-256 here, together with the
-- capture timestamp + GPS the field app recorded — so the chain is:
--   photo (hashed, timestamped, geotagged) → violation → sealed letter.
--
-- Append-only (INSERT/SELECT grants only) so the evidence ledger is
-- tamper-evident, same as the letter ledger.
--
-- Record ownership: association_record — enforcement evidence produced on
-- behalf of the Association.
-- ============================================================================

CREATE TABLE IF NOT EXISTS evidence_archive (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id   UUID REFERENCES violations(id)   ON DELETE SET NULL,
  community_id   UUID REFERENCES communities(id)  ON DELETE SET NULL,
  property_id    UUID,
  photo_id       UUID,                -- inspection_photos.id (source), may later be deleted
  role           TEXT,                -- 'primary' | 'wide'
  captured_at    TIMESTAMPTZ,         -- when the field app took the shot (evidence timestamp)
  gps_lat        DOUBLE PRECISION,
  gps_lng        DOUBLE PRECISION,
  gps_accuracy_m DOUBLE PRECISION,
  compass_heading_deg DOUBLE PRECISION,
  archive_path   TEXT NOT NULL,       -- path in the write-once evidence-archive bucket
  source_path    TEXT,                -- the documents-bucket path it was copied from
  sha256         TEXT NOT NULL,       -- integrity proof of the exact image bytes
  bytes          INTEGER,
  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (archive_path)
);

CREATE INDEX IF NOT EXISTS idx_evidence_archive_violation ON evidence_archive (violation_id);
CREATE INDEX IF NOT EXISTS idx_evidence_archive_photo     ON evidence_archive (photo_id);
CREATE INDEX IF NOT EXISTS idx_evidence_archive_community ON evidence_archive (community_id);

GRANT SELECT, INSERT ON evidence_archive TO service_role;
GRANT SELECT          ON evidence_archive TO authenticated;

COMMIT;
