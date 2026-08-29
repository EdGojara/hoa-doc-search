-- ============================================================================
-- 399_objectives.sql  (Ed 2026-08-29)
-- ----------------------------------------------------------------------------
-- THE OPERATOR SPINE. The difference between an AI bolted onto HOA software and
-- an AI that actually runs the community is STATE: a persistent objective the
-- team owns and drives to closure, not a one-shot reply. Vantaca stores what
-- happened and makes a human do every next step; an operator holds the goal,
-- reattaches new input to it, decides the next action, follows up if nobody
-- acts, and closes it when the outcome is reached.
--
--   goal -> plan -> act -> observe -> remember -> reconsider -> act -> complete
--
-- An `objective` is one unit of work-to-an-outcome (resolve a homeowner issue,
-- complete an ARC application, work a delinquency). `objective_events` is its
-- append-only timeline. Reattachment (linking new mail to the right open
-- objective) keys on resident_email / contact / property — the hard part, and
-- the thing that makes state reliable instead of confidently wrong.
--
-- record_ownership = 'mixed': what is delivered to a resident/board is theirs;
-- the AI's plan, reasoning, and internal next-actions are Bedrock workpaper.
-- The export tool splits at delivery (see CLAUDE.md record-ownership table).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS objectives (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  community_id       uuid REFERENCES communities(id) ON DELETE SET NULL,

  title              text NOT NULL,               -- short human label
  goal               text,                        -- the outcome to reach
  objective_type     text NOT NULL DEFAULT 'homeowner_issue'
                       CHECK (objective_type IN ('homeowner_issue','arc','drv','collections','welfare','resale','vendor','board','other')),
  owner_persona      text,                         -- which teammate drives it

  -- lifecycle. bounded on purpose: the agent navigates these states, it does not
  -- invent them (deterministic backbone + probabilistic navigation).
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','waiting_resident','waiting_third_party','waiting_human','resolved','closed')),

  -- reattachment keys — how a new inbound finds its objective
  resident_contact_id  uuid,
  resident_property_id uuid,
  resident_email     text,
  conversation_ids   text[] DEFAULT '{}',

  -- the drive loop's working fields
  next_action        text,
  next_action_due    timestamptz,
  last_activity_at   timestamptz NOT NULL DEFAULT now(),

  source_message_id  uuid,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  closed_reason      text,

  record_ownership   text NOT NULL DEFAULT 'mixed',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS objective_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id  uuid NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text,                              -- persona name | 'resident' | 'human' | 'system'
  kind          text NOT NULL DEFAULT 'note'
                  CHECK (kind IN ('opened','message_in','message_out','note','status_change','next_action','escalated','reattached','closed')),
  summary       text,
  ref_message_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_objectives_community   ON objectives (community_id);
CREATE INDEX IF NOT EXISTS idx_objectives_status      ON objectives (status);
CREATE INDEX IF NOT EXISTS idx_objectives_owner       ON objectives (owner_persona);
CREATE INDEX IF NOT EXISTS idx_objectives_email       ON objectives (lower(resident_email));
CREATE INDEX IF NOT EXISTS idx_objectives_open        ON objectives (status) WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_objectives_due         ON objectives (next_action_due) WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_objective_events_obj   ON objective_events (objective_id, at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON objectives       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON objective_events TO service_role;
GRANT SELECT                          ON objectives       TO authenticated;
GRANT SELECT                          ON objective_events TO authenticated;

COMMIT;
