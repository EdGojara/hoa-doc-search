-- ============================================================================
-- 256_work_items.sql  (Ed 2026-07-01)
-- ----------------------------------------------------------------------------
-- The operational work-item ledger — the "nothing falls through" backbone of
-- the BAM Operations Standard. Every tracked thing (scanned mail, inbound
-- email, a project/task) becomes one row with an OWNER, a STATUS, and an
-- SLA due-date computed from the Operations Standard response matrix. Feeds
-- the team Status page. Links back to its canonical source record
-- (library_documents for a scan, interactions for correspondence, etc.) so
-- this is a tracking layer, not a duplicate of the content.
--
-- record_ownership = 'workpaper' — this is Bedrock's internal ops tracking,
-- not an association record.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS work_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         uuid REFERENCES communities(id) ON DELETE SET NULL,
  community_name       text,                                   -- denormalized for unrouted-item display

  source_type          text NOT NULL DEFAULT 'manual'
                         CHECK (source_type IN ('mail_scan', 'email', 'call', 'portal', 'manual', 'project', 'drv', 'acc', 'financial')),
  item_type            text,                                   -- legal | invoice | owner_correspondence | government | insurance | board | project | other
  urgency              text NOT NULL DEFAULT 'normal'
                         CHECK (urgency IN ('critical', 'high', 'normal', 'low')),

  title                text NOT NULL,
  summary              text,

  assigned_to          text,                                   -- Ed | Martha | Celina | Alicia | Lori | Community Manager
  status               text NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'in_progress', 'waiting', 'done', 'dismissed')),

  received_at          timestamptz NOT NULL DEFAULT now(),
  sla_due_at           timestamptz,                            -- computed from received_at + matrix (lib/ops/sla.js)
  completed_at         timestamptz,

  -- links to the canonical source record
  library_document_id  uuid REFERENCES library_documents(id) ON DELETE SET NULL,
  interaction_id       uuid REFERENCES interactions(id) ON DELETE SET NULL,
  source_ref           text,                                   -- free-form external ref (email id, etc.)

  notes                text,
  record_ownership     text NOT NULL DEFAULT 'workpaper',
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_items_community ON work_items(community_id);
CREATE INDEX IF NOT EXISTS idx_work_items_assigned  ON work_items(assigned_to);
CREATE INDEX IF NOT EXISTS idx_work_items_open       ON work_items(status, sla_due_at) WHERE status NOT IN ('done', 'dismissed');
CREATE INDEX IF NOT EXISTS idx_work_items_due        ON work_items(sla_due_at) WHERE status NOT IN ('done', 'dismissed');

DROP TRIGGER IF EXISTS trg_work_items_updated ON work_items;
CREATE TRIGGER trg_work_items_updated BEFORE UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON work_items TO service_role;
GRANT SELECT ON work_items TO authenticated;

COMMIT;
