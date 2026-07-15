-- ============================================================================
-- 298_acc_acknowledgment_tracking.sql  (Ed 2026-07-15)
-- ----------------------------------------------------------------------------
-- Track whether the homeowner's ARC receipt actually went out.
--
-- Scar: six ARC applications arrived by email. Five (7/13) were parsed,
-- AI-reviewed, and queued — and every applicant heard NOTHING, because the
-- acknowledgment send failed and the intake just moved on (`return null`, no
-- else branch, nothing recorded). The sixth (WAT-ARC-2026-0003) WAS
-- acknowledged, to an address misread off the form, and bounced 550 NoSuchUser.
-- Net: 6 applicants, 0 delivered receipts — while the queue looked healthy and
-- the books said "handled". Ed found it by eye ("I don't see any responses
-- other than the one that failed"), which is exactly the failure the platform
-- is supposed to catch for him.
--
-- "We sent it" and "they got it" are different facts. Record the first
-- honestly so the ACC queue can show a receipt that never landed.
-- ============================================================================
BEGIN;

ALTER TABLE acc_decisions
  ADD COLUMN IF NOT EXISTS acknowledged_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_to        TEXT,
  ADD COLUMN IF NOT EXISTS acknowledgment_error   TEXT;

-- The ones that need a human: queued, never acknowledged.
CREATE INDEX IF NOT EXISTS idx_acc_decisions_unacked
  ON acc_decisions (community_id)
  WHERE acknowledged_at IS NULL;

COMMIT;
