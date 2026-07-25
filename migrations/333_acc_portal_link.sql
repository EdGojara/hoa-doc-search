-- 333_acc_portal_link.sql
-- ---------------------------------------------------------------------------
-- ACC one-brain unification (Ed 2026-07-25).
--
-- Portal ARC applications used to run a SECOND, separate AI assessment engine
-- (api/applications.js `runAssessment`) and live only in `community_applications`,
-- while email + staff doors ran the SYSTEM engine (`assessAndDraftAcc`) and
-- landed in `acc_decisions` — the mature queue with conditions, homeowner-pays
-- fee, sealing, and decided_at. Two brains meant the SAME application could get
-- a different answer depending on the door it came through, and portal decisions
-- silently skipped the fee/seal/billing.
--
-- Fix: ALL three doors now go through the one system engine into `acc_decisions`.
-- `community_applications` stays as the portal's front-desk (intake + the status
-- the homeowner sees). This column is the link between the two: the canonical
-- decision (acc_decisions) points back to its portal intake row so we can sync
-- the decision + letter back out through the portal.
--
-- Record ownership: workpaper (internal decision record; the SENT letter that
-- rides on it is association_record, sealed separately).
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE acc_decisions
  ADD COLUMN IF NOT EXISTS community_application_id uuid
    REFERENCES community_applications(id) ON DELETE SET NULL;

-- Find the decision for a given portal application fast (status sync-back reads this).
CREATE INDEX IF NOT EXISTS idx_acc_decisions_community_application_id
  ON acc_decisions (community_application_id)
  WHERE community_application_id IS NOT NULL;

-- Mirror direction: from a portal application, find its decision without a scan.
ALTER TABLE community_applications
  ADD COLUMN IF NOT EXISTS acc_decision_id uuid
    REFERENCES acc_decisions(id) ON DELETE SET NULL;

COMMIT;
