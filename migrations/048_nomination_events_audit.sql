-- ============================================================================
-- 048_nomination_events_audit.sql
-- ----------------------------------------------------------------------------
-- Append-only audit log for every meaningful action taken on a nomination.
-- The goal: nothing is ever "lost." Even if a cycle is deleted and the
-- nominations cascade with it, the events table keeps a snapshot of what
-- happened, when, and by whom — so Bedrock can always reconstruct who
-- submitted what, when status changed, when a photo went up, etc.
--
-- Schema choices:
--
-- * No FK on nomination_id. We want events to SURVIVE nomination deletion
--   (otherwise a cycle delete would wipe the audit trail too). We store
--   nominee_name + cycle_id + a payload snapshot so events remain
--   meaningful even when the source nomination is gone.
--
-- * payload JSONB holds event-specific detail (old/new values on
--   status_changed, file path on photo_uploaded, full nomination snapshot
--   on submission, etc.).
--
-- * occurred_at vs. created_at — same in 99% of cases, but separate so
--   backfilled events can carry their historical timestamp.
--
-- Apply AFTER 047. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS nomination_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Intentionally NO foreign key — events survive nomination deletion.
  nomination_id   UUID NOT NULL,
  -- Same reasoning for cycle_id — captured for downstream queries
  -- ("everything that happened on the 2026 Waterview cycle") even if the
  -- cycle itself is later deleted.
  cycle_id        UUID NULL,
  nominee_name    TEXT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'submitted',
    'manually_entered',
    'status_changed',
    'photo_uploaded',
    'scanned_form_uploaded',
    'edited',
    'on_slate_added',
    'on_slate_removed'
  )),
  payload         JSONB NULL,
  actor           TEXT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nomination_events_nomination
  ON nomination_events (nomination_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_nomination_events_cycle
  ON nomination_events (cycle_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_nomination_events_kind_time
  ON nomination_events (event_type, occurred_at DESC);

GRANT SELECT, INSERT ON nomination_events TO service_role;

COMMIT;

-- Verify:
--   SELECT event_type, COUNT(*) FROM nomination_events GROUP BY event_type;
--   SELECT nominee_name, event_type, occurred_at, payload
--     FROM nomination_events ORDER BY occurred_at DESC LIMIT 20;
