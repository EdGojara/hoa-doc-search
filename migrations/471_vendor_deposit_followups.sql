-- ============================================================================
-- 471_vendor_deposit_followups.sql  (Ed 2026-09-28)  PROPOSED
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. A deposit, what is still owed on it,
-- and how the final bill was reconciled are part of the Association's payables
-- record and are handed over with its books.
--
-- WHY: vendor_deposits (364) records a deposit so the vendor's completion bill
-- can be matched back to it, but nothing carried the follow-up (when the balance
-- is due, for what event, against what agreed total) or recorded how the final
-- bill was reconciled. PRYME THYME KOOKERS #2836 (Waterview): 50% deposit,
-- "balance due day of set-up", event Oct 10 2026. Ed: "how will Emma know to
-- pay the remaining balance?"
--
-- SCOPE (narrow slice, per ChatGPT code review 2026-09-28): track the
-- balance-due obligation and its reconciliation, and HOLD any bill that may
-- consume a deposit. This migration never changes an AP amount, a journal entry
-- or a deposit's status. The deposit accounting (relieving 1430 or netting an
-- expensed deposit) is a separate, later step; until then an admin records the
-- manually posted adjusting entry here, after a live re-check.
--
-- Adds (all additive; creates no data):
--   * vendor_deposits follow-up columns: event_date, balance_due_date (+ basis),
--     agreed_total_cents (+ required basis; an ESTIMATE unless quote/contract),
--     project_id.
--   * vendor_deposit_reconciliations: immutable proposals (form, agreed total,
--     deposit billed, deposit ACTUALLY paid, face, credits, extras, tax, final
--     total, net due, variance, reasons, math). The newest per (deposit, bill)
--     is authoritative; older ones are superseded.
--   * vendor_deposit_reconciliation_decisions: immutable decisions. At most one
--     confirmed_match and one terminal decision (reject | unrelated |
--     duplicate_confirmed | manual_accounting_recorded) per reconciliation.
--   * vendor_deposit_events: immutable history.
--   * Functions (SECURITY DEFINER, EXECUTE for service role only), each ONE
--     transaction with row locks, the
--     checks, the write and its audit event, or nothing:
--       vendor_deposit_set_followup, vendor_deposit_propose, vendor_deposit_decide.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE _m471_before ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM vendor_deposits) AS dep_n,
  (SELECT count(*) FROM ap_invoices) AS inv_n,
  (SELECT count(*) FROM journal_entries) AS je_n;

ALTER TABLE vendor_deposits
  ADD COLUMN IF NOT EXISTS event_date         DATE,
  ADD COLUMN IF NOT EXISTS balance_due_date   DATE,
  ADD COLUMN IF NOT EXISTS balance_due_basis  TEXT
    CHECK (balance_due_basis IS NULL OR balance_due_basis IN ('deposit_invoice_terms', 'contract', 'vendor_confirmed', 'staff_entered')),
  ADD COLUMN IF NOT EXISTS agreed_total_cents BIGINT
    CHECK (agreed_total_cents IS NULL OR agreed_total_cents >= 0),
  ADD COLUMN IF NOT EXISTS agreed_total_basis TEXT
    CHECK (agreed_total_basis IS NULL OR agreed_total_basis IN ('derived_from_deposit_invoice', 'invoice_estimate', 'quote', 'contract', 'staff_entered')),
  ADD COLUMN IF NOT EXISTS project_id         UUID REFERENCES vendor_projects(id) ON DELETE SET NULL;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_deposits_agreed_total_needs_basis') THEN
    ALTER TABLE vendor_deposits ADD CONSTRAINT vendor_deposits_agreed_total_needs_basis CHECK (agreed_total_cents IS NULL OR agreed_total_basis IS NOT NULL);
  END IF;
END $c$;
COMMENT ON COLUMN vendor_deposits.agreed_total_cents IS 'Agreed total for the job. An ESTIMATE unless agreed_total_basis is quote or contract.';
COMMENT ON COLUMN vendor_deposits.balance_due_date IS 'When the remaining balance is expected to be due (e.g. the event or set-up date). A reminder, never a payment instruction.';
CREATE INDEX IF NOT EXISTS idx_vendor_deposits_due ON vendor_deposits (balance_due_date) WHERE status = 'outstanding';

CREATE OR REPLACE FUNCTION vendor_deposit_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% rows are permanent (row %)', TG_TABLE_NAME, OLD.id;
END $$;

CREATE TABLE IF NOT EXISTS vendor_deposit_reconciliations (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id                    UUID NOT NULL REFERENCES vendor_deposits(id) ON DELETE RESTRICT,
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  vendor_id                     UUID REFERENCES vendors(id) ON DELETE RESTRICT,
  incoming_invoice_id           UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  form                          TEXT NOT NULL CHECK (form IN ('balance_only', 'full_total_less_deposit', 'revised_total', 'duplicate_or_statement', 'ambiguous')),
  agreed_total_cents            BIGINT,
  agreed_total_basis            TEXT,
  deposit_billed_cents          BIGINT NOT NULL,
  deposit_paid_cents            BIGINT NOT NULL,
  deposit_still_owed_cents      BIGINT NOT NULL,
  incoming_face_cents           BIGINT NOT NULL,
  credits_shown_cents           BIGINT NOT NULL DEFAULT 0,
  extras_cents                  BIGINT NOT NULL DEFAULT 0,
  tax_cents                     BIGINT NOT NULL DEFAULT 0,
  final_total_cents             BIGINT,
  net_due_cents                 BIGINT,
  outstanding_obligation_cents  BIGINT,
  variance_cents                BIGINT,
  needs_review                  BOOLEAN NOT NULL,
  reasons                       JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings                      JSONB NOT NULL DEFAULT '[]'::jsonb,
  math                          JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_by                   TEXT NOT NULL,
  proposed_by_user_id           UUID,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vendor_deposit_reconciliations_paid_check CHECK (deposit_paid_cents + deposit_still_owed_cents = deposit_billed_cents)
);
COMMENT ON TABLE vendor_deposit_reconciliations IS 'association_record: immutable reconciliation proposals of a vendor deposit against a later bill (lib/ap/deposit_reconcile.js). Proposal only; never pays or changes AP/GL.';
CREATE INDEX IF NOT EXISTS idx_vdr_deposit ON vendor_deposit_reconciliations (deposit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vdr_invoice ON vendor_deposit_reconciliations (incoming_invoice_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_vdr_append_only ON vendor_deposit_reconciliations;
CREATE TRIGGER trg_vdr_append_only BEFORE UPDATE OR DELETE ON vendor_deposit_reconciliations
  FOR EACH ROW EXECUTE FUNCTION vendor_deposit_ledger_append_only();

CREATE TABLE IF NOT EXISTS vendor_deposit_reconciliation_decisions (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id            UUID NOT NULL REFERENCES vendor_deposit_reconciliations(id) ON DELETE RESTRICT,
  decision                     TEXT NOT NULL CHECK (decision IN ('confirmed_match', 'reject', 'unrelated', 'duplicate_confirmed', 'manual_accounting_recorded')),
  decided_by_user_id           UUID NOT NULL,
  decided_by_name              TEXT NOT NULL,
  decided_by_role              TEXT,
  note                         TEXT,
  accounting_je_id             UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  verified_invoice_total_cents BIGINT,
  verified_deposit_paid_cents  BIGINT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vdrd_manual_accounting_evidence CHECK (decision <> 'manual_accounting_recorded'
    OR (accounting_je_id IS NOT NULL AND verified_invoice_total_cents > 0 AND verified_deposit_paid_cents IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vdrd_one_terminal ON vendor_deposit_reconciliation_decisions (reconciliation_id) WHERE decision <> 'confirmed_match';
CREATE UNIQUE INDEX IF NOT EXISTS uq_vdrd_one_confirm ON vendor_deposit_reconciliation_decisions (reconciliation_id) WHERE decision = 'confirmed_match';
DROP TRIGGER IF EXISTS trg_vdrd_append_only ON vendor_deposit_reconciliation_decisions;
CREATE TRIGGER trg_vdrd_append_only BEFORE UPDATE OR DELETE ON vendor_deposit_reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION vendor_deposit_ledger_append_only();

CREATE TABLE IF NOT EXISTS vendor_deposit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id      UUID NOT NULL REFERENCES vendor_deposits(id) ON DELETE RESTRICT,
  event_type      TEXT NOT NULL CHECK (event_type IN ('followup_set', 'reconciliation_proposed', 'reconciliation_decided')),
  actor           TEXT NOT NULL,
  actor_user_id   UUID,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_vde_deposit ON vendor_deposit_events (deposit_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_vde_append_only ON vendor_deposit_events;
CREATE TRIGGER trg_vde_append_only BEFORE UPDATE OR DELETE ON vendor_deposit_events
  FOR EACH ROW EXECUTE FUNCTION vendor_deposit_ledger_append_only();

-- ---- follow-up: update + audit event, atomically ---------------------------
CREATE OR REPLACE FUNCTION vendor_deposit_set_followup(p_deposit_id uuid, p_patch jsonb, p_actor text, p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d vendor_deposits%ROWTYPE; before jsonb; after jsonb;
BEGIN
  IF p_actor_user_id IS NULL OR coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'identity_required'; END IF;
  SELECT * INTO d FROM vendor_deposits WHERE id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
  before := jsonb_build_object('event_date', d.event_date, 'balance_due_date', d.balance_due_date, 'balance_due_basis', d.balance_due_basis,
    'agreed_total_cents', d.agreed_total_cents, 'agreed_total_basis', d.agreed_total_basis, 'project_id', d.project_id, 'notes', d.notes);
  UPDATE vendor_deposits SET
    event_date         = CASE WHEN p_patch ? 'event_date' THEN (p_patch->>'event_date')::date ELSE event_date END,
    balance_due_date   = CASE WHEN p_patch ? 'balance_due_date' THEN (p_patch->>'balance_due_date')::date ELSE balance_due_date END,
    balance_due_basis  = CASE WHEN p_patch ? 'balance_due_basis' THEN p_patch->>'balance_due_basis' ELSE balance_due_basis END,
    agreed_total_cents = CASE WHEN p_patch ? 'agreed_total_cents' THEN (p_patch->>'agreed_total_cents')::bigint ELSE agreed_total_cents END,
    agreed_total_basis = CASE WHEN p_patch ? 'agreed_total_basis' THEN p_patch->>'agreed_total_basis' ELSE agreed_total_basis END,
    project_id         = CASE WHEN p_patch ? 'project_id' THEN (p_patch->>'project_id')::uuid ELSE project_id END,
    notes              = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END
  WHERE id = p_deposit_id
  RETURNING jsonb_build_object('event_date', event_date, 'balance_due_date', balance_due_date, 'balance_due_basis', balance_due_basis,
    'agreed_total_cents', agreed_total_cents, 'agreed_total_basis', agreed_total_basis, 'project_id', project_id, 'notes', notes) INTO after;
  INSERT INTO vendor_deposit_events (deposit_id, event_type, actor, actor_user_id, detail)
  VALUES (p_deposit_id, 'followup_set', p_actor, p_actor_user_id, jsonb_build_object('before', before, 'after', after));
  RETURN after;
END $$;

-- ---- proposal: insert + audit event, atomically -----------------------------
CREATE OR REPLACE FUNCTION vendor_deposit_propose(p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d vendor_deposits%ROWTYPE; inv ap_invoices%ROWTYPE; new_id uuid;
BEGIN
  IF coalesce(btrim(p_row->>'proposed_by'), '') = '' THEN RAISE EXCEPTION 'identity_required'; END IF;
  SELECT * INTO d FROM vendor_deposits WHERE id = (p_row->>'deposit_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deposit_not_found'; END IF;
  IF d.status <> 'outstanding' THEN RAISE EXCEPTION 'deposit_not_outstanding'; END IF;
  SELECT * INTO inv FROM ap_invoices WHERE id = (p_row->>'incoming_invoice_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.id = d.deposit_invoice_id THEN RAISE EXCEPTION 'same_as_deposit_invoice'; END IF;
  IF inv.community_id <> d.community_id OR (d.vendor_id IS NOT NULL AND inv.vendor_id <> d.vendor_id) THEN RAISE EXCEPTION 'vendor_or_community_mismatch'; END IF;
  INSERT INTO vendor_deposit_reconciliations
    SELECT * FROM jsonb_populate_record(NULL::vendor_deposit_reconciliations,
      -- jsonb_populate_record bypasses column defaults, so state them here.
      jsonb_build_object('credits_shown_cents', 0, 'extras_cents', 0, 'tax_cents', 0, 'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb, 'math', '[]'::jsonb)
      || jsonb_strip_nulls(p_row)
      || jsonb_build_object('id', gen_random_uuid(), 'created_at', clock_timestamp(), 'community_id', d.community_id, 'vendor_id', d.vendor_id))
  RETURNING id INTO new_id;
  INSERT INTO vendor_deposit_events (deposit_id, event_type, actor, actor_user_id, detail)
  VALUES (d.id, 'reconciliation_proposed', p_row->>'proposed_by', (p_row->>'proposed_by_user_id')::uuid,
    jsonb_build_object('reconciliation_id', new_id, 'invoice_id', inv.id, 'form', p_row->>'form', 'net_due_cents', p_row->'net_due_cents'));
  RETURN new_id;
END $$;

-- ---- decision: checks + insert + audit event, atomically --------------------
-- manual_accounting_recorded is the ONLY decision that lets a deposit-consuming
-- bill be approved, and only when: an admin records it; the adjusting journal
-- entry exists, is posted and is in this community; the bill's live total equals
-- the net due recomputed from live data by the caller; the deposit invoice's live
-- paid amount equals what that recomputation used (otherwise the proposal is
-- stale); the net due is positive (a credit/refund is not a payable); and no
-- other bill already had this deposit applied.
CREATE OR REPLACE FUNCTION vendor_deposit_decide(p_reconciliation_id uuid, p_decision text, p_actor text, p_actor_user_id uuid, p_role text,
  p_note text, p_accounting_je_id uuid, p_expected_net_cents bigint, p_live_deposit_paid_cents bigint)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r vendor_deposit_reconciliations%ROWTYPE; d vendor_deposits%ROWTYPE; inv ap_invoices%ROWTYPE; paid bigint; je_status text; je_comm uuid; new_id uuid;
BEGIN
  IF p_actor_user_id IS NULL OR coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'identity_required'; END IF;
  SELECT * INTO r FROM vendor_deposit_reconciliations WHERE id = p_reconciliation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_not_found'; END IF;
  SELECT * INTO d FROM vendor_deposits WHERE id = r.deposit_id FOR UPDATE;   -- serializes every decision on this deposit
  IF r.proposed_by_user_id IS NOT NULL AND r.proposed_by_user_id = p_actor_user_id THEN RAISE EXCEPTION 'proposer_cannot_decide'; END IF;
  IF EXISTS (SELECT 1 FROM vendor_deposit_reconciliations x WHERE x.deposit_id = r.deposit_id AND x.incoming_invoice_id = r.incoming_invoice_id
             AND x.created_at > r.created_at) THEN RAISE EXCEPTION 'superseded'; END IF;
  IF EXISTS (SELECT 1 FROM vendor_deposit_reconciliation_decisions WHERE reconciliation_id = r.id AND decision <> 'confirmed_match') THEN RAISE EXCEPTION 'already_decided'; END IF;
  IF p_decision = 'confirmed_match' AND EXISTS (SELECT 1 FROM vendor_deposit_reconciliation_decisions WHERE reconciliation_id = r.id AND decision = 'confirmed_match') THEN RAISE EXCEPTION 'already_decided'; END IF;
  IF p_decision IN ('unrelated', 'manual_accounting_recorded') AND coalesce(p_role, '') <> 'admin' THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF p_decision <> 'confirmed_match' AND coalesce(btrim(p_note), '') = '' THEN RAISE EXCEPTION 'note_required'; END IF;

  IF p_decision = 'manual_accounting_recorded' THEN
    IF r.form NOT IN ('balance_only', 'full_total_less_deposit', 'revised_total') THEN RAISE EXCEPTION 'form_not_payable'; END IF;
    IF p_expected_net_cents IS NULL OR p_expected_net_cents <= 0 THEN RAISE EXCEPTION 'net_due_not_positive'; END IF;
    SELECT * INTO inv FROM ap_invoices WHERE id = r.incoming_invoice_id FOR UPDATE;
    IF inv.status = 'voided' THEN RAISE EXCEPTION 'invoice_voided'; END IF;
    IF inv.total_cents <> p_expected_net_cents THEN RAISE EXCEPTION 'invoice_total_not_net_due'; END IF;
    SELECT coalesce(amount_paid_cents, 0) INTO paid FROM ap_invoices WHERE id = d.deposit_invoice_id;
    IF coalesce(paid, 0) <> coalesce(p_live_deposit_paid_cents, -1) THEN RAISE EXCEPTION 'stale_reconciliation'; END IF;
    SELECT status, community_id INTO je_status, je_comm FROM journal_entries WHERE id = p_accounting_je_id;
    IF je_status IS DISTINCT FROM 'posted' OR je_comm IS DISTINCT FROM d.community_id THEN RAISE EXCEPTION 'accounting_je_invalid'; END IF;
    IF EXISTS (SELECT 1 FROM vendor_deposit_reconciliation_decisions k JOIN vendor_deposit_reconciliations x ON x.id = k.reconciliation_id
               WHERE x.deposit_id = r.deposit_id AND k.decision = 'manual_accounting_recorded' AND x.incoming_invoice_id <> r.incoming_invoice_id)
      THEN RAISE EXCEPTION 'deposit_already_applied_elsewhere'; END IF;
  END IF;

  INSERT INTO vendor_deposit_reconciliation_decisions (reconciliation_id, decision, decided_by_user_id, decided_by_name, decided_by_role, note,
    accounting_je_id, verified_invoice_total_cents, verified_deposit_paid_cents)
  VALUES (r.id, p_decision, p_actor_user_id, p_actor, p_role, p_note,
    CASE WHEN p_decision = 'manual_accounting_recorded' THEN p_accounting_je_id END,
    CASE WHEN p_decision = 'manual_accounting_recorded' THEN p_expected_net_cents END,
    CASE WHEN p_decision = 'manual_accounting_recorded' THEN p_live_deposit_paid_cents END)
  RETURNING id INTO new_id;
  INSERT INTO vendor_deposit_events (deposit_id, event_type, actor, actor_user_id, detail)
  VALUES (r.deposit_id, 'reconciliation_decided', p_actor, p_actor_user_id,
    jsonb_build_object('reconciliation_id', r.id, 'decision', p_decision, 'note', p_note, 'invoice_id', r.incoming_invoice_id, 'accounting_je_id', p_accounting_je_id));
  RETURN new_id;
END $$;

ALTER TABLE vendor_deposit_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_deposit_reconciliation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_deposit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vendor_deposit_reconciliations, vendor_deposit_reconciliation_decisions, vendor_deposit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON vendor_deposit_reconciliations, vendor_deposit_reconciliation_decisions, vendor_deposit_events TO service_role;
-- Follow-up edits go through vendor_deposit_set_followup (with its audit event),
-- never a bare UPDATE. Intake still INSERTs deposits; nothing else writes them.
REVOKE UPDATE, DELETE ON vendor_deposits FROM service_role, authenticated, anon;
REVOKE ALL ON FUNCTION vendor_deposit_set_followup(uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION vendor_deposit_propose(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION vendor_deposit_decide(uuid, text, text, uuid, text, text, uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vendor_deposit_set_followup(uuid, jsonb, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION vendor_deposit_propose(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION vendor_deposit_decide(uuid, text, text, uuid, text, text, uuid, bigint, bigint) TO service_role;

DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m471_before;
  IF b.dep_n <> (SELECT count(*) FROM vendor_deposits) OR b.inv_n <> (SELECT count(*) FROM ap_invoices)
     OR b.je_n <> (SELECT count(*) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: 471 must not create or remove deposits, invoices or journal entries';
  END IF;
END
$guard$;

COMMIT;
