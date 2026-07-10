-- ============================================================================
-- 273_payment_plans.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- Payment plans: a delinquent owner agrees to pay a balance down in
-- installments. The operator uploads the signed plan agreement (PDF); the AI
-- extracts the terms; each is matched to a property and filed here. The roster
-- lists everyone on a plan, and each plan surfaces on that homeowner's 360.
--
-- Record ownership: association_record. A payment plan agreement is the HOA's
-- collection record (like ar_account_collections, mig 232). One property can
-- have at most one ACTIVE plan; completed/defaulted plans stay as history.
--
-- Amounts are stored in CENTS (bigint) to match the AR ledger convention
-- (homeowner_transactions.amount_cents, v_homeowner_current_balance).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS payment_plans (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id              UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id               UUID REFERENCES properties(id) ON DELETE SET NULL,
  contact_id                UUID REFERENCES contacts(id)   ON DELETE SET NULL,

  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','completed','defaulted','cancelled')),

  -- As printed on the agreement (audit) — property_id/contact_id are the matches.
  debtor_name               TEXT,
  property_address          TEXT,

  -- Terms (cents; nullable so a partial agreement still files).
  total_amount_cents        BIGINT,   -- balance the plan covers
  down_payment_cents        BIGINT,
  installment_amount_cents  BIGINT,   -- each scheduled payment
  num_installments          INTEGER,
  frequency                 TEXT NOT NULL DEFAULT 'monthly'
                              CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly','quarterly')),
  start_date                DATE,
  first_payment_date        DATE,
  next_due_date             DATE,
  end_date                  DATE,     -- expected completion
  balance_remaining_cents   BIGINT,

  terms_summary             TEXT,     -- plain-English summary of the arrangement
  notes                     TEXT,

  -- Source agreement (board question -> source PDF in <=3 clicks).
  source_filename           TEXT,
  source_document_path      TEXT,     -- storage path in the 'documents' bucket
  extraction_model          TEXT,

  record_ownership          TEXT NOT NULL DEFAULT 'association_record',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_community ON payment_plans (community_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_plans_property  ON payment_plans (property_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_contact   ON payment_plans (contact_id);
-- At most one ACTIVE plan per property (re-upload updates it, never duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_plans_active_property
  ON payment_plans (property_id) WHERE status = 'active' AND property_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_payment_plans_updated ON payment_plans;
CREATE TRIGGER trg_payment_plans_updated BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Service role does all server-side writes; without explicit grants every
-- INSERT/UPDATE fails with "permission denied for table" (scar: migs 168/195/231).
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_plans TO service_role;
GRANT SELECT                          ON payment_plans TO authenticated;

COMMIT;
