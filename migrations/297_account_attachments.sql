-- ============================================================================
-- 297_account_attachments.sql  (Ed 2026-07-14)
-- ----------------------------------------------------------------------------
-- Photos + PDFs captured against a homeowner account from the 360. Driven by a
-- real need: an attorney asked for an UPDATED picture of a property at legal.
-- The value is a defensible, date-stamped record — who captured it, when, with
-- an optional caption + GPS — filed to the property so it lands in the account's
-- history and (for legal accounts) the collection file.
--
-- Record ownership: property-condition media captured on behalf of the
-- association and handed to its attorney is an association_record (default).
-- Files themselves live in the existing 'documents' storage bucket — no new
-- silo; this table is just the index + metadata. See CLAUDE.md record-ownership.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS account_attachments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       UUID REFERENCES properties(id) ON DELETE RESTRICT,
  community_id      UUID REFERENCES communities(id) ON DELETE RESTRICT,
  contact_id        UUID,
  kind              TEXT NOT NULL CHECK (kind IN ('photo', 'document')),
  file_path         TEXT NOT NULL,                 -- path within the 'documents' bucket
  mime_type         TEXT,
  original_name     TEXT,
  caption           TEXT,
  captured_by       TEXT,                          -- staff name/email who added it
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  gps_lat           DOUBLE PRECISION,
  gps_lng           DOUBLE PRECISION,
  record_ownership  TEXT NOT NULL DEFAULT 'association_record'
                      CHECK (record_ownership IN ('association_record', 'workpaper', 'mixed')),
  source_origin     TEXT NOT NULL DEFAULT '360_upload',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_attachments_property ON account_attachments (property_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_attachments_community ON account_attachments (community_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON account_attachments TO service_role;
GRANT SELECT                          ON account_attachments TO authenticated;

COMMIT;
