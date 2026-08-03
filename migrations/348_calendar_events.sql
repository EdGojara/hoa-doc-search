-- 348_calendar_events.sql
-- Ed 2026-08-03 — Native events for the unified Bedrock Calendar.
--
-- The Bedrock Calendar (top-level 🗓️ tab) AGGREGATES from canonical sources it
-- does NOT own — amenity_rentals (clubhouse reservations), meeting_agendas
-- (scheduled board meetings), nomination_cycles (annual-meeting planning). This
-- table holds only what has no other home: staff-added events, PTO (vacation /
-- sick), holidays, and internal reminders. No duplication of the above.
--
-- Record ownership: workpaper. This is internal Bedrock operations data (staff
-- schedule + time-off + internal reminders), NOT an association record — it is
-- excluded from any community termination export. A row MAY carry a
-- community_id when an event is about one community, but that never makes it an
-- association record.

BEGIN;

CREATE TABLE IF NOT EXISTS calendar_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         text NOT NULL DEFAULT 'staff_event'
                       CHECK (event_type IN ('staff_event','vacation','sick','holiday','reminder','meeting','other')),
  title              text NOT NULL,
  start_date         date NOT NULL,
  end_date           date,                 -- null = single day; else inclusive span
  all_day            boolean NOT NULL DEFAULT true,
  start_time         text,                 -- free text "9:00 AM" (matches meeting_agendas.meeting_time)
  end_time           text,
  staff_user_id      uuid,                 -- whose event / PTO this is (user_profiles.id)
  staff_name         text,                 -- denormalized for display
  community_id       uuid REFERENCES communities(id) ON DELETE SET NULL,  -- null = company-wide
  notes              text,
  created_by_user_id uuid,
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_staff ON calendar_events(staff_user_id);

DROP TRIGGER IF EXISTS trg_calendar_events_updated_at ON calendar_events;
CREATE TRIGGER trg_calendar_events_updated_at
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO service_role;
GRANT SELECT ON calendar_events TO authenticated;

COMMIT;
