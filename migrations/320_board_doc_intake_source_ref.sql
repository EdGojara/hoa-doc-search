-- ===========================================================================
-- 320_board_doc_intake_source_ref.sql
-- ---------------------------------------------------------------------------
-- Lets staff email the AI team a minutes or agenda file ("please add this to
-- Lakes of Pine Forest minutes") and have Paige file it straight into the
-- native module as a draft record. This adds the idempotency key so a repeat
-- mail pull can't create the same record twice: intake_source_ref stamps the
-- originating email + attachment. Partial-unique so a second ingest of the
-- SAME email+attachment is a structural no-op (belt to the check-before-insert
-- braces in doc_intake.js). Per-attachment ref (email:<graph_id>#<filename>)
-- so a single email carrying several files inserts several distinct records.
--
-- Record ownership unchanged: both tables are association_record.
-- Grants unchanged: adding a column to an existing table keeps its grants.
-- ===========================================================================
BEGIN;

ALTER TABLE meeting_minutes  ADD COLUMN IF NOT EXISTS intake_source_ref text;
ALTER TABLE meeting_agendas  ADD COLUMN IF NOT EXISTS intake_source_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_minutes_intake_source_ref
  ON meeting_minutes(intake_source_ref) WHERE intake_source_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_agendas_intake_source_ref
  ON meeting_agendas(intake_source_ref) WHERE intake_source_ref IS NOT NULL;

COMMIT;
