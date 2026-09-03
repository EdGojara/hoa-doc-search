-- ============================================================================
-- 404_acc_decided_at_guard.sql  (Ed 2026-09-03)
-- ----------------------------------------------------------------------------
-- A decided ACC decision MUST carry a decision date, or billing silently drops
-- it. The community billing report bills acc_decisions by `decided_at` within
-- the period (api/billing.js): a NULL decided_at fails the date-range filter, so
-- the review work is never counted.
--
-- Discovered on Canyon Gate (Ed: "we did some ARC but they are not recorded in
-- the billing"): 30 of 66 decided ACC decisions across 5 communities had
-- decided_at = NULL — ~45% of decided ARC work unbilled. They were decided by
-- staff through a path that set status='decided' without stamping decided_at.
--
-- Rather than chase every write path, make it structurally impossible: a trigger
-- stamps decided_at whenever a row is (or becomes) 'decided' without one. Plus a
-- one-time backfill (idempotent — already run live via script) so history bills.
--
-- record_ownership: acc_decisions are association_records. This only fills a
-- missing timestamp; it never changes a decision.
-- ============================================================================
BEGIN;

-- 1) Backfill: any decided row missing its date gets the best available proxy
--    (when it was last touched, else when it arrived). Idempotent.
UPDATE acc_decisions
   SET decided_at = COALESCE(updated_at, created_at)
 WHERE status = 'decided' AND decided_at IS NULL;

-- 2) Guard: a decided row can never again have a NULL decided_at.
CREATE OR REPLACE FUNCTION acc_stamp_decided_at()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'decided' AND NEW.decided_at IS NULL THEN
    NEW.decided_at := COALESCE(OLD.updated_at, NEW.updated_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_acc_stamp_decided_at ON acc_decisions;
CREATE TRIGGER trg_acc_stamp_decided_at
  BEFORE INSERT OR UPDATE ON acc_decisions
  FOR EACH ROW EXECUTE FUNCTION acc_stamp_decided_at();

COMMIT;
