-- 330_acc_decided_at.sql
-- ---------------------------------------------------------------------------
-- Bill resident ACC decisions by the date they were DECIDED, not the date the
-- application arrived. `acc_decisions` only carried `created_at` (arrival) and
-- `updated_at`, so billing counted a decision in the month the application came
-- in — a slow approval landed on the wrong bill or was missed entirely
-- (Ed 2026-07-24). `decided_at` is the billable event, stamped at finalize.
--
-- Record ownership: association_record (ACC decisions belong to the HOA).
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS decided_at timestamptz;

-- Backfill already-decided rows: updated_at is the best available proxy for when
-- the decision was finalized (finalize stamps updated_at). Going forward,
-- finalize stamps decided_at exactly at the moment of decision.
UPDATE acc_decisions
   SET decided_at = updated_at
 WHERE status = 'decided' AND decided_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_acc_decisions_decided_at ON acc_decisions (decided_at);

COMMIT;
