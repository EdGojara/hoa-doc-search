-- ============================================================================
-- 486_onboarding_bridge_decisions.sql  (Issue #15, Ed 2026-10-03)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Owner decisions on activity-bridge questions, recorded AS DECISIONS (not as
-- waivers). A waiver says "this failed control is accepted anyway"; a decision
-- says "this known-real transaction enters Trusted this way" (e.g. record a July
-- vendor bill the legacy books never held after the cutoff, not on its date).
-- Mixing the two would muddy the audit trail and later proof.
--
-- What it adds (nothing else changes):
--   - onboarding_bridge_decisions: one row per decision; append-only; human
--     only; bound to the bridge result and item it answers, with the question,
--     the choices offered, the choice taken, who / when, an optional reason, and
--     the item's evidence at the moment of the decision (provenance).
--   - onboarding_record_bridge_decisions(batch, completion, decisions, actor):
--     records one or more decisions atomically. Refused unless the batch is in
--     activity_bridge, the completion is the CURRENT bridge result, the item is
--     an AMBIGUOUS item of that result carrying a question, and the choice is one
--     of the choices that question offered. A second decision on the same item of
--     the same result is refused (a new answer needs a new bridge result).
--   - onboarding_bridge_decisions_view(batch): every decision, oldest first.
-- Owner-only is enforced by the service (as for waivers); the database enforces
-- human-only. No accounting table is touched. Requires 485.
-- Record ownership: association_record (a conversion-policy decision about the
-- association's books); community-scoped through the batch (community_id kept on
-- the row for termination export).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_bridge_decisions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id          UUID NOT NULL,
  bridge_completion_id  UUID NOT NULL REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT,
  bridge_item_id        UUID NOT NULL REFERENCES onboarding_bridge_items(id) ON DELETE RESTRICT,
  item_no               INTEGER NOT NULL CHECK (item_no > 0),
  event_key             TEXT NOT NULL,
  decision_type         TEXT NOT NULL CHECK (decision_type IN ('recording_period', 'source_or_keep')),
  question              TEXT NOT NULL CHECK (length(btrim(question)) > 0),
  choices               JSONB NOT NULL CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) >= 2),
  choice_key            TEXT NOT NULL,
  choice_label          TEXT NOT NULL,
  reason                TEXT,
  item_amount_cents     BIGINT NOT NULL,
  item_event_date       DATE,
  evidence              JSONB NOT NULL,
  bridge_sha256         TEXT NOT NULL CHECK (bridge_sha256 ~ '^[0-9a-f]{64}$'),
  actor_kind            TEXT NOT NULL CHECK (actor_kind = 'human'),
  actor_id              TEXT NOT NULL CHECK (length(btrim(actor_id)) > 0),
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bridge_completion_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_onboarding_bridge_decisions_batch ON onboarding_bridge_decisions (batch_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_onboarding_bridge_decisions_item ON onboarding_bridge_decisions (bridge_item_id);

DROP TRIGGER IF EXISTS trg_onboarding_bridge_decisions_append_only ON onboarding_bridge_decisions;
CREATE TRIGGER trg_onboarding_bridge_decisions_append_only BEFORE UPDATE OR DELETE ON onboarding_bridge_decisions
  FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();

CREATE OR REPLACE FUNCTION onboarding_record_bridge_decisions(p_batch UUID, p_completion UUID, p_decisions JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; latest UUID; d JSONB; it onboarding_bridge_items%ROWTYPE; q JSONB; ch JSONB; out JSONB := '[]'::jsonb; new_id UUID;
BEGIN
  IF p_actor_kind IS DISTINCT FROM 'human' OR length(btrim(coalesce(p_actor_id, ''))) = 0 THEN
    RAISE EXCEPTION 'onboarding: only a human records a bridge decision' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: no such batch' USING ERRCODE = 'check_violation'; END IF;
  IF bt.onboarding_stage IS DISTINCT FROM 'activity_bridge' THEN
    RAISE EXCEPTION 'onboarding: bridge decisions are recorded while the batch is in activity_bridge (it is in %)', bt.onboarding_stage USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO latest FROM onboarding_stage_events WHERE batch_id = p_batch AND event_type = 'stage_completed' AND stage = 'activity_bridge' ORDER BY seq DESC LIMIT 1;
  IF latest IS NULL OR latest IS DISTINCT FROM p_completion THEN
    RAISE EXCEPTION 'onboarding: decisions are recorded against the current bridge result' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_decisions) <> 'array' OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'onboarding: decisions must be a non-empty array' USING ERRCODE = 'check_violation';
  END IF;
  FOR d IN SELECT * FROM jsonb_array_elements(p_decisions) LOOP
    SELECT * INTO it FROM onboarding_bridge_items WHERE completion_event_id = p_completion AND event_key = d->>'event_key';
    IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: % is not an item of the current bridge result', d->>'event_key' USING ERRCODE = 'check_violation'; END IF;
    IF it.classification <> 'AMBIGUOUS' THEN RAISE EXCEPTION 'onboarding: % is %, not an open question', it.event_key, it.classification USING ERRCODE = 'check_violation'; END IF;
    q := it.evidence->'decision';
    IF q IS NULL OR jsonb_typeof(q->'choices') <> 'array' OR coalesce(q->>'type', '') NOT IN ('recording_period', 'source_or_keep') THEN
      RAISE EXCEPTION 'onboarding: % carries no question to answer', it.event_key USING ERRCODE = 'check_violation';
    END IF;
    SELECT c INTO ch FROM jsonb_array_elements(q->'choices') c WHERE c->>'key' = d->>'choice' LIMIT 1;
    IF ch IS NULL THEN RAISE EXCEPTION 'onboarding: % is not one of the choices offered for %', d->>'choice', it.event_key USING ERRCODE = 'check_violation'; END IF;
    INSERT INTO onboarding_bridge_decisions (batch_id, community_id, bridge_completion_id, bridge_item_id, item_no, event_key, decision_type, question, choices, choice_key, choice_label,
                                             reason, item_amount_cents, item_event_date, evidence, bridge_sha256, actor_kind, actor_id)
    VALUES (p_batch, bt.community_id, p_completion, it.id, it.item_no, it.event_key, q->>'type', q->>'question', q->'choices', ch->>'key', ch->>'label',
            nullif(btrim(coalesce(d->>'reason', '')), ''), it.amount_cents, it.event_date, it.evidence, it.bridge_sha256, 'human', p_actor_id)
    RETURNING id INTO new_id;
    out := out || jsonb_build_array(jsonb_build_object('id', new_id, 'event_key', it.event_key, 'choice', ch->>'key'));
    ch := NULL;
  END LOOP;
  RETURN out;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_bridge_decisions_view(p_batch UUID) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'bridge_completion_id', d.bridge_completion_id, 'item_no', d.item_no, 'event_key', d.event_key,
           'decision_type', d.decision_type, 'question', d.question, 'choices', d.choices, 'choice_key', d.choice_key, 'choice_label', d.choice_label, 'reason', d.reason,
           'item_amount_cents', d.item_amount_cents, 'item_event_date', d.item_event_date, 'bridge_sha256', d.bridge_sha256, 'actor_kind', d.actor_kind, 'actor_id', d.actor_id,
           'decided_at', d.decided_at) ORDER BY d.decided_at, d.event_key), '[]'::jsonb)
    FROM onboarding_bridge_decisions d WHERE d.batch_id = p_batch;
$fn$;

REVOKE ALL ON TABLE onboarding_bridge_decisions FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE onboarding_bridge_decisions TO service_role;
REVOKE ALL ON FUNCTION onboarding_record_bridge_decisions(UUID, UUID, JSONB, TEXT, TEXT), onboarding_bridge_decisions_view(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_record_bridge_decisions(UUID, UUID, JSONB, TEXT, TEXT), onboarding_bridge_decisions_view(UUID) TO service_role;

COMMIT;
