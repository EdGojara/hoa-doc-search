-- 157_seed_meeting_records_category.sql
--
-- Seeds 'meeting_records' as a valid document_categories entry so
-- library_documents inserts for annual-meeting quorum-evidence PDFs
-- (and any future per-meeting record types) don't violate the FK.
--
-- Canyon Gate 2026-06-04: PDF generation kept hitting an archive
-- failure because api/meeting_checkin.js was writing
-- category='meeting_records' but the document_categories seed in
-- migration 012 never defined that value. The endpoint now falls
-- back to 'annual_board_meeting_minutes' if 'meeting_records' is
-- rejected (defense in depth), but this migration is the proper
-- fix — adds the category so the intended classification sticks.
--
-- Record-ownership note: meeting records are `association_record`
-- per CLAUDE.md — they must be transferable on HOA termination.
-- Category-table seed only; no row ownership column needed at the
-- categories table level.

BEGIN;

INSERT INTO document_categories
  (category, display_name, description, typical_frequency, typical_expiration_months, required_for_resale, sort_order)
VALUES
  ('meeting_records',
   'Meeting Records',
   'Quorum evidence PDF, sign-in sheets, ballots, certified results, and related per-meeting artifacts. Each annual meeting produces a fresh set; archived as association_record on the community library.',
   'annual',
   NULL,
   TRUE,
   31)
ON CONFLICT (category) DO NOTHING;

COMMIT;
