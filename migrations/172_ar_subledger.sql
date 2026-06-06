-- 172: Homeowner AR Sub-Ledger — the actual receivables books
--
-- WHAT THIS IS (per Ed 2026-06-06):
-- Until now trustEd had owner_ar_snapshots (a SNAPSHOT mirror of Vantaca's
-- aging report). This migration adds the TRANSACTIONAL AR sub-ledger —
-- every charge, every payment, every application — that makes trustEd the
-- system of record for receivables instead of a visibility layer on top of
-- Vantaca's books.
--
-- TEXAS §209.0063 PRIORITY OF PAYMENTS (statutory, hard-coded in engine):
-- When a partial payment lands, Texas Property Code mandates application
-- in this exact order regardless of what the homeowner writes in the memo
-- or what the CC&Rs say:
--   1. Delinquent assessments (oldest first)
--   2. Current assessment
--   3. Attorney's fees / third-party collection costs (assessment-related)
--   4. §209.005(g) records-request fees
--   5. Other attorney's fees
--   6. Fines
--   7. Other amounts owed
-- ar_payment_applications.priority_step records which §209 step drove each
-- allocation so the trail reconstructs in a court challenge in 5 seconds.
--
-- RECORD OWNERSHIP (per CLAUDE.md):
-- ALL tables in this migration = association_record. Owner ledgers are the
-- HOA's financial records by definition — at termination they hand over.
-- The §209.0063 engine + auto-apply logic = workpaper (Bedrock IP).
--
-- BUILDS ON:
--   migration 170 (chart of accounts, posting engine, periods)
--   migration 171 (budgets — for assessment amount validation)
--   Existing owner_ar_snapshots (077) — stays as the Vantaca mirror layer;
--     this sub-ledger is the authoritative source going forward.
--
-- IDEMPOTENT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) ar_charge_types — per-community catalog of what can be charged
-- ---------------------------------------------------------------------------
-- Each charge type maps to:
--   - GL revenue account (where the credit hits when the charge posts)
--   - GL receivable account (where the debit hits — usually same AR account
--     but separated for assessments vs. fees vs. fines for cleaner reporting)
--   - §209.0063 priority step (1-7) — determines payment application order
--
-- The priority_step values are statutory. Code enforces them; this table
-- just maps Bedrock's charge_type vocabulary to the statutory step.
CREATE TABLE IF NOT EXISTS ar_charge_types (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  type_code                     TEXT NOT NULL,                            -- 'assessment_regular', 'late_fee', 'interest', etc.
  display_name                  TEXT NOT NULL,                            -- 'Regular Assessment', 'Late Fee', etc.
  category                      TEXT NOT NULL
                                  CHECK (category IN (
                                    'assessment',         -- regular or special assessment
                                    'late_fee',
                                    'interest',
                                    'attorney_fee_assessment_related',     -- §209 step 3
                                    'records_request_fee',                 -- §209 step 4
                                    'attorney_fee_other',                  -- §209 step 5
                                    'fine',                                -- §209 step 6
                                    'transfer_fee',
                                    'resale_certificate_fee',
                                    'nsf_fee',
                                    'other'                                -- §209 step 7
                                  )),
  -- §209.0063 statutory priority for payment application.
  -- 1 = highest priority (delinquent assessment); 7 = lowest (other).
  -- Engine uses this to order open charges for payment allocation.
  tx_priority_step              INTEGER NOT NULL CHECK (tx_priority_step BETWEEN 1 AND 7),

  -- GL mapping
  gl_revenue_account_id         UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  gl_receivable_account_id      UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  is_active                     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order                 INTEGER NOT NULL DEFAULT 0,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, type_code)
);

CREATE INDEX IF NOT EXISTS idx_ar_charge_types_community
  ON ar_charge_types (community_id, tx_priority_step) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_ar_charge_types_updated_at ON ar_charge_types;
CREATE TRIGGER trg_ar_charge_types_updated_at
  BEFORE UPDATE ON ar_charge_types
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) community_billing_policies — assessment + late-fee + interest rules
-- ---------------------------------------------------------------------------
-- One row per community per effective period. Allows mid-year policy changes
-- (board votes to raise late fee) without losing historical context.
CREATE TABLE IF NOT EXISTS community_billing_policies (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  effective_start_date          DATE NOT NULL,
  effective_end_date            DATE,                                    -- null = currently active

  -- Assessment structure
  assessment_cadence            TEXT NOT NULL DEFAULT 'monthly'
                                  CHECK (assessment_cadence IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
  assessment_default_amount_cents  BIGINT NOT NULL,                       -- default per-property amount; overrides can live per property later
  assessment_due_day_of_month   INTEGER NOT NULL DEFAULT 1
                                  CHECK (assessment_due_day_of_month BETWEEN 1 AND 28),
  -- Reserve contribution split (e.g. $300/mo total = $250 OPR + $50 RES)
  -- Stored as a percentage 0.00-100.00 of the assessment that goes to reserves.
  reserve_contribution_pct      NUMERIC(5,2) NOT NULL DEFAULT 0.00
                                  CHECK (reserve_contribution_pct >= 0 AND reserve_contribution_pct <= 100),

  -- Late fee rules
  grace_period_days             INTEGER NOT NULL DEFAULT 10
                                  CHECK (grace_period_days >= 0),
  late_fee_amount_cents         BIGINT NOT NULL DEFAULT 0,
  late_fee_recurring            BOOLEAN NOT NULL DEFAULT FALSE,           -- false = once per missed assessment; true = repeats each cycle

  -- Interest rules
  interest_apr_pct              NUMERIC(5,2) NOT NULL DEFAULT 0.00,       -- 10.00 = 10% APR; 0 = none
  interest_compounding          TEXT NOT NULL DEFAULT 'monthly'
                                  CHECK (interest_compounding IN ('none', 'monthly', 'daily')),
  interest_start_days_past_due  INTEGER NOT NULL DEFAULT 30,              -- starts accruing N days past due

  -- Dunning ladder timing (days past due → action triggers)
  courtesy_letter_days          INTEGER NOT NULL DEFAULT 30,
  certified_209_notice_days     INTEGER NOT NULL DEFAULT 45,              -- §209.0064 cure-and-collection notice
  collections_referral_days     INTEGER NOT NULL DEFAULT 90,

  notes                         TEXT,
  approved_by_board_at          DATE,                                    -- when the board voted on this policy
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_policies_active
  ON community_billing_policies (community_id, effective_start_date DESC)
  WHERE effective_end_date IS NULL;

DROP TRIGGER IF EXISTS trg_billing_policies_updated_at ON community_billing_policies;
CREATE TRIGGER trg_billing_policies_updated_at
  BEFORE UPDATE ON community_billing_policies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) ar_charges — every charge ever made against an owner/property
-- ---------------------------------------------------------------------------
-- The canonical receivable. balance_remaining_cents updates as payments
-- apply; original_amount_cents is immutable for audit. APPEND-ONLY: void
-- creates a reversing entry, never DELETE.
CREATE TABLE IF NOT EXISTS ar_charges (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id                   UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  charge_type_id                UUID NOT NULL REFERENCES ar_charge_types(id) ON DELETE RESTRICT,

  charge_date                   DATE NOT NULL,
  due_date                      DATE NOT NULL,
  description                   TEXT NOT NULL,
  original_amount_cents         BIGINT NOT NULL CHECK (original_amount_cents > 0),
  balance_remaining_cents       BIGINT NOT NULL,
  -- Computed via CHECK: balance starts at original, decreases as payments apply,
  -- can never go negative or exceed original.
  CHECK (balance_remaining_cents >= 0 AND balance_remaining_cents <= original_amount_cents),

  status                        TEXT NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open', 'paid', 'voided', 'written_off')),
  written_off_at                TIMESTAMPTZ,
  written_off_by_user_id        UUID,
  written_off_reason            TEXT,

  -- Source attribution
  source_module                 TEXT NOT NULL DEFAULT 'manual'
                                  CHECK (source_module IN (
                                    'manual', 'assessment_billing', 'late_fee_accrual',
                                    'interest_accrual', 'fine_assessment', 'vantaca_migration',
                                    'system'
                                  )),
  source_reference              TEXT,                                    -- e.g. vantaca transaction id

  -- GL linkage — the JE that recorded this charge
  posting_journal_entry_id      UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

  created_by_user_id            UUID,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ar_charges_property_open
  ON ar_charges (property_id, charge_date)
  WHERE status = 'open' AND balance_remaining_cents > 0;

CREATE INDEX IF NOT EXISTS idx_ar_charges_community_aging
  ON ar_charges (community_id, due_date)
  WHERE status = 'open' AND balance_remaining_cents > 0;

CREATE INDEX IF NOT EXISTS idx_ar_charges_type
  ON ar_charges (charge_type_id, charge_date);

DROP TRIGGER IF EXISTS trg_ar_charges_updated_at ON ar_charges;
CREATE TRIGGER trg_ar_charges_updated_at
  BEFORE UPDATE ON ar_charges
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) ar_payments — every payment received from an owner
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ar_payments (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id                   UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,

  payment_date                  DATE NOT NULL,
  amount_cents                  BIGINT NOT NULL CHECK (amount_cents > 0),
  unapplied_balance_cents       BIGINT NOT NULL,                         -- portion not yet applied to charges (credit balance)

  -- Source — where the payment came from
  source                        TEXT NOT NULL DEFAULT 'manual'
                                  CHECK (source IN (
                                    'manual', 'lockbox', 'ach', 'wire',
                                    'stripe_portal', 'vantaca_pay', 'propay',
                                    'mailed_check', 'in_person', 'vantaca_migration'
                                  )),
  source_reference              TEXT,                                    -- check #, ACH trace #, Stripe payment intent, etc.
  payment_batch_id              UUID,                                    -- groups batched imports (lockbox files etc.); FK added in 2C
  bank_account_id               UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,

  -- Status
  status                        TEXT NOT NULL DEFAULT 'received'
                                  CHECK (status IN ('received', 'applied', 'partial', 'voided', 'returned_nsf')),
  notes                         TEXT,

  -- GL linkage
  posting_journal_entry_id      UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

  received_by_user_id           UUID,
  received_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (unapplied_balance_cents >= 0 AND unapplied_balance_cents <= amount_cents)
);

CREATE INDEX IF NOT EXISTS idx_ar_payments_property
  ON ar_payments (property_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_ar_payments_community
  ON ar_payments (community_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_ar_payments_source_ref
  ON ar_payments (source, source_reference) WHERE source_reference IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ar_payments_updated_at ON ar_payments;
CREATE TRIGGER trg_ar_payments_updated_at
  BEFORE UPDATE ON ar_payments
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 5) ar_payment_applications — per-payment allocation rows
-- ---------------------------------------------------------------------------
-- The §209.0063 audit trail. Each row records that $X of payment P was
-- applied to charge C as priority step S. Sum of (payment_X applications)
-- equals payment_X.amount_cents - payment_X.unapplied_balance_cents.
--
-- For court challenge reconstruction: this table is the source of truth for
-- "how was this payment applied and why."
CREATE TABLE IF NOT EXISTS ar_payment_applications (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id                    UUID NOT NULL REFERENCES ar_payments(id) ON DELETE RESTRICT,
  charge_id                     UUID NOT NULL REFERENCES ar_charges(id) ON DELETE RESTRICT,
  applied_cents                 BIGINT NOT NULL CHECK (applied_cents > 0),
  priority_step                 INTEGER NOT NULL CHECK (priority_step BETWEEN 1 AND 7),  -- §209.0063 step
  applied_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                         TEXT,
  -- Reversal handling — if a payment gets voided, the application stays
  -- but voided_at marks it as no-longer-effective and an offsetting JE posts.
  voided_at                     TIMESTAMPTZ,
  voided_by_user_id             UUID,
  voided_reason                 TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, charge_id)  -- one application per (payment, charge) pair
);

CREATE INDEX IF NOT EXISTS idx_ar_payment_apps_payment
  ON ar_payment_applications (payment_id);

CREATE INDEX IF NOT EXISTS idx_ar_payment_apps_charge
  ON ar_payment_applications (charge_id);

-- ---------------------------------------------------------------------------
-- 6) v_owner_ar_balance — per-property current balance + aging
-- ---------------------------------------------------------------------------
-- Real-time aging derived from open charges. Replaces the snapshot-based
-- view for any surface that wants live receivables. The aging buckets are
-- computed from days_past_due relative to today.
DROP VIEW IF EXISTS v_owner_ar_balance CASCADE;
CREATE VIEW v_owner_ar_balance AS
WITH open_charges AS (
  SELECT
    c.community_id,
    c.property_id,
    c.due_date,
    c.balance_remaining_cents,
    (CURRENT_DATE - c.due_date) AS days_past_due
  FROM ar_charges c
  WHERE c.status = 'open'
    AND c.balance_remaining_cents > 0
)
SELECT
  community_id,
  property_id,
  COUNT(*) AS open_charge_count,
  SUM(balance_remaining_cents) AS total_balance_cents,
  SUM(CASE WHEN days_past_due <= 0  THEN balance_remaining_cents ELSE 0 END) AS bucket_current_cents,
  SUM(CASE WHEN days_past_due BETWEEN 1   AND 30 THEN balance_remaining_cents ELSE 0 END) AS bucket_1_30_cents,
  SUM(CASE WHEN days_past_due BETWEEN 31  AND 60 THEN balance_remaining_cents ELSE 0 END) AS bucket_31_60_cents,
  SUM(CASE WHEN days_past_due BETWEEN 61  AND 90 THEN balance_remaining_cents ELSE 0 END) AS bucket_61_90_cents,
  SUM(CASE WHEN days_past_due BETWEEN 91  AND 120 THEN balance_remaining_cents ELSE 0 END) AS bucket_91_120_cents,
  SUM(CASE WHEN days_past_due > 120 THEN balance_remaining_cents ELSE 0 END) AS bucket_over_120_cents,
  MAX(days_past_due) AS max_days_past_due
FROM open_charges
GROUP BY community_id, property_id;

GRANT SELECT ON v_owner_ar_balance TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) Seed standard charge types for already-onboarded communities
-- ---------------------------------------------------------------------------
-- Maps every community that has a CoA already (via migration 170 onboarding)
-- to the standard HOA charge type catalog with §209.0063 priority steps.
-- Idempotent — skips communities that already have charge types.
DO $$
DECLARE
  c RECORD;
  v_assessment_rev UUID;
  v_late_fee_rev UUID;
  v_interest_rev UUID;
  v_fine_rev UUID;
  v_transfer_rev UUID;
  v_ar_assessments UUID;
  v_ar_late_fees UUID;
  v_ar_other UUID;
BEGIN
  FOR c IN
    SELECT DISTINCT community_id FROM chart_of_accounts
    WHERE community_id NOT IN (SELECT DISTINCT community_id FROM ar_charge_types)
  LOOP
    -- Look up GL accounts by their standard numbers (seeded by coa_template)
    SELECT id INTO v_ar_assessments      FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '12000';
    SELECT id INTO v_ar_late_fees        FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '12100';
    SELECT id INTO v_ar_other            FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '12300';
    SELECT id INTO v_assessment_rev      FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '40100';
    SELECT id INTO v_late_fee_rev        FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '40300';
    SELECT id INTO v_interest_rev        FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '40500';
    SELECT id INTO v_fine_rev            FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '40330';
    SELECT id INTO v_transfer_rev        FROM chart_of_accounts WHERE community_id = c.community_id AND account_number = '40320';

    INSERT INTO ar_charge_types (community_id, type_code, display_name, category, tx_priority_step, gl_revenue_account_id, gl_receivable_account_id, display_order) VALUES
      (c.community_id, 'assessment_regular',           'Regular Assessment',                'assessment',                       1, v_assessment_rev, v_ar_assessments, 10),
      (c.community_id, 'assessment_special',           'Special Assessment',                'assessment',                       1, v_assessment_rev, v_ar_assessments, 20),
      (c.community_id, 'late_fee',                     'Late Fee',                          'late_fee',                         7, v_late_fee_rev,   v_ar_late_fees,   30),
      (c.community_id, 'interest',                     'Interest Charge',                   'interest',                         7, v_interest_rev,   v_ar_other,       40),
      (c.community_id, 'attorney_fee_assessment',      'Attorney Fee — Assessment Related', 'attorney_fee_assessment_related',  3, v_assessment_rev, v_ar_other,       50),
      (c.community_id, 'records_request_fee',          'Records Request Fee',               'records_request_fee',              4, v_late_fee_rev,   v_ar_other,       60),
      (c.community_id, 'attorney_fee_other',           'Attorney Fee — Other',              'attorney_fee_other',               5, v_late_fee_rev,   v_ar_other,       70),
      (c.community_id, 'fine',                         'Fine / Violation',                  'fine',                             6, v_fine_rev,       v_ar_other,       80),
      (c.community_id, 'transfer_fee',                 'Transfer Fee',                      'transfer_fee',                     7, v_transfer_rev,   v_ar_other,       90),
      (c.community_id, 'resale_certificate_fee',       'Resale Certificate Fee',            'resale_certificate_fee',           7, v_transfer_rev,   v_ar_other,       100),
      (c.community_id, 'nsf_fee',                      'NSF / Returned Payment Fee',        'nsf_fee',                          7, v_late_fee_rev,   v_ar_other,       110),
      (c.community_id, 'other',                        'Other Charge',                      'other',                            7, v_late_fee_rev,   v_ar_other,       120)
    ON CONFLICT (community_id, type_code) DO NOTHING;
  END LOOP;
END$$;

COMMIT;
