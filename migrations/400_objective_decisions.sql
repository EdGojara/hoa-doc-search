-- ============================================================================
-- 400_objective_decisions.sql  (Ed 2026-08-29)
-- ----------------------------------------------------------------------------
-- The reconciliation ledger. The operator loop is re-entrant: an objective is a
-- durable thing Trusted is responsible for resolving, and every time new
-- evidence or a drive-tick arrives it re-asks "given everything I know now, is
-- this resolved? if not, what — if anything — should happen next?" Each such
-- evaluation produces a DECISION, and every decision is recorded in full: the
-- verdict, the evidence considered, the rules consulted, the confidence, the
-- reason, the capability it would use, and whether it hit a human-authorization
-- boundary.
--
-- DARK BY DEFAULT: executed is always false for now. PROPOSE_ACTION stores what
-- Trusted WOULD do so we can compare it against what the human actually does.
-- That comparison is the exception-rate metric — the operating number that says
-- how much of the work Trusted can safely carry. The exception rate is the
-- business; you measure it from day one.
--
-- record_ownership = 'workpaper': this is Bedrock's internal judgment + metrics.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS objective_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id       uuid NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  community_id       uuid,

  -- what triggered this evaluation: an inbound message id, 'drive_tick', 'manual'
  triggering_event_ref text NOT NULL DEFAULT 'manual',

  -- the six-verdict decision vocabulary
  verdict            text NOT NULL
                       CHECK (verdict IN ('NO_ACTION','WAIT','REQUEST_INFORMATION','PROPOSE_ACTION','ESCALATE','CLOSE')),
  confidence         text CHECK (confidence IN ('high','medium','low')),
  reason             text,

  -- the rationale trail (auditability is a first-class requirement)
  evidence           jsonb DEFAULT '{}'::jsonb,   -- what was considered
  rules_consulted    text[] DEFAULT '{}',
  proposed_capability text,                        -- which capability it would invoke
  proposed_action_detail text,                     -- the dark "what it would do"
  authorization_boundary boolean NOT NULL DEFAULT false,
  authorization_reason text,

  -- dark-mode + comparison
  executed           boolean NOT NULL DEFAULT false,   -- always false while dark
  human_outcome      text,                             -- what the human actually did, later
  agreement          text,                             -- agree | disagree | n/a, later

  decided_by         text,                          -- persona that judged
  record_ownership   text NOT NULL DEFAULT 'workpaper',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obj_decisions_objective ON objective_decisions (objective_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obj_decisions_verdict   ON objective_decisions (verdict);
CREATE INDEX IF NOT EXISTS idx_obj_decisions_trigger   ON objective_decisions (objective_id, triggering_event_ref);
CREATE INDEX IF NOT EXISTS idx_obj_decisions_community  ON objective_decisions (community_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON objective_decisions TO service_role;
GRANT SELECT                          ON objective_decisions TO authenticated;

COMMIT;
