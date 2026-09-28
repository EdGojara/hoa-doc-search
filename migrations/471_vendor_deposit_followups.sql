-- ============================================================================
-- 471_vendor_deposit_followups.sql  (Ed 2026-09-28)  PROPOSED
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. A deposit, what is still owed on it,
-- and how the final bill was reconciled are part of the Association's payables
-- record and are handed over with its books.
--
-- WHY: vendor_deposits (364) records a deposit so the vendor's completion bill
-- can be matched back to it, but nothing ever carried the follow-up (when the
-- balance is due, for what event, against what agreed total) or recorded how the
-- final bill was reconciled. PRYME THYME KOOKERS #2836 (Waterview): 50% deposit,
-- "balance due day of set-up", event Oct 10 2026. Ed: "how will Emma know to
-- pay the remaining balance?"
--
-- Adds (all additive; no existing row is changed; no data is created):
--   * vendor_deposits follow-up columns: event_date, balance_due_date (+ basis),
--     agreed_total_cents (+ basis: an ESTIMATE unless quote/contract), project_id.
--   * vendor_deposit_reconciliations: one immutable proposal per (deposit,
--     incoming bill) run: form, agreed total, deposit billed, deposit ACTUALLY
--     paid, face, credits, extras, tax, final total, net due, variance, reasons,
--     and the math shown to the reviewer.
--   * vendor_deposit_reconciliation_decisions: exactly one decision per
--     reconciliation, by a named person: approve (the math is right), reject
--     (it is wrong; re-run after fixing), or unrelated (the bill is a different
--     job; the deposit stays outstanding).
--   * vendor_deposit_events: append-only history of the follow-up.
-- Nothing here pays, creates a payable, or changes an AP amount. The final bill
-- still goes through the normal two-key approval and check run.
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

COMMENT ON COLUMN vendor_deposits.agreed_total_cents IS 'Agreed total for the job. An ESTIMATE unless agreed_total_basis is quote or contract.';
COMMENT ON COLUMN vendor_deposits.balance_due_date IS 'When the remaining balance is expected to be due (e.g. the event or set-up date). A reminder, never a payment instruction.';
CREATE INDEX IF NOT EXISTS idx_vendor_deposits_due ON vendor_deposits (balance_due_date) WHERE status = 'outstanding';

-- One append-only rule for the three ledger tables below.
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
  incoming_invoice_id           UUID REFERENCES ap_invoices(id) ON DELETE RESTRICT,
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
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vendor_deposit_reconciliations_paid_check CHECK (deposit_paid_cents + deposit_still_owed_cents = deposit_billed_cents)
);
COMMENT ON TABLE vendor_deposit_reconciliations IS 'association_record: immutable reconciliation of a vendor deposit against a later bill (lib/ap/deposit_reconcile.js). Proposal only; never pays.';
CREATE INDEX IF NOT EXISTS idx_vdr_deposit ON vendor_deposit_reconciliations (deposit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vdr_invoice ON vendor_deposit_reconciliations (incoming_invoice_id);
DROP TRIGGER IF EXISTS trg_vdr_append_only ON vendor_deposit_reconciliations;
CREATE TRIGGER trg_vdr_append_only BEFORE UPDATE OR DELETE ON vendor_deposit_reconciliations
  FOR EACH ROW EXECUTE FUNCTION vendor_deposit_ledger_append_only();

CREATE TABLE IF NOT EXISTS vendor_deposit_reconciliation_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id   UUID NOT NULL UNIQUE REFERENCES vendor_deposit_reconciliations(id) ON DELETE RESTRICT,
  decision            TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'unrelated')),
  decided_by_user_id  UUID,
  decided_by_name     TEXT NOT NULL,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_vdrd_append_only ON vendor_deposit_reconciliation_decisions;
CREATE TRIGGER trg_vdrd_append_only BEFORE UPDATE OR DELETE ON vendor_deposit_reconciliation_decisions
  FOR EACH ROW EXECUTE FUNCTION vendor_deposit_ledger_append_only();

CREATE TABLE IF NOT EXISTS vendor_deposit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id      UUID NOT NULL REFERENCES vendor_deposits(id) ON DELETE RESTRICT,
  event_type      TEXT NOT NULL CHECK (event_type IN ('followup_set', 'reconciliation_proposed', 'reconciliation_decided', 'applied', 'canceled', 'reopened', 'note')),
  actor           TEXT NOT NULL,
  actor_user_id   UUID,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vde_deposit ON vendor_deposit_events (deposit_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_vde_append_only ON vendor_deposit_events;
CREATE TRIGGER trg_vde_append_only BEFORE UPDATE OR DELETE ON vendor_deposit_events
  FOR EACH ROW EXECUTE FUNCTION vendor_deposit_ledger_append_only();

ALTER TABLE vendor_deposit_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_deposit_reconciliation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_deposit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vendor_deposit_reconciliations, vendor_deposit_reconciliation_decisions, vendor_deposit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON vendor_deposit_reconciliations, vendor_deposit_reconciliation_decisions, vendor_deposit_events TO service_role;

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
