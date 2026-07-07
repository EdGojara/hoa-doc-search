-- ============================================================================
-- 262_pool_access.sql  (Ed 2026-07-07)
-- ----------------------------------------------------------------------------
-- Pool access roster: pool fob (key tag) registrations + extended-hours swim
-- approvals, filed onto the homeowner + property. This is the association's
-- pool roster — who has access and which tag numbers they hold.
--
-- RECORD OWNERSHIP: association_record. A community's pool roster belongs to
-- the HOA and must export clean on termination (member-access records).
--
-- GRAIN:
--   * fob_registration  -> ONE ROW PER FOB (per tag number). A household with
--     three fobs is three rows, each with its own fob_tag_number. This is what
--     makes "list who has access and their tag numbers" a simple query.
--   * extended_hours    -> ONE ROW PER APPROVAL (per season_year). No tag.
--
-- REISSUE SEMANTIC: a physical fob is one device. Registering a tag number to
-- a new holder supersedes the prior active registration for that tag (the API
-- flips the old row to status='revoked' at approve time). The partial unique
-- index below makes two ACTIVE rows for the same tag structurally impossible.
--
-- pool_access_batches mirrors ar_ingest_batches: a drag-drop upload is staged
-- as 'previewed', the operator reviews the resolved forms, then approves ->
-- rows land in pool_access. Nothing persists to the roster before approval.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- Upload batches (staging for the extract -> review -> approve flow)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pool_access_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          uuid REFERENCES communities(id) ON DELETE SET NULL,
  source_filename       text,                 -- 'N files' when a multi-file drop
  total_forms           integer NOT NULL DEFAULT 0,
  forms_matched         integer NOT NULL DEFAULT 0,
  forms_unmatched       integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'previewed'
                          CHECK (status IN ('previewed','approved','discarded')),
  raw_extraction        jsonb,                -- the resolved forms array
  extraction_model      text,
  uploaded_at           timestamptz NOT NULL DEFAULT now(),
  approved_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The roster itself
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pool_access (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id           uuid REFERENCES properties(id) ON DELETE SET NULL,
  contact_id            uuid REFERENCES contacts(id) ON DELETE SET NULL,

  form_type             text NOT NULL
                          CHECK (form_type IN ('fob_registration','extended_hours')),

  -- fob_registration
  fob_tag_number        text,                 -- the physical key-tag / fob id

  -- extended_hours
  season_year           integer,              -- e.g. 2026; extended-hours are per season
  extended_hours_detail text,                 -- verbatim approved-hours note

  -- both
  authorized_persons    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, relationship}]
  form_signed_date      date,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','revoked','expired')),
  notes                 text,

  -- provenance (board question -> source form)
  source_batch_id       uuid REFERENCES pool_access_batches(id) ON DELETE SET NULL,
  source_document_id    uuid REFERENCES library_documents(id) ON DELETE SET NULL,
  source_storage_path   text,
  source_filename       text,

  record_ownership      text NOT NULL DEFAULT 'association_record',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE registration per physical tag per community. Reissue flips the
-- prior row to 'revoked' first (API), so this never blocks a legitimate
-- reissue — it only makes a silent double-active-tag impossible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pool_access_active_tag
  ON pool_access (community_id, fob_tag_number)
  WHERE status = 'active' AND fob_tag_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pool_access_community ON pool_access (community_id);
CREATE INDEX IF NOT EXISTS idx_pool_access_property  ON pool_access (property_id);
CREATE INDEX IF NOT EXISTS idx_pool_access_contact   ON pool_access (contact_id);
CREATE INDEX IF NOT EXISTS idx_pool_access_batch     ON pool_access (source_batch_id);
CREATE INDEX IF NOT EXISTS idx_pool_batches_community ON pool_access_batches (community_id);

-- updated_at triggers (reuse the standard function)
DROP TRIGGER IF EXISTS trg_pool_access_updated ON pool_access;
CREATE TRIGGER trg_pool_access_updated BEFORE UPDATE ON pool_access
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_pool_batches_updated ON pool_access_batches;
CREATE TRIGGER trg_pool_batches_updated BEFORE UPDATE ON pool_access_batches
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- GRANTs — API writes with the service role; new tables are otherwise unwritable.
GRANT SELECT, INSERT, UPDATE, DELETE ON pool_access         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON pool_access_batches TO service_role;
GRANT SELECT ON pool_access         TO authenticated;
GRANT SELECT ON pool_access_batches TO authenticated;

COMMIT;
