-- ============================================================================
-- 573 — autopay on the one-time payment path (Ed 2026-11-21).
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (same as 383). The enrollment is the
-- homeowner's standing authorisation; the disclosure text they accepted is now
-- stored on it verbatim, because that is the document produced when somebody
-- says "I never agreed to that fee."
--
-- Automatic payments now run through lib/payments/assessment_intent.js like a
-- one-time payment: the Stripe Customer and saved PaymentMethod live on the
-- PLATFORM (SetupIntent on_behalf_of = the association's connected account), and
-- each charge is a destination charge whose processing fee depends on the saved
-- method's kind and, for cards, its funding. So the enrollment records:
--   card_funding             credit / debit / prepaid / unknown, from the saved PaymentMethod
--   setup_session_id         the Checkout setup session this enrollment opened (complete must match it)
--   authorized_terms(_version) the exact recurring-payment disclosure accepted before authorising
--   noticed_fee_cents / noticed_total_cents  Reg E notice: the fee and total it named
--                            (noticed_amount_cents stays the ASSESSMENT amount the gate compares)
-- connected_account_id keeps meaning "the association account this authorisation
-- is bound to" (now via on_behalf_of rather than a Stripe-Account header).
--
-- Runs get three more outcomes, each a refusal that is logged rather than silent:
--   skipped_not_payable  the one-time gates refused (payments off, owner changed, no fee rules, ...)
--   skipped_fee_changed  the fee rules moved since the notice; re-noticed instead of charging
--   skipped_in_flight    another payment on the lot is in flight; retried next run
-- and payment_group_id ties a run to its payments rows.
--
-- Production has zero assessment_autopay rows (verified 2026-11-21), so there is
-- nothing to migrate. Additive only.
-- ============================================================================
BEGIN;

ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS card_funding TEXT
  CHECK (card_funding IS NULL OR card_funding IN ('credit', 'debit', 'prepaid', 'unknown'));
ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS setup_session_id TEXT;
ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS authorized_terms TEXT;
ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS authorized_terms_version TEXT;
ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS noticed_fee_cents INTEGER
  CHECK (noticed_fee_cents IS NULL OR noticed_fee_cents >= 0);
ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS noticed_total_cents INTEGER
  CHECK (noticed_total_cents IS NULL OR noticed_total_cents >= 0);

COMMENT ON COLUMN assessment_autopay.stripe_customer_id IS
  'Stripe Customer on the PLATFORM account (since 573). The saved method is bound to the association by on_behalf_of.';
COMMENT ON COLUMN assessment_autopay.connected_account_id IS
  'The association connected account this authorisation is bound to (SetupIntent on_behalf_of). A charge refuses if the association account changes.';
COMMENT ON COLUMN assessment_autopay.authorized_terms IS
  'The exact recurring-payment disclosure (fee schedule, notice, cap, cancellation) the homeowner accepted before authorising.';
COMMENT ON COLUMN assessment_autopay.noticed_fee_cents IS
  'Reg E: the processing fee the 10-day notice named. The charge refuses and re-notices if the fee rules changed since.';

ALTER TABLE assessment_autopay_runs ADD COLUMN IF NOT EXISTS payment_group_id UUID;
CREATE INDEX IF NOT EXISTS assessment_autopay_runs_group_idx
  ON assessment_autopay_runs (payment_group_id) WHERE payment_group_id IS NOT NULL;

ALTER TABLE assessment_autopay_runs DROP CONSTRAINT IF EXISTS assessment_autopay_runs_outcome_check;
ALTER TABLE assessment_autopay_runs ADD CONSTRAINT assessment_autopay_runs_outcome_check
  CHECK (outcome IN ('noticed', 'charged', 'failed', 'skipped_zero_balance',
                     'skipped_over_cap', 'skipped_no_notice', 'skipped_paused',
                     'skipped_not_payable', 'skipped_fee_changed', 'skipped_in_flight'));

COMMIT;
