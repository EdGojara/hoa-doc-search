-- 434_acc_async_clarification.sql
-- ============================================================================
-- PROPOSED — NOT YET APPLIED. Ed reviews, then applies manually.
--
-- Durable persistence for the ACC ASYNC CLARIFICATION / RESUME workflow
-- (lib/ai/ASYNC_CLARIFICATION.md; Ed/ChatGPT 2026-09-19). This is the step from a
-- trustworthy single ACC decision to a trustworthy piece of WORK that Miranda can
-- own across hours or days: detect a resolvable evidence conflict, ask the
-- homeowner the minimum question, wait, follow up on her own, process the answer,
-- resume exactly where she left off, and hand a genuine exception to a human.
--
-- Reuses existing primitives (does NOT build a parallel workflow engine): case
-- identity + waiting state live on acc_decisions (status='awaiting_info'); inbound
-- reply matching is lib/acc/match_open_application.js; exactly-once inbound is
-- email_messages(graph_id); the clarification is SENT via outbound_email_drafts +
-- graph_send.sendReplyAs behind the AUTO_OUTBOUND_EMAIL kill switch; reminders ride
-- lib/scheduler.js + cron_runs; a human exception becomes a work_items row.
--
-- Three tables:
--   acc_evidence_packages   — WHAT WAS TRUE: immutable, versioned evidence snapshots
--   acc_clarifications      — WHAT IS TRUE NOW: the durable clarification lifecycle
--   acc_clarification_events— HOW WE GOT HERE: append-only history (autonomy audit)
--
-- Ownership is FIRST-CLASS (owner_type AI|HUMAN): AI-owned work stays AI-owned
-- through waiting, reminders, and ordinary clarification; human ownership begins
-- ONLY at a genuine exception, and once it transfers to a human, automation cannot
-- silently reclaim it — a return to Miranda is an EXPLICIT transition
-- (ESCALATED -> RETURNED_TO_AI -> PENDING). Time passing never escalates on its own.
--
-- Record ownership: acc_evidence_packages = WORKPAPER; acc_clarifications = MIXED
-- (the question sent + the homeowner's answer are association correspondence; the
-- workflow record is Bedrock's); acc_clarification_events = WORKPAPER.
-- ============================================================================
BEGIN;

-- 1) Immutable, versioned evidence snapshots ---------------------------------
--    Append-only: never UPDATE a version; a new version is a NEW row. Enforced at
--    the grant level (INSERT/SELECT only), like finalized_record_archive.
CREATE TABLE IF NOT EXISTS acc_evidence_packages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acc_decision_id    UUID NOT NULL REFERENCES acc_decisions(id) ON DELETE CASCADE,
  version            INT  NOT NULL,                 -- 1,2,3... (bumps on clarification)
  content_hash       TEXT NOT NULL,                 -- integrity: both models saw this
  readiness          TEXT NOT NULL
                       CHECK (readiness IN ('READY','INCOMPLETE','EXTRACTION_FAILED','CONFLICT')),
  manifest           JSONB NOT NULL,                -- per-artifact states
  conflicts          JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundle_text        TEXT NOT NULL,                 -- the frozen bytes reasoned on
  assembled_at       TIMESTAMPTZ NOT NULL,
  record_ownership   TEXT NOT NULL DEFAULT 'workpaper',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (acc_decision_id, version)                 -- exactly one row per version
);
CREATE INDEX IF NOT EXISTS idx_acc_evpkg_decision ON acc_evidence_packages (acc_decision_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_acc_evpkg_hash     ON acc_evidence_packages (content_hash);

-- 2) The clarification lifecycle ---------------------------------------------
CREATE TABLE IF NOT EXISTS acc_clarifications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acc_decision_id      UUID NOT NULL REFERENCES acc_decisions(id) ON DELETE CASCADE,
  community_id         UUID NULL REFERENCES communities(id),
  raised_from_version  INT  NOT NULL,               -- evidence-package version that raised it
  conflict_id          TEXT NOT NULL,               -- from the conflict object
  topic                TEXT NULL,
  question             TEXT NOT NULL,               -- the deterministic clarification

  status               TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','AWAITING_RESPONSE','RESOLVED',
                                           'ESCALATED','RETURNED_TO_AI','CANCELLED')),
  round                INT  NOT NULL DEFAULT 1,      -- re-ask counter (still-conflicting)

  -- FIRST-CLASS OWNERSHIP. AI owns through waiting/reminders/clarification; HUMAN
  -- owns only at a genuine exception. owner_ref: persona (e.g. 'miranda') when AI,
  -- user_profiles.id or label when HUMAN (kept generalizable beyond ACC).
  owner_type           TEXT NOT NULL DEFAULT 'AI' CHECK (owner_type IN ('AI','HUMAN')),
  owner_ref            TEXT NULL,

  -- outbound (the ask)
  outbound_draft_id    UUID NULL REFERENCES outbound_email_drafts(id) ON DELETE SET NULL,
  conversation_id      TEXT NULL,                   -- thread the ask went out on
  sent_at              TIMESTAMPTZ NULL,

  -- Miranda's own follow-up cadence (time tells MIRANDA to act, not Ed)
  follow_up_count      INT NOT NULL DEFAULT 0,
  follow_up_due_at     TIMESTAMPTZ NULL,            -- next reminder / timeout tick
  last_nudged_at       TIMESTAMPTZ NULL,

  -- inbound (the answer)
  answer_text          TEXT NULL,
  answer_email_ref     TEXT NULL,                   -- email:<graphId> that answered
  answered_at          TIMESTAMPTZ NULL,
  resolved_to_version  INT NULL,                    -- evidence-package version after resume

  -- exception
  escalation_reason    TEXT NULL
                         CHECK (escalation_reason IS NULL
                                OR escalation_reason IN ('NO_RESPONSE','UNRESOLVED_AFTER_ANSWER')),
  escalated_at         TIMESTAMPTZ NULL,
  escalated_work_item_id UUID NULL REFERENCES work_items(id) ON DELETE SET NULL,

  record_ownership     TEXT NOT NULL DEFAULT 'mixed',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- IDEMPOTENCY: one live ask per fact per round; an answer resolves exactly once.
  UNIQUE (acc_decision_id, conflict_id, round)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acc_clar_answer_ref
  ON acc_clarifications (answer_email_ref) WHERE answer_email_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acc_clar_decision ON acc_clarifications (acc_decision_id);
-- hot path for the follow-up/timeout scheduler tick:
CREATE INDEX IF NOT EXISTS idx_acc_clar_waiting
  ON acc_clarifications (follow_up_due_at) WHERE status = 'AWAITING_RESPONSE';
CREATE INDEX IF NOT EXISTS idx_acc_clar_owner ON acc_clarifications (owner_type, status);

DROP TRIGGER IF EXISTS trg_acc_clar_updated_at ON acc_clarifications;
CREATE TRIGGER trg_acc_clar_updated_at
  BEFORE UPDATE ON acc_clarifications
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- 3) Append-only lifecycle history (autonomy audit) --------------------------
--    "How we got here": why Miranda stopped, what she asked, when, what evidence
--    she had, whether she followed up, what the homeowner said, which package
--    resumed it, and why (if) it escalated. Append-only (INSERT/SELECT only).
CREATE TABLE IF NOT EXISTS acc_clarification_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clarification_id UUID NOT NULL REFERENCES acc_clarifications(id) ON DELETE CASCADE,
  acc_decision_id  UUID NOT NULL REFERENCES acc_decisions(id) ON DELETE CASCADE,
  from_status      TEXT NULL,
  to_status        TEXT NULL,
  event_type       TEXT NOT NULL,                   -- CREATED|SENT|FOLLOW_UP|ANSWER_RECEIVED|
                                                    -- RESOLVED|ESCALATED|RETURNED_TO_AI|CANCELLED|NOTE
  actor_type       TEXT NOT NULL DEFAULT 'AI' CHECK (actor_type IN ('AI','HUMAN','SYSTEM')),
  actor_ref        TEXT NULL,
  detail           JSONB NULL,                      -- question, answer_ref, version, reason, etc.
  record_ownership TEXT NOT NULL DEFAULT 'workpaper',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_acc_clar_evt_clar ON acc_clarification_events (clarification_id, created_at);
CREATE INDEX IF NOT EXISTS idx_acc_clar_evt_case ON acc_clarification_events (acc_decision_id, created_at);

-- Grants (service role writes; new tables are silently unwritable without this) --
-- evidence packages + events are APPEND-ONLY: INSERT/SELECT only, no UPDATE/DELETE.
GRANT SELECT, INSERT                 ON acc_evidence_packages     TO service_role;
GRANT SELECT                          ON acc_evidence_packages     TO authenticated;
GRANT SELECT, INSERT, UPDATE          ON acc_clarifications        TO service_role;  -- no DELETE: use CANCELLED
GRANT SELECT                          ON acc_clarifications        TO authenticated;
GRANT SELECT, INSERT                 ON acc_clarification_events  TO service_role;
GRANT SELECT                          ON acc_clarification_events  TO authenticated;

COMMIT;

-- Verify:
--   SELECT c.id, c.status, c.owner_type, c.round, c.follow_up_count,
--          c.escalation_reason, c.raised_from_version, c.resolved_to_version
--     FROM acc_clarifications c ORDER BY c.created_at DESC LIMIT 10;
--   SELECT acc_decision_id, version, readiness, content_hash
--     FROM acc_evidence_packages ORDER BY acc_decision_id, version;
--   SELECT clarification_id, event_type, from_status, to_status, actor_type, created_at
--     FROM acc_clarification_events ORDER BY created_at DESC LIMIT 20;
