-- ============================================================================
-- 383 — assessment autopay.
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. A homeowner's standing authorization to
-- debit their account for assessments belongs to the association's file, and it
-- is the document you produce when somebody says "I never agreed to that."
--
-- Ed 2026-08-22: "go ahead and build it out for the demo, i want to show the
-- bank a full working model" and "we are moving off of the platform."
--
-- Vantaca Pay is no longer a fallback, so this is the system of record. That
-- raises the bar: an autopay mandate is a legal instrument, not a preference
-- toggle.
--
-- WHY NOT STRIPE SUBSCRIPTIONS: an assessment is not a fixed recurring price.
-- "Pay Full Balance" is whatever is owed on the day, which moves with
-- adjustments, late fees and special assessments. So the mandate is stored once
-- (Checkout in setup mode, which captures the ACH authorization language Stripe
-- and NACHA require) and each charge is raised off-session for the real amount.
--
-- REGULATION E, and this is the part that must not be an afterthought:
-- a preauthorized transfer that VARIES in amount requires notice to the payer
-- at least 10 days before the debit. Vantaca's own terms (§5.3) push that duty
-- onto the management company and give it no mechanism. Doing the same thing to
-- ourselves would be inheriting the defect we just criticised, so the notice is
-- part of the schema: next_notice_at, notice_sent_at, and the amount that was
-- noticed — because the obligation is to warn of a SPECIFIC amount, and if the
-- final figure differs materially the notice was not given.
--
-- max_amount_cents is the homeowner's own ceiling — the control that makes
-- "pay whatever is owed" acceptable to somebody who does not want to hand over
-- an open-ended authorization. A charge above it does not silently shrink; it
-- stops and asks.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS assessment_autopay (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id           UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  portal_user_id        UUID,

  -- Who authorised it, as they identified themselves. Kept verbatim: this is
  -- the evidence, not a display field.
  payer_name            TEXT,
  payer_email           TEXT,

  -- Stripe side. The mandate lives on the payment method; the customer belongs
  -- to the ASSOCIATION's connected account, never the platform, so a homeowner's
  -- stored bank details are not pooled across communities any more than their
  -- money is.
  stripe_customer_id    TEXT,
  stripe_payment_method_id TEXT,
  connected_account_id  TEXT,
  mandate_reference     TEXT,
  method_kind           TEXT CHECK (method_kind IN ('us_bank_account', 'card')),
  method_last4          TEXT,
  method_label          TEXT,

  amount_mode           TEXT NOT NULL DEFAULT 'full_balance'
                          CHECK (amount_mode IN ('full_balance', 'fixed')),
  fixed_amount_cents    INTEGER CHECK (fixed_amount_cents IS NULL OR fixed_amount_cents > 0),
  -- The homeowner's ceiling. NULL means no cap.
  max_amount_cents      INTEGER CHECK (max_amount_cents IS NULL OR max_amount_cents > 0),

  frequency             TEXT NOT NULL DEFAULT 'on_due_date'
                          CHECK (frequency IN ('on_due_date', 'monthly', 'quarterly', 'annually')),
  day_of_month          INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),

  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('pending_setup', 'active', 'paused', 'cancelled', 'failed')),
  -- Why it stopped, in words a person can read back to the homeowner.
  status_reason         TEXT,

  next_charge_at        DATE,
  -- Reg E: the notice, the amount it named, and when it went.
  next_notice_at        DATE,
  notice_sent_at        TIMESTAMPTZ,
  noticed_amount_cents  INTEGER,

  last_charge_at        TIMESTAMPTZ,
  last_charge_amount_cents INTEGER,
  last_charge_status    TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,

  authorized_at         TIMESTAMPTZ,
  authorized_ip         TEXT,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live enrolment per property. A second active mandate on the same lot is
-- how a homeowner gets debited twice, and "seeing duplicate payments?" is the
-- banner we are specifically not going to need.
CREATE UNIQUE INDEX IF NOT EXISTS assessment_autopay_one_active
  ON assessment_autopay (property_id)
  WHERE status IN ('pending_setup', 'active', 'paused');

CREATE INDEX IF NOT EXISTS assessment_autopay_due_idx
  ON assessment_autopay (next_charge_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS assessment_autopay_notice_idx
  ON assessment_autopay (next_notice_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS assessment_autopay_community_idx
  ON assessment_autopay (community_id, status);

DROP TRIGGER IF EXISTS assessment_autopay_updated_at ON assessment_autopay;
CREATE TRIGGER assessment_autopay_updated_at
  BEFORE UPDATE ON assessment_autopay
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Every attempt, successful or not. An autopay that quietly stopped working is
-- the worst outcome here: the homeowner believes they are paid up while late
-- fees accrue, and neither side finds out until collections. The log is what
-- makes that visible.
CREATE TABLE IF NOT EXISTS assessment_autopay_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  autopay_id          UUID NOT NULL REFERENCES assessment_autopay(id) ON DELETE CASCADE,
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_cents        INTEGER,
  outcome             TEXT NOT NULL
                        CHECK (outcome IN ('noticed', 'charged', 'failed', 'skipped_zero_balance',
                                           'skipped_over_cap', 'skipped_no_notice', 'skipped_paused')),
  detail              TEXT,
  payment_id          UUID,
  processor_payment_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assessment_autopay_runs_idx
  ON assessment_autopay_runs (autopay_id, attempted_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_autopay      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_autopay_runs TO service_role;
GRANT SELECT ON assessment_autopay      TO authenticated;
GRANT SELECT ON assessment_autopay_runs TO authenticated;

COMMENT ON TABLE assessment_autopay IS
  'Standing homeowner authorisation to debit assessments. association_record — this is the document produced when somebody says they never agreed.';
COMMENT ON COLUMN assessment_autopay.max_amount_cents IS
  'Homeowner ceiling. A charge above it STOPS and asks; it never silently shrinks to fit.';
COMMENT ON COLUMN assessment_autopay.noticed_amount_cents IS
  'Reg E: the amount the 10-day notice actually named. If the final figure differs materially, notice was not given for it.';

COMMIT;
