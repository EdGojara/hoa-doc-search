-- ============================================================================
-- 141_nomination_deleted_event.sql
-- ----------------------------------------------------------------------------
-- Adds 'deleted' as an allowed event_type on nomination_events. Required for
-- the new admin-only DELETE /api/nominations/:id endpoint to log the
-- deletion before the row goes away — gives the audit trail a clean
-- "this nomination existed and was deleted by X on Y" record without
-- having to mis-categorize it as an 'edited' event.
--
-- Also ships a NOTIFY pgrst, 'reload schema'; at the end so the
-- PostgREST API picks up the CHECK-constraint change immediately
-- instead of caching the old constraint. Lesson learned from the
-- migration 140 schema-cache miss earlier tonight: every migration
-- that changes columns or constraints should end with this notify.
--
-- Apply after 140. Idempotent (drops the named constraint if present,
-- recreates with the expanded list).
-- ============================================================================

BEGIN;

ALTER TABLE nomination_events
  DROP CONSTRAINT IF EXISTS nomination_events_event_type_check;

ALTER TABLE nomination_events
  ADD CONSTRAINT nomination_events_event_type_check CHECK (event_type IN (
    'submitted',
    'manually_entered',
    'status_changed',
    'photo_uploaded',
    'scanned_form_uploaded',
    'edited',
    'on_slate_added',
    'on_slate_removed',
    'deleted'
  ));

COMMIT;

-- Force PostgREST to refresh its schema/constraint cache so the new
-- 'deleted' event_type is immediately writable through the REST API.
-- Without this, the API may return a CHECK-constraint violation for
-- up to ~60 seconds after the constraint changes.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conname = 'nomination_events_event_type_check';
