-- ============================================================================
-- 396_shadow_drafts.sql  (Ed 2026-08-29)
-- ----------------------------------------------------------------------------
-- Shadow mode: the measurement layer that earns a persona's go-live. A trained
-- persona is run against REAL inbound mail, sends nothing, and we record exactly
-- what it would have done — its disposition (auto_ok vs needs_review), whether
-- it grounded, whether the reserved gate fired, its confidence, and the drafted
-- body. Aggregated per lane, this is the exception-rate scoreboard that turns
-- "flip Darby on?" from a gut call into a data-backed decision.
--
-- record_ownership = 'workpaper': this is Bedrock's internal production
-- measurement (draft-never-sent + our routing/judgment signals), not an
-- association record. See CLAUDE.md record-ownership table.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS shadow_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  community_id       uuid REFERENCES communities(id) ON DELETE SET NULL,

  -- what real message this shadow was run against
  source_email_id    uuid REFERENCES email_messages(id) ON DELETE CASCADE,
  source_email_ref   text,                 -- internet_message_id, for cross-run idempotency
  subject            text,
  sender_email       text,

  -- who would have handled it, and why it routed there
  persona            text NOT NULL,
  routed_reason      text,
  audience           text,                 -- resolved audience (homeowner/board/vendor/other)

  -- the judgment signals (mirror the exception router)
  disposition        text,                 -- auto_ok | needs_review
  confidence         text,                 -- high | medium | low
  disposition_reason text,
  grounded           boolean,
  reserved_gate      boolean,              -- did the reserved boundary fire
  reserved_reason    text,
  escalation_reasons text[] DEFAULT '{}',

  -- the artifact (never sent)
  body_text          text,
  model              text,
  latency_ms         integer,

  -- THE GRADING SIGNAL — the benchmark is Ed, not the staff. A persona earns its
  -- go-live by consistently meeting Ed's bar, never by matching what a staffer
  -- happened to send. ed_rewrite is the highest-fidelity encode-Ed signal: Ed's
  -- own version of the reply on real mail, the DNA the persona should learn.
  ed_rating          text CHECK (ed_rating IN ('meets_bar','needs_work')),
  ed_note            text,                 -- why it missed / what Ed wants different
  ed_rewrite         text,                 -- Ed's version of the reply (optional, gold)
  ed_rated_at        timestamptz,
  ed_rated_by        text,

  -- CONTRAST ONLY, never the benchmark: what the staff actually sent on this
  -- thread. Shown side-by-side so Ed can see (and prove) the AI beats the human
  -- baseline. It is not scored against.
  staff_reply_text   text,
  staff_reply_at     timestamptz,

  record_ownership   text NOT NULL DEFAULT 'workpaper',
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_email_id, persona)         -- one shadow per (message, persona)
);

CREATE INDEX IF NOT EXISTS idx_shadow_drafts_persona     ON shadow_drafts (persona);
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_community   ON shadow_drafts (community_id);
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_created     ON shadow_drafts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_disposition ON shadow_drafts (persona, disposition);
-- the grading queue: ungraded first
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_ungraded ON shadow_drafts (created_at DESC) WHERE ed_rating IS NULL;
CREATE INDEX IF NOT EXISTS idx_shadow_drafts_rating ON shadow_drafts (persona, ed_rating);

GRANT SELECT, INSERT, UPDATE, DELETE ON shadow_drafts TO service_role;
GRANT SELECT                          ON shadow_drafts TO authenticated;

COMMIT;
