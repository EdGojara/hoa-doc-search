-- ============================================================================
-- 535_conversion_primitives.sql  (Ed 2026-10-17)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Reusable conversion-engine primitives. Source-agnostic and community-agnostic:
-- nothing here names a community, an account, a vendor or an amount.
--
-- 1) THREE SEPARATE CONVERSION CONCEPTS, one shared approval / audit trail:
--    conversion_adjustments   balanced accounting transformations of the source
--                             position (lines, evidence, reason). The DATABASE computes
--                             the fingerprint over the content; content is immutable;
--                             an approval binds to that exact fingerprint.
--    conversion_policies      approved NON-journal instructions: cutoff authority,
--                             legacy-owner routing, suspense treatment, timing treatment,
--                             preserve source coding. Same fingerprint / approval rules.
--    conversion_exceptions    (452, EXTENDED here, not duplicated) detected discrepancies
--                             and ambiguities from the activity bridge: evidence,
--                             classification, resolution, confidence, proposed resolution.
--    conversion_object_events append-only: proposed / approved / rejected / superseded /
--                             recorded, for all three, keyed by object type.
-- 2) THE PERSISTED NORMALIZED SOURCE: onboarding_source_fact_sets + onboarding_source_facts.
--    The normalize stage stores every canonical row ONCE, with provenance (source file
--    sha256, locator, printed text, slice cutoff). A normalize PASS must carry its sealed
--    fact set (trigger). Later stages reconcile from the facts, never from the documents.
-- EXECUTE's use of these records (adjustment entries, the audit chain, legacy-owner records,
-- initial ownership, identities) is migration 536, which requires this one.
--
-- ENFORCED BY THE DATABASE (this file): content immutability and fingerprints; status
-- transitions; approve / reject only with actor_kind 'human', channel 'in_app' and the
-- current fingerprint; proposals and decisions only before EXECUTE; append-only events,
-- facts and bridge exceptions; a normalize PASS carries a sealed fact set (count and
-- contiguity checked here; the facts' sha256 is re-checked by the application on read).
-- NOT ENFORCEABLE HERE (application / session): that the 'human' actor is the signed-in
-- owner and that the request came from the app UI (api/onboarding.js: requireOwner, actor
-- from the session, never the body). The database cannot tell the app from any other
-- holder of the service key; 'in_app' is a tag the app sets, not a proof.
--
-- Record ownership: conversion_adjustments, conversion_policies, conversion_object_events =
-- association_record (decisions about, and the audit of, the association's books);
-- onboarding_source_fact_sets / onboarding_source_facts = workpaper (Bedrock's normalized
-- working copy of the source; the source documents are the association's records).
--
-- Requires the onboarding engine core 481-484 (batches, stage events, completion recording,
-- bridge). Independent of 488-501 and of the accounting tables. Changes no existing row.
-- ============================================================================
BEGIN;

DO $$ BEGIN
  IF to_regclass('onboarding_stage_events') IS NULL OR to_regclass('onboarding_bridge_items') IS NULL
     OR to_regprocedure('onboarding_assert_actor(text,text,boolean)') IS NULL OR to_regprocedure('onboarding_append_only()') IS NULL THEN
    RAISE EXCEPTION '535 requires the onboarding engine core (migrations 481-484)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0) Shared helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION conversion_sha256_jsonb(p JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(sha256(convert_to(p::text, 'UTF8')), 'hex')
$fn$;

-- Proposals and decisions only on an engine batch that has not entered EXECUTE.
CREATE OR REPLACE FUNCTION conversion_assert_batch_open(p_batch UUID) RETURNS conversion_batches LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE;
BEGIN
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS NULL THEN RAISE EXCEPTION 'onboarding: no such engine batch' USING ERRCODE = 'check_violation'; END IF;
  IF bt.onboarding_stage NOT IN ('intake','normalize','source_controls','snapshot','activity_bridge','preflight') OR NOT bt.write_locked THEN
    RAISE EXCEPTION 'onboarding: conversion adjustments / policies are fixed once the batch enters execute (batch is in %)', bt.onboarding_stage USING ERRCODE = 'check_violation';
  END IF;
  RETURN bt;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 1) Shared audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_object_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  batch_id      uuid NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  object_type   text NOT NULL CHECK (object_type IN ('adjustment','policy','exception')),
  object_id     uuid NOT NULL,
  event         text NOT NULL CHECK (event IN ('proposed','approved','rejected','superseded','recorded')),
  fingerprint   text CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_id      text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  actor_label   text,
  channel       text CHECK (channel IS NULL OR channel IN ('in_app','operator','agent')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seq),
  CONSTRAINT conversion_object_events_decision_human CHECK (event NOT IN ('approved','rejected') OR (actor_kind = 'human' AND channel = 'in_app' AND fingerprint IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_conversion_object_events_batch ON conversion_object_events (batch_id, seq);
CREATE INDEX IF NOT EXISTS idx_conversion_object_events_object ON conversion_object_events (object_type, object_id, seq);
DROP TRIGGER IF EXISTS trg_conversion_object_events_append_only ON conversion_object_events;
CREATE TRIGGER trg_conversion_object_events_append_only BEFORE UPDATE OR DELETE ON conversion_object_events FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
COMMENT ON TABLE conversion_object_events IS 'association_record: append-only audit of every conversion adjustment / policy / exception: proposed, approved, rejected, superseded, recorded (who, how, which fingerprint).';

-- ---------------------------------------------------------------------------
-- 2) Conversion ADJUSTMENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_adjustments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  adjustment_no        integer NOT NULL CHECK (adjustment_no > 0),
  kind                 text NOT NULL CHECK (kind IN ('opening_correction','reclassification','equity_normalization','suspense_reclassification','conversion_transformation')),
  effect               text NOT NULL CHECK (effect IN ('opening','post_opening')),
  allow_sign_change    boolean NOT NULL DEFAULT false,
  lines                jsonb NOT NULL,
  resolves             jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason               text NOT NULL,
  evidence             jsonb NOT NULL,
  instruction_source   text,
  supersedes_id        uuid REFERENCES conversion_adjustments(id) ON DELETE RESTRICT,
  fingerprint          text NOT NULL,
  status               text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','superseded')),
  proposed_by_kind     text NOT NULL CHECK (proposed_by_kind IN ('human','agent','system')),
  proposed_by          text NOT NULL,
  proposed_at          timestamptz NOT NULL DEFAULT now(),
  approved_by_user_id  text,
  approved_by_label    text,
  approved_at          timestamptz,
  approval_channel     text CHECK (approval_channel IS NULL OR approval_channel = 'in_app'),
  decision_note        text,
  CONSTRAINT conversion_adjustments_sign_change CHECK (NOT allow_sign_change OR effect = 'post_opening'),
  CONSTRAINT conversion_adjustments_lines_shape CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) >= 2),
  CONSTRAINT conversion_adjustments_resolves_shape CHECK (jsonb_typeof(resolves) = 'array'),
  CONSTRAINT conversion_adjustments_reason CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT conversion_adjustments_evidence CHECK (jsonb_typeof(evidence) = 'object' AND evidence ? 'artifact_sha256' AND evidence ? 'locator' AND evidence ? 'description'),
  CONSTRAINT conversion_adjustments_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT conversion_adjustments_approved CHECK (status <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND approval_channel = 'in_app'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversion_adjustments_live_no ON conversion_adjustments (batch_id, adjustment_no) WHERE status IN ('proposed','approved');
CREATE INDEX IF NOT EXISTS idx_conversion_adjustments_batch ON conversion_adjustments (batch_id, status);
COMMENT ON TABLE conversion_adjustments IS 'association_record: an approved (or proposed) balanced transformation of a conversion''s source position; content immutable, fingerprint computed by the database, approval bound to it.';

-- ---------------------------------------------------------------------------
-- 3) Conversion POLICIES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  policy_kind          text NOT NULL CHECK (policy_kind IN ('cutoff_authority','legacy_owner_routing','suspense_treatment','timing_treatment','preserve_source_coding')),
  policy_key           text NOT NULL DEFAULT '',
  value                jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  reason               text NOT NULL CHECK (length(btrim(reason)) >= 10),
  evidence             jsonb,
  instruction_source   text,
  supersedes_id        uuid REFERENCES conversion_policies(id) ON DELETE RESTRICT,
  fingerprint          text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status               text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','superseded')),
  proposed_by_kind     text NOT NULL CHECK (proposed_by_kind IN ('human','agent','system')),
  proposed_by          text NOT NULL,
  proposed_at          timestamptz NOT NULL DEFAULT now(),
  approved_by_user_id  text,
  approved_by_label    text,
  approved_at          timestamptz,
  approval_channel     text CHECK (approval_channel IS NULL OR approval_channel = 'in_app'),
  decision_note        text,
  CONSTRAINT conversion_policies_approved CHECK (status <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND approval_channel = 'in_app'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversion_policies_live ON conversion_policies (batch_id, policy_kind, policy_key) WHERE status IN ('proposed','approved');
COMMENT ON TABLE conversion_policies IS 'association_record: an approved (or proposed) non-journal conversion instruction (cutoff authority, legacy-owner routing, suspense, timing, preserve source coding); content immutable, fingerprint by the database.';

-- Fingerprints, shape checks and immutability (adjustments + policies).
CREATE OR REPLACE FUNCTION conversion_adjustments_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE l JSONB; total BIGINT := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a conversion adjustment is never deleted (supersede or reject it)' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approval_channel IS NOT NULL THEN
      RAISE EXCEPTION 'a conversion adjustment is created proposed; it is approved only through conversion_decide_object' USING ERRCODE = 'check_violation';
    END IF;
    FOR l IN SELECT x FROM jsonb_array_elements(NEW.lines) x LOOP
      IF length(btrim(coalesce(l->>'account', ''))) = 0 OR coalesce(l->>'amount_cents', '') !~ '^-?[0-9]+$' OR (l->>'amount_cents')::bigint = 0 THEN
        RAISE EXCEPTION 'every adjustment line needs an account and a non-zero integer amount_cents' USING ERRCODE = 'check_violation';
      END IF;
      total := total + (l->>'amount_cents')::bigint;
    END LOOP;
    IF total <> 0 THEN RAISE EXCEPTION 'an adjustment must balance (its lines net to %)', total USING ERRCODE = 'check_violation'; END IF;
    NEW.fingerprint := conversion_sha256_jsonb(jsonb_build_object('batch_id', NEW.batch_id, 'adjustment_no', NEW.adjustment_no, 'kind', NEW.kind, 'effect', NEW.effect,
      'allow_sign_change', NEW.allow_sign_change, 'lines', NEW.lines, 'resolves', NEW.resolves, 'reason', NEW.reason, 'evidence', NEW.evidence));
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.batch_id, NEW.community_id, NEW.adjustment_no, NEW.kind, NEW.effect, NEW.allow_sign_change, NEW.lines, NEW.resolves, NEW.reason, NEW.evidence,
      NEW.instruction_source, NEW.supersedes_id, NEW.fingerprint, NEW.proposed_by_kind, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.community_id, OLD.adjustment_no, OLD.kind, OLD.effect, OLD.allow_sign_change, OLD.lines, OLD.resolves, OLD.reason, OLD.evidence,
      OLD.instruction_source, OLD.supersedes_id, OLD.fingerprint, OLD.proposed_by_kind, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a conversion adjustment''s content is fixed once proposed; propose a new one that supersedes it' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(current_setting('onboarding.object_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'conversion adjustments change status only through conversion_decide_object / a superseding proposal' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('approved','rejected','superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'a conversion adjustment cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by_user_id, NEW.approved_by_label, NEW.approved_at, NEW.approval_channel) IS DISTINCT FROM (OLD.approved_by_user_id, OLD.approved_by_label, OLD.approved_at, OLD.approval_channel) THEN
    RAISE EXCEPTION 'an approval is permanent (it can be superseded, never rewritten)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_conversion_adjustments_guard ON conversion_adjustments;
CREATE TRIGGER trg_conversion_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON conversion_adjustments FOR EACH ROW EXECUTE FUNCTION conversion_adjustments_guard();

CREATE OR REPLACE FUNCTION conversion_policies_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a conversion policy is never deleted (supersede or reject it)' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approval_channel IS NOT NULL THEN
      RAISE EXCEPTION 'a conversion policy is created proposed; it is approved only through conversion_decide_object' USING ERRCODE = 'check_violation';
    END IF;
    NEW.policy_key := CASE WHEN NEW.policy_kind IN ('suspense_treatment','preserve_source_coding') THEN btrim(coalesce(NEW.value->>'account', '')) ELSE '' END;
    IF NEW.policy_kind IN ('suspense_treatment','preserve_source_coding') AND NEW.policy_key = '' THEN
      RAISE EXCEPTION 'a % policy names its account', NEW.policy_kind USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.policy_kind = 'suspense_treatment' AND coalesce(NEW.value->>'allocate_to_owners', '') <> 'false' THEN
      RAISE EXCEPTION 'a suspense balance is never allocated to owners (allocate_to_owners must be false)' USING ERRCODE = 'check_violation';
    END IF;
    NEW.fingerprint := conversion_sha256_jsonb(jsonb_build_object('batch_id', NEW.batch_id, 'policy_kind', NEW.policy_kind, 'policy_key', NEW.policy_key, 'value', NEW.value,
      'reason', NEW.reason, 'evidence', NEW.evidence));
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.batch_id, NEW.community_id, NEW.policy_kind, NEW.policy_key, NEW.value, NEW.reason, NEW.evidence, NEW.instruction_source, NEW.supersedes_id, NEW.fingerprint,
      NEW.proposed_by_kind, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.community_id, OLD.policy_kind, OLD.policy_key, OLD.value, OLD.reason, OLD.evidence, OLD.instruction_source, OLD.supersedes_id, OLD.fingerprint,
      OLD.proposed_by_kind, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a conversion policy''s content is fixed once proposed; propose a new one that supersedes it' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(current_setting('onboarding.object_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'conversion policies change status only through conversion_decide_object / a superseding proposal' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('approved','rejected','superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'a conversion policy cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by_user_id, NEW.approved_by_label, NEW.approved_at, NEW.approval_channel) IS DISTINCT FROM (OLD.approved_by_user_id, OLD.approved_by_label, OLD.approved_at, OLD.approval_channel) THEN
    RAISE EXCEPTION 'an approval is permanent (it can be superseded, never rewritten)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_conversion_policies_guard ON conversion_policies;
CREATE TRIGGER trg_conversion_policies_guard BEFORE INSERT OR UPDATE OR DELETE ON conversion_policies FOR EACH ROW EXECUTE FUNCTION conversion_policies_guard();

-- Propose (any actor; an agent or the operator proposes, a human owner decides).
CREATE OR REPLACE FUNCTION conversion_propose_adjustment(p_batch UUID, p_adjustment JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; id_new UUID; old conversion_adjustments%ROWTYPE; fp TEXT;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  bt := conversion_assert_batch_open(p_batch);
  IF p_adjustment ? 'supersedes_id' AND p_adjustment->>'supersedes_id' IS NOT NULL THEN
    SELECT * INTO old FROM conversion_adjustments WHERE id = (p_adjustment->>'supersedes_id')::uuid AND batch_id = p_batch FOR UPDATE;
    IF NOT FOUND OR old.status NOT IN ('proposed','approved') THEN RAISE EXCEPTION 'onboarding: only a live adjustment of this batch can be superseded' USING ERRCODE = 'check_violation'; END IF;
    PERFORM set_config('onboarding.object_writer', 'on', true);
    UPDATE conversion_adjustments SET status = 'superseded' WHERE id = old.id;
    PERFORM set_config('onboarding.object_writer', 'off', true);
    INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, fingerprint, actor_kind, actor_id, channel, detail)
    VALUES (p_batch, bt.community_id, 'adjustment', old.id, 'superseded', old.fingerprint, p_actor_kind, p_actor_id, CASE p_actor_kind WHEN 'human' THEN 'in_app' WHEN 'agent' THEN 'agent' ELSE 'operator' END, jsonb_build_object('prior_status', old.status));
  END IF;
  INSERT INTO conversion_adjustments (batch_id, community_id, adjustment_no, kind, effect, allow_sign_change, lines, resolves, reason, evidence, instruction_source, supersedes_id, fingerprint, proposed_by_kind, proposed_by)
  VALUES (p_batch, bt.community_id, (p_adjustment->>'adjustment_no')::int, p_adjustment->>'kind', p_adjustment->>'effect', coalesce((p_adjustment->>'allow_sign_change')::boolean, false),
          p_adjustment->'lines', coalesce(p_adjustment->'resolves', '[]'::jsonb), p_adjustment->>'reason', p_adjustment->'evidence', p_adjustment->>'instruction_source',
          (p_adjustment->>'supersedes_id')::uuid, repeat('0', 64), p_actor_kind, p_actor_id)
  RETURNING id, fingerprint INTO id_new, fp;
  INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, fingerprint, actor_kind, actor_id, channel, detail)
  VALUES (p_batch, bt.community_id, 'adjustment', id_new, 'proposed', fp, p_actor_kind, p_actor_id, CASE p_actor_kind WHEN 'human' THEN 'in_app' WHEN 'agent' THEN 'agent' ELSE 'operator' END,
          jsonb_strip_nulls(jsonb_build_object('instruction_source', p_adjustment->>'instruction_source', 'batch_stage', bt.onboarding_stage)));
  RETURN jsonb_build_object('id', id_new, 'fingerprint', fp);
END;
$fn$;

CREATE OR REPLACE FUNCTION conversion_propose_policy(p_batch UUID, p_policy JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; id_new UUID; old conversion_policies%ROWTYPE; fp TEXT;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  bt := conversion_assert_batch_open(p_batch);
  IF p_policy ? 'supersedes_id' AND p_policy->>'supersedes_id' IS NOT NULL THEN
    SELECT * INTO old FROM conversion_policies WHERE id = (p_policy->>'supersedes_id')::uuid AND batch_id = p_batch FOR UPDATE;
    IF NOT FOUND OR old.status NOT IN ('proposed','approved') THEN RAISE EXCEPTION 'onboarding: only a live policy of this batch can be superseded' USING ERRCODE = 'check_violation'; END IF;
    PERFORM set_config('onboarding.object_writer', 'on', true);
    UPDATE conversion_policies SET status = 'superseded' WHERE id = old.id;
    PERFORM set_config('onboarding.object_writer', 'off', true);
    INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, fingerprint, actor_kind, actor_id, channel, detail)
    VALUES (p_batch, bt.community_id, 'policy', old.id, 'superseded', old.fingerprint, p_actor_kind, p_actor_id, CASE p_actor_kind WHEN 'human' THEN 'in_app' WHEN 'agent' THEN 'agent' ELSE 'operator' END, jsonb_build_object('prior_status', old.status));
  END IF;
  INSERT INTO conversion_policies (batch_id, community_id, policy_kind, value, reason, evidence, instruction_source, supersedes_id, fingerprint, proposed_by_kind, proposed_by)
  VALUES (p_batch, bt.community_id, p_policy->>'policy_kind', p_policy->'value', p_policy->>'reason', p_policy->'evidence', p_policy->>'instruction_source',
          (p_policy->>'supersedes_id')::uuid, repeat('0', 64), p_actor_kind, p_actor_id)
  RETURNING id, fingerprint INTO id_new, fp;
  INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, fingerprint, actor_kind, actor_id, channel, detail)
  VALUES (p_batch, bt.community_id, 'policy', id_new, 'proposed', fp, p_actor_kind, p_actor_id, CASE p_actor_kind WHEN 'human' THEN 'in_app' WHEN 'agent' THEN 'agent' ELSE 'operator' END,
          jsonb_strip_nulls(jsonb_build_object('instruction_source', p_policy->>'instruction_source', 'batch_stage', bt.onboarding_stage)));
  RETURN jsonb_build_object('id', id_new, 'fingerprint', fp);
END;
$fn$;

-- Approve / reject exactly the fingerprint the owner reviewed. Human, in-app tag, before execute.
CREATE OR REPLACE FUNCTION conversion_decide_object(p_object_type TEXT, p_object_id UUID, p_decision TEXT, p_fingerprint TEXT, p_channel TEXT,
                                                    p_actor_kind TEXT, p_actor_id TEXT, p_actor_label TEXT, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; b UUID; cur_status TEXT; cur_fp TEXT;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, TRUE);
  IF p_channel IS DISTINCT FROM 'in_app' THEN RAISE EXCEPTION 'onboarding: a conversion decision is made in the app (channel in_app)' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'onboarding: the decision is approved or rejected' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision = 'rejected' AND length(btrim(coalesce(p_note, ''))) < 10 THEN RAISE EXCEPTION 'onboarding: a rejection says why (at least 10 characters)' USING ERRCODE = 'check_violation'; END IF;
  IF p_object_type = 'adjustment' THEN SELECT batch_id, status, fingerprint INTO b, cur_status, cur_fp FROM conversion_adjustments WHERE id = p_object_id FOR UPDATE;
  ELSIF p_object_type = 'policy' THEN SELECT batch_id, status, fingerprint INTO b, cur_status, cur_fp FROM conversion_policies WHERE id = p_object_id FOR UPDATE;
  ELSE RAISE EXCEPTION 'onboarding: only adjustments and policies are approved' USING ERRCODE = 'check_violation'; END IF;
  IF b IS NULL THEN RAISE EXCEPTION 'onboarding: no such conversion %', p_object_type USING ERRCODE = 'check_violation'; END IF;
  bt := conversion_assert_batch_open(b);
  IF cur_status <> 'proposed' THEN RAISE EXCEPTION 'onboarding: this % is % (only a proposed one is decided)', p_object_type, cur_status USING ERRCODE = 'check_violation'; END IF;
  IF p_fingerprint IS DISTINCT FROM cur_fp THEN RAISE EXCEPTION 'onboarding: the fingerprint you reviewed is not this % (it may have been superseded)', p_object_type USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('onboarding.object_writer', 'on', true);
  IF p_object_type = 'adjustment' THEN
    UPDATE conversion_adjustments SET status = p_decision,
           approved_by_user_id = CASE WHEN p_decision = 'approved' THEN p_actor_id END, approved_by_label = CASE WHEN p_decision = 'approved' THEN p_actor_label END,
           approved_at = CASE WHEN p_decision = 'approved' THEN now() END, approval_channel = CASE WHEN p_decision = 'approved' THEN 'in_app' END, decision_note = p_note
     WHERE id = p_object_id;
  ELSE
    UPDATE conversion_policies SET status = p_decision,
           approved_by_user_id = CASE WHEN p_decision = 'approved' THEN p_actor_id END, approved_by_label = CASE WHEN p_decision = 'approved' THEN p_actor_label END,
           approved_at = CASE WHEN p_decision = 'approved' THEN now() END, approval_channel = CASE WHEN p_decision = 'approved' THEN 'in_app' END, decision_note = p_note
     WHERE id = p_object_id;
  END IF;
  PERFORM set_config('onboarding.object_writer', 'off', true);
  INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, fingerprint, actor_kind, actor_id, actor_label, channel, detail)
  VALUES (b, bt.community_id, p_object_type, p_object_id, p_decision, cur_fp, p_actor_kind, p_actor_id, p_actor_label, 'in_app', jsonb_strip_nulls(jsonb_build_object('note', p_note, 'batch_stage', bt.onboarding_stage)));
  RETURN jsonb_build_object('id', p_object_id, 'status', p_decision, 'fingerprint', cur_fp);
END;
$fn$;

-- The digest a preflight binds and EXECUTE re-checks: sha256 of "type:id:fingerprint" of every
-- APPROVED adjustment and policy of the batch, joined by "," in byte order (lib/onboarding/conversion_objects.objectsDigest).
CREATE OR REPLACE FUNCTION onboarding_conversion_objects_digest(p_batch UUID) RETURNS TEXT LANGUAGE sql STABLE AS $fn$
  SELECT encode(sha256(convert_to(coalesce(string_agg(k, ',' ORDER BY k COLLATE "C"), ''), 'UTF8')), 'hex')
    FROM (SELECT 'adjustment:' || id::text || ':' || fingerprint AS k FROM conversion_adjustments WHERE batch_id = p_batch AND status = 'approved'
          UNION ALL
          SELECT 'policy:' || id::text || ':' || fingerprint FROM conversion_policies WHERE batch_id = p_batch AND status = 'approved') q;
$fn$;

-- ---------------------------------------------------------------------------
-- 4) Conversion EXCEPTIONS: the 452 table, extended for the activity bridge
-- ---------------------------------------------------------------------------
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS exception_source text NOT NULL DEFAULT 'staging';
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS completion_event_id uuid REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS classification text;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS resolution text;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS confidence text;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS amount_cents bigint;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS evidence jsonb;
ALTER TABLE conversion_exceptions ADD COLUMN IF NOT EXISTS proposed_resolution jsonb;
ALTER TABLE conversion_exceptions DROP CONSTRAINT IF EXISTS conversion_exceptions_status_check;
ALTER TABLE conversion_exceptions ADD CONSTRAINT conversion_exceptions_status_check CHECK (status IN ('open','resolved','waived','auto_resolved'));
ALTER TABLE conversion_exceptions DROP CONSTRAINT IF EXISTS conversion_exceptions_source_check;
ALTER TABLE conversion_exceptions ADD CONSTRAINT conversion_exceptions_source_check CHECK (exception_source IN ('staging','onboarding_bridge'));
ALTER TABLE conversion_exceptions DROP CONSTRAINT IF EXISTS conversion_exceptions_bridge_shape;
ALTER TABLE conversion_exceptions ADD CONSTRAINT conversion_exceptions_bridge_shape CHECK (exception_source <> 'onboarding_bridge' OR (
  completion_event_id IS NOT NULL AND event_key IS NOT NULL AND evidence IS NOT NULL AND confidence IN ('high','medium','low')
  AND classification IN ('ALREADY_IN_SOURCE','LEGITIMATE_SUBSEQUENT','AMBIGUOUS','OUT_OF_SCOPE')
  AND resolution IN ('already_in_source','duplicate_candidate','timing','retain','out_of_scope','owner_decided','needs_owner')
  AND (status = 'open') = (resolution = 'needs_owner')));
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversion_exceptions_bridge_event ON conversion_exceptions (completion_event_id, event_key) WHERE exception_source = 'onboarding_bridge';
COMMENT ON COLUMN conversion_exceptions.exception_source IS '535: staging (452 dry runs) or onboarding_bridge (an activity-bridge item resolved by a rule or a policy, or open for the owner, with its evidence).';

-- Bridge exceptions are a record of one bridge result: never edited, never deleted.
CREATE OR REPLACE FUNCTION conversion_exceptions_bridge_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.exception_source = 'onboarding_bridge') THEN RAISE EXCEPTION 'a bridge exception is permanent' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.exception_source = 'onboarding_bridge' THEN RAISE EXCEPTION 'a bridge exception is fixed once recorded (a re-run records a new set)' USING ERRCODE = 'check_violation'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_conversion_exceptions_bridge_guard ON conversion_exceptions;
CREATE TRIGGER trg_conversion_exceptions_bridge_guard BEFORE UPDATE OR DELETE ON conversion_exceptions FOR EACH ROW EXECUTE FUNCTION conversion_exceptions_bridge_guard();

CREATE OR REPLACE FUNCTION onboarding_record_exceptions(p_batch UUID, p_completion UUID, p_items JSONB, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $fn$
DECLARE c onboarding_stage_events%ROWTYPE; bt conversion_batches%ROWTYPE; it JSONB; n INT := 0; latest UUID; ex UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch;
  SELECT * INTO c FROM onboarding_stage_events WHERE id = p_completion AND batch_id = p_batch AND event_type = 'stage_completed' AND stage = 'activity_bridge';
  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding: not an activity-bridge result of this batch' USING ERRCODE = 'check_violation'; END IF;
  SELECT id INTO latest FROM onboarding_stage_events WHERE batch_id = p_batch AND event_type = 'stage_completed' AND stage = 'activity_bridge' ORDER BY seq DESC LIMIT 1;
  IF latest IS DISTINCT FROM p_completion THEN RAISE EXCEPTION 'onboarding: exceptions are recorded for the current bridge result only' USING ERRCODE = 'check_violation'; END IF;
  FOR it IN SELECT x FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x LOOP
    INSERT INTO conversion_exceptions (run_id, batch_id, input_kind, code, detail, status, exception_source, completion_event_id, event_key, classification, resolution, method, confidence, amount_cents, evidence, proposed_resolution)
    VALUES ((c.result->>'run_id')::uuid, p_batch, 'activity_bridge', it->>'method', coalesce(it->>'summary', it->>'method'),
            CASE WHEN it->>'resolution' = 'needs_owner' THEN 'open' ELSE 'auto_resolved' END, 'onboarding_bridge', p_completion,
            it->>'event_key', it->>'classification', it->>'resolution', it->>'method', it->>'confidence', (it->>'amount_cents')::bigint, it->'evidence', it->'proposed_resolution')
    RETURNING id INTO ex;
    INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, actor_kind, actor_id, channel, detail)
    VALUES (p_batch, bt.community_id, 'exception', ex, 'recorded', p_actor_kind, p_actor_id, CASE p_actor_kind WHEN 'human' THEN 'in_app' WHEN 'agent' THEN 'agent' ELSE 'operator' END,
            jsonb_build_object('event_key', it->>'event_key', 'resolution', it->>'resolution'));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$fn$;

CREATE OR REPLACE FUNCTION conversion_objects_view(p_batch UUID) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_build_object(
    'adjustments', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.adjustment_no, a.proposed_at) FROM conversion_adjustments a WHERE a.batch_id = p_batch), '[]'::jsonb),
    'policies', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policy_kind, p.policy_key, p.proposed_at) FROM conversion_policies p WHERE p.batch_id = p_batch), '[]'::jsonb),
    'exceptions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'completion_event_id', e.completion_event_id, 'event_key', e.event_key, 'classification', e.classification,
                    'resolution', e.resolution, 'method', e.method, 'confidence', e.confidence, 'amount_cents', e.amount_cents, 'status', e.status, 'evidence', e.evidence, 'proposed_resolution', e.proposed_resolution) ORDER BY e.created_at, e.event_key)
                  FROM conversion_exceptions e WHERE e.batch_id = p_batch AND e.exception_source = 'onboarding_bridge'
                   AND e.completion_event_id = (SELECT id FROM onboarding_stage_events WHERE batch_id = p_batch AND event_type = 'stage_completed' AND stage = 'activity_bridge' ORDER BY seq DESC LIMIT 1)), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.seq) FROM conversion_object_events v WHERE v.batch_id = p_batch), '[]'::jsonb),
    'digest', onboarding_conversion_objects_digest(p_batch));
$fn$;

-- ---------------------------------------------------------------------------
-- 5) The persisted normalized source
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_source_fact_sets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  cutoff               date NOT NULL,
  status               text NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','sealed')),
  fact_count           integer CHECK (fact_count IS NULL OR fact_count > 0),
  facts_sha256         text CHECK (facts_sha256 IS NULL OR facts_sha256 ~ '^[0-9a-f]{64}$'),
  slices               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(slices) = 'array'),
  completion_event_id  uuid UNIQUE REFERENCES onboarding_stage_events(id) ON DELETE RESTRICT,
  created_by_kind      text NOT NULL CHECK (created_by_kind IN ('human','agent','system')),
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sealed_at            timestamptz,
  CONSTRAINT onboarding_source_fact_sets_sealed CHECK (status <> 'sealed' OR (fact_count IS NOT NULL AND facts_sha256 IS NOT NULL AND sealed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS onboarding_source_facts (
  fact_set_id      uuid NOT NULL REFERENCES onboarding_source_fact_sets(id) ON DELETE RESTRICT,
  seq              integer NOT NULL CHECK (seq > 0),
  artifact_type    text NOT NULL,
  domain           text NOT NULL,
  artifact_sha256  text CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source_account_key text,
  slice_cutoff     date,
  locator          jsonb,
  raw              text,
  fact             jsonb NOT NULL,
  PRIMARY KEY (fact_set_id, seq)
);
COMMENT ON TABLE onboarding_source_facts IS 'workpaper: the normalized source of a conversion batch, one canonical row per fact with its provenance (source file sha256, locator, printed text, slice cutoff). Append-only; sealed by count; read by every stage after normalize.';

CREATE OR REPLACE FUNCTION onboarding_source_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE st TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'normalized source facts are permanent' USING ERRCODE = 'check_violation'; END IF;
  SELECT status INTO st FROM onboarding_source_fact_sets WHERE id = NEW.fact_set_id;
  IF st IS DISTINCT FROM 'staging' THEN RAISE EXCEPTION 'this fact set is sealed; nothing can be added' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_onboarding_source_facts_guard ON onboarding_source_facts;
CREATE TRIGGER trg_onboarding_source_facts_guard BEFORE INSERT OR UPDATE OR DELETE ON onboarding_source_facts FOR EACH ROW EXECUTE FUNCTION onboarding_source_facts_guard();

CREATE OR REPLACE FUNCTION onboarding_source_fact_sets_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a fact set is permanent' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.batch_id, NEW.community_id, NEW.cutoff, NEW.created_by_kind, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.community_id, OLD.cutoff, OLD.created_by_kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a fact set''s identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sealed' THEN
    IF (NEW.status, NEW.fact_count, NEW.facts_sha256, NEW.slices, NEW.sealed_at) IS DISTINCT FROM (OLD.status, OLD.fact_count, OLD.facts_sha256, OLD.slices, OLD.sealed_at)
       OR (OLD.completion_event_id IS NOT NULL AND NEW.completion_event_id IS DISTINCT FROM OLD.completion_event_id) THEN
      RAISE EXCEPTION 'a sealed fact set is fixed (only its normalize result is bound, once)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_onboarding_source_fact_sets_guard ON onboarding_source_fact_sets;
CREATE TRIGGER trg_onboarding_source_fact_sets_guard BEFORE UPDATE OR DELETE ON onboarding_source_fact_sets FOR EACH ROW EXECUTE FUNCTION onboarding_source_fact_sets_guard();

CREATE OR REPLACE FUNCTION onboarding_open_fact_set(p_batch UUID, p_cutoff DATE, p_actor_kind TEXT, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; fs UUID;
BEGIN
  PERFORM onboarding_assert_actor(p_actor_kind, p_actor_id, FALSE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS DISTINCT FROM 'normalize' THEN RAISE EXCEPTION 'onboarding: source facts are recorded in the normalize stage' USING ERRCODE = 'check_violation'; END IF;
  IF p_cutoff IS DISTINCT FROM bt.as_of_date THEN RAISE EXCEPTION 'onboarding: the fact set cutoff must be the batch cutoff %', bt.as_of_date USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO onboarding_source_fact_sets (batch_id, community_id, cutoff, created_by_kind, created_by) VALUES (p_batch, bt.community_id, p_cutoff, p_actor_kind, p_actor_id) RETURNING id INTO fs;
  RETURN fs;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_append_source_facts(p_fact_set UUID, p_facts JSONB)
RETURNS INTEGER LANGUAGE plpgsql AS $fn$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM onboarding_source_fact_sets s JOIN conversion_batches b ON b.id = s.batch_id WHERE s.id = p_fact_set AND s.status = 'staging' AND b.onboarding_stage = 'normalize') THEN
    RAISE EXCEPTION 'onboarding: no staging fact set in the normalize stage' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO onboarding_source_facts (fact_set_id, seq, artifact_type, domain, artifact_sha256, source_account_key, slice_cutoff, locator, raw, fact)
  SELECT p_fact_set, (x->>'seq')::int, x->>'artifact_type', x->>'domain', x->>'artifact_sha256', x->>'source_account_key', (x->>'slice_cutoff')::date, x->'locator', x->>'raw', x->'fact'
    FROM jsonb_array_elements(p_facts) x;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

-- Seal: the count is the contiguous sequence 1..n. (The sha256 over the facts is checked by
-- the application on every read, lib/onboarding/source_facts.verifyFacts.)
CREATE OR REPLACE FUNCTION onboarding_seal_fact_set(p_fact_set UUID, p_count INTEGER, p_sha256 TEXT, p_slices JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE n INT; mx INT;
BEGIN
  SELECT count(*), coalesce(max(seq), 0) INTO n, mx FROM onboarding_source_facts WHERE fact_set_id = p_fact_set;
  IF n <> p_count OR mx <> p_count THEN RAISE EXCEPTION 'onboarding: the fact set holds % facts (max seq %), the caller sealed %', n, mx, p_count USING ERRCODE = 'check_violation'; END IF;
  UPDATE onboarding_source_fact_sets SET status = 'sealed', fact_count = p_count, facts_sha256 = p_sha256, slices = coalesce(p_slices, '[]'::jsonb), sealed_at = now()
   WHERE id = p_fact_set AND status = 'staging';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'onboarding: no staging fact set to seal' USING ERRCODE = 'check_violation'; END IF;
  RETURN jsonb_build_object('id', p_fact_set, 'fact_count', p_count, 'facts_sha256', p_sha256);
END;
$fn$;

-- A normalize PASS must carry its sealed fact set, and binds it (once).
CREATE OR REPLACE FUNCTION onboarding_stage_events_fact_set_gate() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE fs onboarding_source_fact_sets%ROWTYPE;
BEGIN
  IF NEW.event_type <> 'stage_completed' OR NEW.stage <> 'normalize' THEN RETURN NEW; END IF;
  IF NEW.result->'summary'->'fact_set' IS NULL THEN
    IF NEW.result->>'status' = 'PASS' THEN
      RAISE EXCEPTION 'onboarding: a normalize PASS must carry its persisted source facts (migration 535); deploy the code that records them' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO fs FROM onboarding_source_fact_sets WHERE id = (NEW.result->'summary'->'fact_set'->>'id')::uuid;
  IF NOT FOUND OR fs.batch_id <> NEW.batch_id OR fs.status <> 'sealed' OR fs.completion_event_id IS NOT NULL
     OR fs.fact_count IS DISTINCT FROM (NEW.result->'summary'->'fact_set'->>'fact_count')::int OR fs.facts_sha256 IS DISTINCT FROM NEW.result->'summary'->'fact_set'->>'facts_sha256' THEN
    RAISE EXCEPTION 'onboarding: the normalize result names a fact set that is not this batch''s sealed, unbound set with that count and fingerprint' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_onboarding_stage_events_fact_set_gate ON onboarding_stage_events;
CREATE TRIGGER trg_onboarding_stage_events_fact_set_gate BEFORE INSERT ON onboarding_stage_events FOR EACH ROW EXECUTE FUNCTION onboarding_stage_events_fact_set_gate();
CREATE OR REPLACE FUNCTION onboarding_stage_events_fact_set_bind() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.event_type = 'stage_completed' AND NEW.stage = 'normalize' AND NEW.result->'summary'->'fact_set' IS NOT NULL THEN
    UPDATE onboarding_source_fact_sets SET completion_event_id = NEW.id WHERE id = (NEW.result->'summary'->'fact_set'->>'id')::uuid AND completion_event_id IS NULL;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_onboarding_stage_events_fact_set_bind ON onboarding_stage_events;
CREATE TRIGGER trg_onboarding_stage_events_fact_set_bind AFTER INSERT ON onboarding_stage_events FOR EACH ROW EXECUTE FUNCTION onboarding_stage_events_fact_set_bind();

CREATE OR REPLACE FUNCTION onboarding_fact_set_view(p_batch UUID, p_completion UUID) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT to_jsonb(s) FROM onboarding_source_fact_sets s WHERE s.batch_id = p_batch AND s.completion_event_id = p_completion;
$fn$;
CREATE OR REPLACE FUNCTION onboarding_source_facts_page(p_fact_set UUID, p_after_seq INTEGER, p_limit INTEGER) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'artifact_type', artifact_type, 'domain', domain, 'artifact_sha256', artifact_sha256, 'source_account_key', source_account_key,
           'slice_cutoff', slice_cutoff, 'locator', locator, 'raw', raw, 'fact', fact) ORDER BY seq), '[]'::jsonb)
    FROM (SELECT * FROM onboarding_source_facts WHERE fact_set_id = p_fact_set AND seq > coalesce(p_after_seq, 0) ORDER BY seq LIMIT least(greatest(coalesce(p_limit, 1000), 1), 1000)) q;
$fn$;


-- ---------------------------------------------------------------------------
-- 6) Grants: writes only through the functions above (service role), reads for the app
-- ---------------------------------------------------------------------------
ALTER TABLE conversion_object_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_source_fact_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_source_facts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON conversion_object_events, onboarding_source_facts TO service_role;
GRANT SELECT, INSERT, UPDATE ON conversion_adjustments, conversion_policies, onboarding_source_fact_sets TO service_role;
GRANT SELECT, INSERT, UPDATE ON conversion_exceptions TO service_role;
REVOKE ALL ON FUNCTION conversion_propose_adjustment(UUID, JSONB, TEXT, TEXT), conversion_propose_policy(UUID, JSONB, TEXT, TEXT),
  conversion_decide_object(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT), onboarding_conversion_objects_digest(UUID), conversion_objects_view(UUID),
  onboarding_record_exceptions(UUID, UUID, JSONB, TEXT, TEXT), onboarding_open_fact_set(UUID, DATE, TEXT, TEXT), onboarding_append_source_facts(UUID, JSONB),
  onboarding_seal_fact_set(UUID, INTEGER, TEXT, JSONB), onboarding_fact_set_view(UUID, UUID), onboarding_source_facts_page(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION conversion_propose_adjustment(UUID, JSONB, TEXT, TEXT), conversion_propose_policy(UUID, JSONB, TEXT, TEXT),
  conversion_decide_object(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT), onboarding_conversion_objects_digest(UUID), conversion_objects_view(UUID),
  onboarding_record_exceptions(UUID, UUID, JSONB, TEXT, TEXT), onboarding_open_fact_set(UUID, DATE, TEXT, TEXT), onboarding_append_source_facts(UUID, JSONB),
  onboarding_seal_fact_set(UUID, INTEGER, TEXT, JSONB), onboarding_fact_set_view(UUID, UUID), onboarding_source_facts_page(UUID, INTEGER, INTEGER) TO service_role;

COMMIT;
