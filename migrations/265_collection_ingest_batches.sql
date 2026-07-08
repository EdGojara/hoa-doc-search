-- ============================================================================
-- 265_collection_ingest_batches.sql  (Ed 2026-07-08)
-- ----------------------------------------------------------------------------
-- Staging table for the Winstead collections-report ingest. Winstead PC sends a
-- "Matter Detail Portrait" status report every month; the operator drops the
-- PDF, the AI extracts the matters, the operator reviews the proposed status +
-- deltas, then approves — at which point the rows upsert into the canonical
-- ar_account_collections (mig 232). This table holds the extracted batch
-- between preview and approve, and is the audit trail of which report produced
-- which status change.
--
-- Mirrors ar_ingest_batches (owner_ar). record_ownership = workpaper (Bedrock's
-- operational record of an ingest run).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS collection_ingest_batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          UUID REFERENCES communities(id) ON DELETE CASCADE,
  source               TEXT NOT NULL DEFAULT 'winstead',
  source_filename       TEXT,
  source_storage_path   TEXT,
  report_as_of          DATE,
  total_matters         INTEGER NOT NULL DEFAULT 0,
  matters_matched       INTEGER NOT NULL DEFAULT 0,
  matters_unmatched     INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'previewed'
                          CHECK (status IN ('previewed','approved','discarded')),
  raw_extraction        JSONB,
  extraction_model      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_coll_ingest_community ON collection_ingest_batches (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coll_ingest_status    ON collection_ingest_batches (status);

GRANT SELECT, INSERT, UPDATE, DELETE ON collection_ingest_batches TO service_role;
GRANT SELECT                          ON collection_ingest_batches TO authenticated;

COMMIT;
