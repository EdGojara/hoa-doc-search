-- ============================================================================
-- 149_verified_data_columns.sql
-- ----------------------------------------------------------------------------
-- Adds data_verified_at + verified_by + verified_source to properties and
-- contacts. These mark a row as "operator-signed truth" — clean data that
-- the operator deliberately validated through a template import flow.
--
-- Why this matters (Ed 2026-06-02 5am):
--   "create standard import templates...clean data outside of system before
--   we import so it will be clean but only one time so we have source of
--   truth"
--
-- The contract:
--   • Rows imported via the template-driven roster import get stamped with
--     data_verified_at = NOW() and verified_source = 'template_import'.
--   • Future Vantaca syncs surface proposed changes to verified rows BUT
--     do NOT auto-apply them — operator confirms per-row.
--   • This means a clean-once import survives every subsequent Vantaca sync.
--   • Edge case: a homeowner actually moves → Vantaca diff shows the new
--     mailing → operator either accepts (clears verified flag) or rejects.
--     Operator stays in control.
--
-- Indexes on data_verified_at because the Vantaca diff path needs to
-- partition rows into "verified, needs confirmation" vs "unverified, auto-
-- apply" fast at apply time.
--
-- Idempotent. Apply after 148.
-- ============================================================================

BEGIN;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS data_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by      TEXT,
  ADD COLUMN IF NOT EXISTS verified_source  TEXT;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS data_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by      TEXT,
  ADD COLUMN IF NOT EXISTS verified_source  TEXT;

-- CHECK constraints on verified_source (enum-shaped TEXT, per CLAUDE.md
-- DB conventions — catch bad values at insert, not runtime).
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_verified_source_check;
ALTER TABLE properties
  ADD CONSTRAINT properties_verified_source_check
  CHECK (verified_source IS NULL OR verified_source IN ('template_import', 'manual_edit', 'vantaca_initial'));

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_verified_source_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_verified_source_check
  CHECK (verified_source IS NULL OR verified_source IN ('template_import', 'manual_edit', 'vantaca_initial'));

-- Partial indexes on the verified-at column. Vantaca diff path filters
-- by "data_verified_at IS NOT NULL" to find rows that need confirm-on-
-- change handling; speed it up.
CREATE INDEX IF NOT EXISTS idx_properties_verified
  ON properties (data_verified_at)
  WHERE data_verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_verified
  ON contacts (data_verified_at)
  WHERE data_verified_at IS NOT NULL;

COMMENT ON COLUMN properties.data_verified_at IS 'Timestamp when an operator explicitly verified this row via the template-driven roster import flow. NULL = not yet verified (Vantaca-only data). Vantaca diffs respect this flag and do NOT auto-overwrite verified rows.';
COMMENT ON COLUMN properties.verified_by      IS 'Operator identifier (email or staff name) who signed off on this row.';
COMMENT ON COLUMN properties.verified_source  IS 'How the row was verified: template_import / manual_edit / vantaca_initial.';

COMMENT ON COLUMN contacts.data_verified_at IS 'Same semantics as properties.data_verified_at — operator-blessed contact data.';
COMMENT ON COLUMN contacts.verified_by      IS 'Operator identifier who signed off.';
COMMENT ON COLUMN contacts.verified_source  IS 'How the row was verified.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name IN ('properties','contacts')
--   AND column_name IN ('data_verified_at','verified_by','verified_source');
--
-- SELECT indexname FROM pg_indexes
-- WHERE indexname IN ('idx_properties_verified','idx_contacts_verified');
