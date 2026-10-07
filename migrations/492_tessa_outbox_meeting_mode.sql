-- ============================================================================
-- 492_tessa_outbox_meeting_mode.sql  (Ed 2026-10-06)
-- ----------------------------------------------------------------------------
-- What kind of calendar entry a staged meeting is, so release books the right
-- thing instead of always a Teams invite:
--   calendar_only  an entry on Ed's own calendar; no attendees, no invitation
--   invite         Tessa organizes; Ed + named people; no Teams link
--   online         Tessa organizes a Teams meeting
-- NULL = a row staged before this column existed = the legacy Teams invite.
--
-- Scar: "Add my call with Sipra Boyd tomorrow at 4:00 PM ... Phone call" was
-- staged as a Teams invite to Sipra and Ed.
--
-- Record ownership: workpaper (Tessa's internal staging), unchanged from 405.
-- Additive, nullable; existing grants on tessa_outbox (405) cover the column.
-- The runner reloads the PostgREST schema after apply (checks: reload_schema).
-- ============================================================================
BEGIN;

ALTER TABLE tessa_outbox ADD COLUMN IF NOT EXISTS meeting_mode text
  CONSTRAINT tessa_outbox_meeting_mode_check
  CHECK (meeting_mode IS NULL OR meeting_mode IN ('calendar_only', 'invite', 'online'));

COMMIT;
