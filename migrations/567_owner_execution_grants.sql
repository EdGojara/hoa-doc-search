-- 567: Owner execution grants (Ed 2026-11-17: "ONE authorization, ONE execution, and a complete
-- audit trail. No redundant approvals.")
--
-- The owner, signed in (requireOwner), issues a short-lived, scoped grant: one community, the
-- kinds of Kat runs it covers, a per-run ceiling and an expiry (at most 24 hours). Within it, each
-- explicit instruction the owner gives the AI team is executed directly: Kat's run is approved and
-- posted once, recording the grant, the owner's exact instruction, the run's fingerprint and the
-- agent that executed. The grant is the identity anchor: a chat message alone cannot prove who
-- wrote it, so the authenticated owner session that issued the grant does.
--
-- Not covered, ever: vendor bank detail changes and payment release (separate safeguards). Only the
-- accounting-run processes listed below can be granted. A grant can be revoked at any time.
--
-- Record ownership: association_record (approval evidence for the association's books).
BEGIN;

CREATE TABLE IF NOT EXISTS owner_execution_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   text NOT NULL CHECK (length(btrim(owner_user_id)) > 0),
  owner_email     text NOT NULL CHECK (length(btrim(owner_email)) > 3),
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  processes       text[] NOT NULL CONSTRAINT owner_execution_grants_processes_check
                    CHECK (cardinality(processes) > 0 AND processes <@ ARRAY['journal_entry', 'cutoff_adjustment', 'reclassification', 'bank_reconciliation', 'account_reconciliation']::text[]),
  max_run_cents   bigint NOT NULL CHECK (max_run_cents > 0),
  note            text,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      text,
  CONSTRAINT owner_execution_grants_window CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_owner_execution_grants_active ON owner_execution_grants (community_id, expires_at) WHERE revoked_at IS NULL;

-- A grant never changes except to be revoked once; it is never deleted.
CREATE OR REPLACE FUNCTION owner_execution_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an execution grant is permanent' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.owner_user_id, NEW.owner_email, NEW.community_id, NEW.processes, NEW.max_run_cents, NEW.note, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.owner_user_id, OLD.owner_email, OLD.community_id, OLD.processes, OLD.max_run_cents, OLD.note, OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an execution grant cannot be changed; revoke it and issue a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'an execution grant is revoked once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_owner_execution_grants_guard ON owner_execution_grants;
CREATE TRIGGER trg_owner_execution_grants_guard BEFORE UPDATE OR DELETE ON owner_execution_grants FOR EACH ROW EXECUTE FUNCTION owner_execution_grants_guard();
GRANT SELECT, INSERT, UPDATE ON owner_execution_grants TO service_role;

-- Approve ONE run on the owner's instruction under an active grant, atomically. The run must be in
-- the grant's community, of a granted process, still prepared, and within the per-run ceiling.
CREATE OR REPLACE FUNCTION accounting_run_execute_under_grant(p_grant uuid, p_run_id uuid, p_instruction text, p_include jsonb, p_amount_cents bigint, p_agent_id text, p_agent_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE g owner_execution_grants%ROWTYPE; r accounting_runs%ROWTYPE; lbl text;
BEGIN
  IF length(btrim(coalesce(p_agent_id, ''))) = 0 THEN RAISE EXCEPTION 'the executing agent is required' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_instruction, ''))) < 10 THEN RAISE EXCEPTION 'the owner''s exact instruction is required' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO g FROM owner_execution_grants WHERE id = p_grant FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such execution grant' USING ERRCODE = 'check_violation'; END IF;
  IF g.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'the execution grant was revoked at %', g.revoked_at USING ERRCODE = 'check_violation'; END IF;
  IF now() > g.expires_at THEN RAISE EXCEPTION 'the execution grant expired at %', g.expires_at USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM accounting_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'prepared' THEN RAISE EXCEPTION 'run % is not prepared', p_run_id USING ERRCODE = 'check_violation'; END IF;
  IF r.community_id <> g.community_id THEN RAISE EXCEPTION 'run % is not in the granted community', p_run_id USING ERRCODE = 'check_violation'; END IF;
  IF NOT (r.process = ANY (g.processes)) THEN RAISE EXCEPTION 'the grant does not cover % runs', r.process USING ERRCODE = 'check_violation'; END IF;
  IF p_amount_cents IS NULL OR p_amount_cents < 0 OR p_amount_cents > g.max_run_cents THEN
    RAISE EXCEPTION 'this run moves % cents, above the grant''s per-run ceiling of %; ask the owner', p_amount_cents, g.max_run_cents USING ERRCODE = 'check_violation';
  END IF;
  lbl := g.owner_email || ' (instruction under execution grant ' || g.id::text || '; executed by ' || coalesce(nullif(btrim(p_agent_label), ''), p_agent_id) || ')';
  UPDATE accounting_runs SET status = 'approved', approved_by = lbl, approved_at = now() WHERE id = p_run_id;
  INSERT INTO accounting_run_events (run_id, event, actor, detail)
  VALUES (p_run_id, 'approved', lbl, jsonb_build_object('channel', 'owner_grant', 'grant_id', g.id, 'authorized_by_user_id', g.owner_user_id, 'authorized_by_email', g.owner_email,
    'grant_issued_at', g.issued_at, 'grant_expires_at', g.expires_at, 'instruction', p_instruction, 'include', coalesce(p_include, '[]'::jsonb),
    'amount_cents', p_amount_cents, 'fingerprint', accounting_run_fingerprint(p_run_id), 'executed_by', p_agent_id));
  RETURN jsonb_build_object('run_id', p_run_id, 'approver', lbl, 'authorized_by_user_id', g.owner_user_id, 'authorized_by_email', g.owner_email, 'grant_id', g.id);
END;
$fn$;
REVOKE ALL ON FUNCTION accounting_run_execute_under_grant(uuid, uuid, text, jsonb, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accounting_run_execute_under_grant(uuid, uuid, text, jsonb, bigint, text, text) TO service_role;

COMMIT;
