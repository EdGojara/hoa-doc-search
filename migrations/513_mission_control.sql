-- ============================================================================
-- 513_mission_control.sql  (Ed 2026-10-12)
-- ----------------------------------------------------------------------------
-- Mission Control extends the EXISTING work-item ledger (work_items, migration
-- 256) instead of adding a second task system. Operations items that come from
-- authoritative workflows (Kat's runs, the month-end close checklist, the
-- proposed budget) are read live and are NOT copied here; this table holds the
-- manual and agent-created tasks, now with:
--   workspace          'operations' | 'platform' (Platform Buildout)
--   requested_by       who asked (an agent such as Kat, or a person)
--   why                why the action is necessary
--   blocks             jsonb list of the Mission Control node keys this task holds up
--                      (another task, a deliverable such as "close:<community>:2026-09", a module)
--   next_step          what happens after it is done
--   evidence_required  what establishes completion
--   action_url         the existing screen where the work is done
--   module_key         Platform Buildout module (lib/mission_control/modules.js)
--   horizon            Platform Buildout priority: 'now' | 'next' | 'later'
--   links              jsonb list of { kind: issue | pr | deploy | doc, ref, url } (GitHub stays the
--                      engineering system; TrustEd holds the business priority)
--   item_type (existing, free text) carries the platform kind: capability | feature | bug |
--   improvement | task. A module's required capabilities decide its readiness.
-- source_type gains 'agent' and 'platform'. An OPEN item's source_ref is unique, so
-- an agent that meets the same unresolved issue again updates its task instead of
-- creating a duplicate. work_item_events is the audit trail: what changed, when,
-- why and who (a person, an agent or a system).
-- Record ownership: workpaper (unchanged from 256). No journal entry, ledger row or
-- balance is created or changed.
-- ============================================================================
BEGIN;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS workspace         text NOT NULL DEFAULT 'operations',
  ADD COLUMN IF NOT EXISTS requested_by      text,
  ADD COLUMN IF NOT EXISTS why               text,
  ADD COLUMN IF NOT EXISTS blocks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_step         text,
  ADD COLUMN IF NOT EXISTS evidence_required text,
  ADD COLUMN IF NOT EXISTS action_url        text,
  ADD COLUMN IF NOT EXISTS module_key        text,
  ADD COLUMN IF NOT EXISTS horizon           text,
  ADD COLUMN IF NOT EXISTS links             jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_workspace_check') THEN
    ALTER TABLE work_items ADD CONSTRAINT work_items_workspace_check CHECK (workspace IN ('operations', 'platform'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_blocks_array_check') THEN
    ALTER TABLE work_items ADD CONSTRAINT work_items_blocks_array_check CHECK (jsonb_typeof(blocks) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_horizon_check') THEN
    ALTER TABLE work_items ADD CONSTRAINT work_items_horizon_check CHECK (horizon IS NULL OR horizon IN ('now', 'next', 'later'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_links_array_check') THEN
    ALTER TABLE work_items ADD CONSTRAINT work_items_links_array_check CHECK (jsonb_typeof(links) = 'array');
  END IF;
END $$;

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_source_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_source_type_check
  CHECK (source_type IN ('mail_scan', 'email', 'call', 'portal', 'manual', 'project', 'drv', 'acc', 'financial', 'agent', 'platform'));

CREATE UNIQUE INDEX IF NOT EXISTS ux_work_items_open_source_ref ON work_items (source_ref)
  WHERE source_ref IS NOT NULL AND status IN ('new', 'in_progress', 'waiting');
CREATE INDEX IF NOT EXISTS ix_work_items_workspace_open ON work_items (workspace, status) WHERE status IN ('new', 'in_progress', 'waiting');
CREATE INDEX IF NOT EXISTS ix_work_items_module ON work_items (module_key) WHERE module_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_item_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  uuid NOT NULL,
  event         text NOT NULL,
  actor         text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_events_item_fkey FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
  CONSTRAINT work_item_events_event_check CHECK (event IN ('created', 'updated', 'status_changed', 'reopened', 'agent_touch', 'closed_by_evidence'))
);
CREATE INDEX IF NOT EXISTS ix_work_item_events_item ON work_item_events (work_item_id, created_at);

GRANT SELECT, INSERT ON work_item_events TO service_role;
GRANT SELECT ON work_item_events TO authenticated;

COMMIT;
