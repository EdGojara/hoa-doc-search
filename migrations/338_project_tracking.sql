-- ============================================================================
-- 338_project_tracking.sql  (Ed 2026-07-27)
-- ----------------------------------------------------------------------------
-- Project tracking slice: board accountability + progress + cost visibility for
-- annual/capital projects. EXTENDS the existing vendor_projects spine (which
-- already carries title, vendor, stage, target_date, approved/estimated cost,
-- and a reserve_component_id link) — no new project silo. Adds:
--   - percent_complete on vendor_projects (progress %)
--   - project_milestones (deadlines with an owner + status)
-- Actual cost is NOT stored — it is read live from ap_invoices at render time
-- (single source of truth for money is the AP subledger / GL).
--
-- Record ownership: project_milestones is MIXED — a milestone shown to the board
-- is association_record; internal scheduling notes are workpaper. community_id
-- is reachable via the parent vendor_projects row for termination export.
-- ============================================================================
BEGIN;

ALTER TABLE vendor_projects ADD COLUMN IF NOT EXISTS percent_complete int;
DO $$ BEGIN
  ALTER TABLE vendor_projects ADD CONSTRAINT vendor_projects_percent_complete_check
    CHECK (percent_complete IS NULL OR (percent_complete BETWEEN 0 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS project_milestones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES vendor_projects(id) ON DELETE CASCADE,
  title         text NOT NULL,
  due_date      date,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','blocked')),
  owner         text,
  sort_order    int NOT NULL DEFAULT 0,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_milestones TO service_role;
GRANT SELECT ON project_milestones TO authenticated;

DROP TRIGGER IF EXISTS trg_project_milestones_updated ON project_milestones;
CREATE TRIGGER trg_project_milestones_updated
  BEFORE UPDATE ON project_milestones
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMIT;
