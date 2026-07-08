-- ============================================================================
-- 263_library_source_origin_expand.sql  (Ed 2026-07-08)
-- ----------------------------------------------------------------------------
-- BUG: staff uploaded mail via Mail Scan, it appeared, then "disappeared and
-- didn't save." Root cause: api/mail_scan.js inserts library_documents with
-- source_origin='mail_scan', but the CHECK constraint from migration 013 only
-- allowed ('library','migrated_from_legacy','migrated_from_help'). Every insert
-- was rejected — 0 scanned_mail docs ever persisted. The Minutes module has the
-- same latent bug (source_origin='minutes_module', also not allowed).
--
-- Fix the CLASS, not the instance: expand the allowed set to the origins the
-- code actually writes. The already-deployed code works the moment this runs —
-- no code deploy needed to fix the save. (Same scar as CLAUDE.md "CHECK
-- constraint values that don't exist in the constraint.")
-- ============================================================================
BEGIN;

ALTER TABLE library_documents DROP CONSTRAINT IF EXISTS library_documents_source_origin_check;

ALTER TABLE library_documents ADD CONSTRAINT library_documents_source_origin_check
  CHECK (source_origin IN (
    'library',
    'migrated_from_legacy',
    'migrated_from_help',
    'mail_scan',
    'minutes_module'
  ));

COMMIT;
