BEGIN;

-- ============================================================================
-- 311_finalized_record_archive.sql  (Ed 2026-07-18)
-- ----------------------------------------------------------------------------
-- Generic write-once, hash-verified ledger for finalized documents that go OUT
-- and must never change once finalized — starting with ARC/ACC (architectural
-- decision letters to homeowners/builders/the CITY, and the applications they
-- were decided from). Companion to 309 (sent letters) and 310 (evidence
-- photos); this one is generic (record_type discriminator) so the remaining
-- classes — board packets, estoppels, vendor contracts — land here too instead
-- of proliferating one table per type.
--
-- Every sealed copy lives in the `finalized-docs-archive` bucket (never
-- overwritten). Append-only (INSERT/SELECT grants only, no UPDATE/DELETE) =
-- tamper-evident. SHA-256 proves the bytes are exactly what was finalized/sent.
--
-- Record ownership: association_record — decisions/correspondence issued on
-- behalf of the Association.
-- ============================================================================

CREATE TABLE IF NOT EXISTS finalized_record_archive (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type    TEXT NOT NULL,        -- 'builder_letter' | 'acc_letter' | 'acc_application' | 'acc_packet' | ...
  record_id      UUID,                 -- source row id (builder_application_responses / acc_decisions / ...)
  community_id   UUID REFERENCES communities(id) ON DELETE SET NULL,
  archive_path   TEXT NOT NULL,        -- path in the write-once finalized-docs-archive bucket
  source_path    TEXT,                 -- the documents-bucket path it was copied from
  sha256         TEXT NOT NULL,
  bytes          INTEGER,
  sent_at        TIMESTAMPTZ,
  metadata       JSONB,                -- record-type-specific context (response_type, decision_type, etc.)
  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (archive_path)
);

CREATE INDEX IF NOT EXISTS idx_finalized_record_archive_record ON finalized_record_archive (record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_finalized_record_archive_comm   ON finalized_record_archive (community_id);

GRANT SELECT, INSERT ON finalized_record_archive TO service_role;
GRANT SELECT          ON finalized_record_archive TO authenticated;

COMMIT;
