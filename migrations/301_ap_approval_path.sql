-- ============================================================================
-- 301_ap_approval_path.sql  (Ed 2026-07-15)
-- ----------------------------------------------------------------------------
-- Ed: "where is the manager review button"
--
-- It was on the six staff accounts' screens. But NOTHING EVER TOLD THEM a bill
-- was waiting: approvalPath() ran only inside the detail modal and at release,
-- and the AP queue is community-scoped, so a manager would have had to open
-- every bill in all seven communities to discover which needed them. Nobody
-- does that. So no bill would ever get a manager approval, every bill would sit
-- at "Pending" forever, and Ed's only real option would be "Release anyway" —
-- which turns the two-key control into theater. A control nobody is routed to
-- is not a control. (project_system_as_operator: the platform IS the operator;
-- it routes the work, humans don't go looking for it.)
--
-- Recomputing the path live isn't an option: the recurrence profile costs
-- ~564ms per bill (measured), so an 8-bill queue takes 4.5s and a 50-bill queue
-- ~30s. Decide it ONCE, when the bill lands, and store it.
--
-- Stored = the RECURRENCE verdict, which is fixed at intake (vendor, community,
-- and amount never change afterward). Vendor CREDITS are deliberately NOT baked
-- in — a credit recorded next week must still flip a stored 'release' bill to
-- manager_review, so credits stay a live overlay on top of this column.
--
-- Record ownership: association_record — this is the community's own AP.
-- ============================================================================

BEGIN;

ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS approval_path TEXT
  CHECK (approval_path IN ('release', 'manager_review'));
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS approval_path_reason TEXT;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS approval_path_why TEXT;
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS approval_path_at TIMESTAMPTZ;

COMMENT ON COLUMN ap_invoices.approval_path IS
  'Which approval route this bill takes, decided once at intake from the recurrence profile. release = recurring AND consistent, Ed releases directly. manager_review = one-off or off-pattern, a manager vouches first. Vendor credits are NOT folded in here — they are evaluated live so a credit recorded later still holds a bill.';

-- The manager's queue: "what is waiting on me, across every community."
CREATE INDEX IF NOT EXISTS idx_ap_invoices_manager_queue
  ON ap_invoices (approval_path, status)
  WHERE status = 'awaiting_approval';

COMMIT;
