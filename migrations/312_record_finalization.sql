BEGIN;

-- ============================================================================
-- 312_record_finalization.sql  (Ed 2026-07-18)
-- ----------------------------------------------------------------------------
-- The "Finalize & Archive / Reopen" lifecycle for documents like board packets
-- and meeting minutes: an explicit finalize locks the doc and seals an
-- immutable, hash-verified copy; REOPEN is admin-only (Ed) and every finalize
-- and reopen is logged. Reopen never destroys a sealed version — a later
-- re-finalize just seals version N+1, so the full version history stands.
--
-- board_packets.status + meeting_minutes.status already allow 'final' (no CHECK
-- change needed). This adds the finalize bookkeeping + the audit log.
-- ============================================================================

ALTER TABLE board_packets
  ADD COLUMN IF NOT EXISTS finalized_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_by      UUID,
  ADD COLUMN IF NOT EXISTS finalized_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE meeting_minutes
  ADD COLUMN IF NOT EXISTS finalized_version INTEGER NOT NULL DEFAULT 0;

-- Append-only audit of every finalize / reopen. INSERT/SELECT grants only.
CREATE TABLE IF NOT EXISTS record_finalization_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type    TEXT NOT NULL,          -- 'board_packet' | 'minutes' | ...
  record_id      UUID NOT NULL,
  community_id   UUID REFERENCES communities(id) ON DELETE SET NULL,
  action         TEXT NOT NULL CHECK (action IN ('finalize','reopen')),
  version        INTEGER,                -- the finalized version this event produced/reopened
  archive_path   TEXT,                   -- the sealed copy (finalize only)
  sha256         TEXT,
  actor_user_id  UUID,
  actor_email    TEXT,
  reason         TEXT,                   -- required on reopen
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_record_finalization_log_record ON record_finalization_log (record_type, record_id, created_at DESC);

GRANT SELECT, INSERT ON record_finalization_log TO service_role;
GRANT SELECT          ON record_finalization_log TO authenticated;

COMMIT;
