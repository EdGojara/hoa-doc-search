-- ============================================================================
-- 579_acc_received_at.sql  (Ed 2026-11-26)
-- ----------------------------------------------------------------------------
-- When an architectural application was RECEIVED: the homeowner's own
-- submission time, which review deadlines run from. Not the time a property
-- manager forwarded it, and not created_at (our processing time).
-- Scar: 6331 Clear Canyon, sent by the homeowner 11/26 11:19 AM, forwarded to
-- annie@ 12:14 PM, filed 12:17 PM; the case only knew 12:17 PM.
--
-- received_at_basis: 'forwarded_original' (read from the forward's quoted
-- header), 'email_received' (the email's own arrival), or 'backfill_*'.
-- Record ownership: association_record (part of the ARC file).
-- Additive; code degrades until applied (lib/acc/pending_intake.js).
-- ============================================================================
BEGIN;

ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS received_at_basis text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acc_decisions_received_at_basis_check') THEN
    ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_received_at_basis_check
      CHECK (received_at_basis IS NULL OR received_at_basis IN ('forwarded_original', 'email_received', 'backfill_created_at', 'backfill_email'));
  END IF;
END $$;

-- Existing cases: the best evidence on file is when the case was opened.
UPDATE acc_decisions SET received_at = created_at, received_at_basis = 'backfill_created_at'
 WHERE received_at IS NULL;

COMMIT;
