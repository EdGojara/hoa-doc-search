-- 347_violation_sent_to_attorney.sql
-- Ed 2026-08-03 — Mark a §209 covenant violation as SENT TO THE ATTORNEY at the
-- VIOLATION level (not the account/collections level).
--
-- Why this is separate from property_enforcement_states.at_legal:
--   at_legal is an ACCOUNT state — the owner's ledger is with collections
--   counsel over unpaid assessments (FDCPA scoping). A §209 covenant matter
--   (grass, fence, unapproved paint) handed to the association's attorney for
--   enforcement is a different thing, lives on the specific violation, and one
--   property can have one violation at the attorney while others are in-house.
--
-- Workflow (Ed): mark each §209 that goes to the attorney. If it comes back,
--   that means the owner cured — staff mark it cured (existing resolve path);
--   the attorney mark stays on the now-cured row as history. The violations
--   Schedule calendar hides §209 cure deadlines for anything sent to the
--   attorney — that clock is counsel's now, not ours.
--
-- Record ownership: association_record (correspondence/enforcement on behalf of
--   the HOA). violations already carries community_id + full GRANTs, so no new
--   grants needed for these columns.

BEGIN;

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS sent_to_attorney_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS sent_to_attorney_by_user_id UUID NULL,
  ADD COLUMN IF NOT EXISTS attorney_firm              TEXT NULL,
  ADD COLUMN IF NOT EXISTS attorney_matter_ref        TEXT NULL,
  ADD COLUMN IF NOT EXISTS attorney_notes             TEXT NULL;

-- Hot path: "which §209 cases are with the attorney" — small, filtered set.
CREATE INDEX IF NOT EXISTS idx_violations_sent_to_attorney
  ON violations(community_id, sent_to_attorney_at)
  WHERE sent_to_attorney_at IS NOT NULL;

COMMIT;
