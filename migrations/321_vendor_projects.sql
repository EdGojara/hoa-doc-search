-- ===========================================================================
-- 321_vendor_projects.sql
-- ---------------------------------------------------------------------------
-- Operations dashboard: community vendor/capital PROJECTS through their full
-- lifecycle (requested -> bid -> board -> contract -> work -> done) plus the
-- action queue (approve scope, approve invoice, pay vendor). Built because a
-- real repair — Waterview soccer-field irrigation — sat 52 days with two
-- vendors idle waiting on an approval that lived in a manager's inbox with no
-- system to surface it. Now every project has a stage, a next action, an owner,
-- and days-waiting, so nothing rots.
--
-- Integration, not a silo: FK to communities + vendors + the originating email
-- (audit trail: board question -> source email in a click). A board_deciding
-- project is what feeds Paige's board packet "items to vote on"; an approved
-- one is what Emma matches the eventual invoice against.
--
-- Record ownership: association_record — a community's projects, board
-- decisions, and executed contracts ARE the HOA's record and hand over on
-- termination. vendor_project_events is the immutable timeline of that record.
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vendor_projects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  uuid NOT NULL,
  community_id           uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title                  text NOT NULL,
  category               text NOT NULL DEFAULT 'general'
                           CHECK (category IN ('irrigation','landscaping','pool','electrical','fencing',
                                               'roofing','concrete','tree','painting','gate_access',
                                               'signage','amenity','general')),
  description            text,
  vendor_id              uuid REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name            text,                       -- free text until the vendor is in the directory
  asset                  text,                       -- e.g. "soccer field irrigation controller"
  stage                  text NOT NULL DEFAULT 'requested'
                           CHECK (stage IN ('requested','bid_requested','bid_received','board_deciding',
                                            'approved','contract_signed','work_started','work_complete',
                                            'closed','on_hold','cancelled')),
  stage_since            timestamptz NOT NULL DEFAULT now(),   -- when it entered the current stage (days-waiting)
  next_action            text
                           CHECK (next_action IS NULL OR next_action IN ('request_bid','follow_up_bid',
                                  'approve_scope','board_vote','sign_contract','schedule_work',
                                  'approve_invoice','pay_vendor','follow_up_vendor','none')),
  next_action_note       text,
  next_action_owner      text,                       -- 'staff' | 'manager' | 'board' | free text
  priority               text NOT NULL DEFAULT 'normal'
                           CHECK (priority IN ('low','normal','high','urgent')),
  estimated_cost_cents   bigint,
  approved_cost_cents    bigint,
  funding_source         text
                           CHECK (funding_source IS NULL OR funding_source IN ('operating','reserve','special_assessment','unknown')),
  target_date            date,                        -- expected completion
  started_at             date,
  completed_at           date,
  source                 text NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual','email','proposal','inspection')),
  source_email_id        uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  reserve_component_id   uuid,                        -- soft link (reserve integration later)
  status_note            text,
  record_ownership       text NOT NULL DEFAULT 'association_record',
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_projects_community_stage
  ON vendor_projects(community_id, stage, stage_since);
CREATE INDEX IF NOT EXISTS idx_vendor_projects_action
  ON vendor_projects(community_id, stage_since)
  WHERE next_action IS NOT NULL AND next_action <> 'none'
    AND stage NOT IN ('closed','cancelled');
CREATE INDEX IF NOT EXISTS idx_vendor_projects_vendor
  ON vendor_projects(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_projects_source_email
  ON vendor_projects(source_email_id) WHERE source_email_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_project_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES vendor_projects(id) ON DELETE CASCADE,
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  event_type    text NOT NULL DEFAULT 'note'
                  CHECK (event_type IN ('created','stage_change','note','cost_update',
                                        'next_action','vendor_assigned','linked_email','completed')),
  from_stage    text,
  to_stage      text,
  note          text,
  by_user       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_project_events_project
  ON vendor_project_events(project_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_vendor_projects_updated_at ON vendor_projects;
CREATE TRIGGER trg_vendor_projects_updated_at
  BEFORE UPDATE ON vendor_projects
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_projects       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_project_events TO service_role;
GRANT SELECT ON vendor_projects       TO authenticated;
GRANT SELECT ON vendor_project_events TO authenticated;

-- Seed the real example that motivated this — so the dashboard opens with the
-- soccer-field repair already showing "board_deciding, 52 days waiting" instead
-- of an empty board. Idempotent + only if Waterview Estates exists.
INSERT INTO vendor_projects
  (management_company_id, community_id, title, category, description, vendor_name, asset,
   stage, stage_since, next_action, next_action_note, next_action_owner, priority,
   funding_source, source, status_note, created_by)
SELECT
  '00000000-0000-0000-0000-000000000001',
  c.id,
  'Soccer Field Irrigation Repair',
  'irrigation',
  'Irrigation controller at the Waterview soccer field is down. Requires electrical (restore 120V at the outlet) then irrigation controller troubleshooting/repair. Two vendors coordinating: WaterLogic (irrigation) and Strike Electrical.',
  'WaterLogic / Strike Electrical',
  'soccer field irrigation controller',
  'board_deciding',
  '2026-05-29T13:14:00Z',
  'approve_scope',
  'Both vendors idle since May 29 awaiting management approval to proceed. Controller down through Houston summer — needs a decision.',
  'manager',
  'high',
  'operating',
  'manual',
  'Vendors chasing weekly (WaterLogic 7/20). No approval on record.',
  'system_seed'
FROM communities c
WHERE c.name ILIKE '%waterview%'
  AND NOT EXISTS (
    SELECT 1 FROM vendor_projects p
    WHERE p.community_id = c.id AND p.title = 'Soccer Field Irrigation Repair'
  )
LIMIT 1;

COMMIT;
