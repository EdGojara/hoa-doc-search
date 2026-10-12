-- ============================================================================
-- 516_community_archived_status.sql  (Ed 2026-10-12)
-- ----------------------------------------------------------------------------
-- ARCHIVED: a community Bedrock no longer manages. Ed: "Treat Eaglewood as an
-- ARCHIVED community, effective immediately for operational purposes ... Preserve
-- all existing Eaglewood records ... Keep its historical records available for
-- authorized read-only access."
--
-- The application already reads one central rule (lib/community/lifecycle.js
-- isEnded / isOperational / canDo): archived, terminated, or terminating past its
-- last day = no new operational activity; reading and exporting stay open. This
-- migration makes the record say so explicitly instead of leaving a community that
-- ended on its last day labelled 'terminating'.
--
--   1. management_status may be 'archived' (migration 382's list + archived).
--   2. Every community whose engagement has ENDED (terminating / terminated with a
--      last day already past) becomes 'archived', with enforcement_active and
--      arc_active off (financials_active is already off). Selected by status and
--      date, never by name; preflight confirms it is exactly Eaglewood today.
--
-- Nothing is deleted. No journal entry, ledger row, violation, ARC application,
-- document or correspondence changes. Record ownership: communities is
-- association_record; only three status columns of one row change.
-- ============================================================================
BEGIN;

ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_management_status_check;
ALTER TABLE communities ADD CONSTRAINT communities_management_status_check
  CHECK (management_status IN ('prospect', 'onboarding', 'active', 'terminating', 'terminated', 'archived'));

COMMENT ON COLUMN communities.management_status IS
  'Where the engagement stands. terminating = still ours, with an end date. terminated / archived = Bedrock no longer manages it: records stay readable and exportable, no new operational activity (lib/community/lifecycle.js). (mig 382, archived mig 516)';

UPDATE communities
   SET management_status = 'archived', enforcement_active = false, arc_active = false
 WHERE management_status IN ('terminating', 'terminated')
   AND management_end_date IS NOT NULL
   AND management_end_date < (now() AT TIME ZONE 'America/Chicago')::date;

COMMIT;
