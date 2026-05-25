-- ============================================================================
-- 115_contact_methods_sync_log.sql
-- ----------------------------------------------------------------------------
-- Staged-preview-then-apply log for bulk contact_methods imports. Mirrors
-- the vantaca_sync_log pattern from migration 049 — uploads land as
-- 'previewed' rows with the parsed data + computed diff; nothing writes to
-- contacts / contact_methods until staff explicitly POSTs to /apply with
-- their selections.
--
-- Why staged: the import touches a high-blast-radius surface (homeowner
-- contact info). Bad data silently overwriting good contacts is a
-- catastrophic operator failure (per CLAUDE.md Done Checklist). Preview-
-- diff-then-apply is the safety net.
--
-- Apply AFTER 114. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS contact_methods_sync_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by       TEXT NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_name         TEXT NULL,
  total_rows        INTEGER NOT NULL DEFAULT 0,
  parsed_data       JSONB NULL,       -- { addresses: [...], emails: [...], phones: [...] }
  diff_summary      JSONB NULL,       -- structured per-row classification (NEW/MATCH/INCONSISTENT/ORPHAN)
  status            TEXT NOT NULL DEFAULT 'previewed'
                      CHECK (status IN ('previewed','applied','discarded')),
  applied_at        TIMESTAMPTZ NULL,
  applied_by        TEXT NULL,
  applied_summary   JSONB NULL,
  notes             TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_sync_log_status
  ON contact_methods_sync_log (status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_methods_sync_log_recent
  ON contact_methods_sync_log (uploaded_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_methods_sync_log TO service_role;

COMMIT;
