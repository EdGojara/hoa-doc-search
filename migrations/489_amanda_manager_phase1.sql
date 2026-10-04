-- ============================================================================
-- 489_amanda_manager_phase1.sql  (Issue #27, Phase 1)
-- ----------------------------------------------------------------------------
-- Amanda Operating Manager, Phase 1: wake -> deterministic preflight ->
-- Amanda-owned objective state -> sleep. ZERO model calls, ZERO autonomous
-- business actions. This migration only gives the existing operator spine
-- (objectives, migration 399) the fields a deterministic manager needs, plus
-- one small de-duplicated wake outbox. It does not create a second task system.
--
--   objectives       + typed owner, accountable persona, domain, priority,
--                      autonomy class (classification only in Phase 1),
--                      blocked reason / dependency, wake reason, subject
--                      identity, needs_reasoning, state hash.
--   manager_wakes    NEW: one row per distinct (subject, state) wake candidate.
--                      The AP write paths insert here and never wait on it;
--                      the scheduled sweep consumes it.
--
-- Existing objectives rows and history are untouched (all new columns are
-- nullable or defaulted). objective_type gains 'ap' (CHECK replaced with the
-- same list plus 'ap').
--
-- record_ownership: workpaper (Bedrock's internal production state).
-- Reversible: drop manager_wakes and the added columns/indexes.
-- ============================================================================
BEGIN;

ALTER TABLE objectives
  ADD COLUMN IF NOT EXISTS owner_kind          text,
  ADD COLUMN IF NOT EXISTS owner_key           text,
  ADD COLUMN IF NOT EXISTS accountable_persona text,
  ADD COLUMN IF NOT EXISTS domain              text,
  ADD COLUMN IF NOT EXISTS priority            text,
  ADD COLUMN IF NOT EXISTS autonomy_class      text,
  ADD COLUMN IF NOT EXISTS blocked_reason      text,
  ADD COLUMN IF NOT EXISTS depends_on          jsonb,
  ADD COLUMN IF NOT EXISTS wake_reason         text,
  ADD COLUMN IF NOT EXISTS subject_key         text,
  ADD COLUMN IF NOT EXISTS subject_refs        jsonb,
  ADD COLUMN IF NOT EXISTS needs_reasoning     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS state_hash          text;

ALTER TABLE objectives DROP CONSTRAINT IF EXISTS objectives_objective_type_check;
ALTER TABLE objectives ADD CONSTRAINT objectives_objective_type_check
  CHECK (objective_type IN ('homeowner_issue','arc','drv','collections','welfare','resale','vendor','board','other','ap'));
ALTER TABLE objectives ADD CONSTRAINT objectives_owner_kind_check
  CHECK (owner_kind IS NULL OR owner_kind IN ('amanda','workflow','human'));
ALTER TABLE objectives ADD CONSTRAINT objectives_domain_check
  CHECK (domain IS NULL OR domain IN ('ap','legal','violations','acc','board','accounting','communications','ops'));
ALTER TABLE objectives ADD CONSTRAINT objectives_priority_check
  CHECK (priority IS NULL OR priority IN ('critical','high','normal','low'));
ALTER TABLE objectives ADD CONSTRAINT objectives_autonomy_class_check
  CHECK (autonomy_class IS NULL OR autonomy_class IN ('EXECUTE','REVIEW','BLOCK'));
-- a BLOCK says what it is waiting for
ALTER TABLE objectives ADD CONSTRAINT objectives_block_has_reason
  CHECK (autonomy_class IS DISTINCT FROM 'BLOCK' OR blocked_reason IS NOT NULL);

-- One OPEN objective per subject (an AP invoice, an AP exception, a board
-- packet): repeated wakes and sweeps reattach instead of duplicating work.
CREATE UNIQUE INDEX IF NOT EXISTS uq_objectives_open_subject
  ON objectives (subject_key) WHERE subject_key IS NOT NULL AND status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_objectives_blocked
  ON objectives (autonomy_class) WHERE autonomy_class = 'BLOCK' AND status NOT IN ('resolved','closed');

CREATE TABLE IF NOT EXISTS manager_wakes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('ap_invoice','ap_exception')),
  source_table  text NOT NULL,
  source_id     text NOT NULL,
  wake_reason   text NOT NULL,
  -- (kind, source, state) identity: the same event at the same state is ONE row
  dedup_key     text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','failed')),
  outcome       text CHECK (outcome IS NULL OR outcome IN ('no_action','execute_candidate','review','block','resolved','unchanged','source_missing')),
  objective_id  uuid REFERENCES objectives(id) ON DELETE SET NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_manager_wakes_pending ON manager_wakes (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_manager_wakes_recent  ON manager_wakes (consumed_at DESC);

GRANT SELECT, INSERT, UPDATE ON manager_wakes TO service_role;
GRANT SELECT                 ON manager_wakes TO authenticated;

COMMIT;
