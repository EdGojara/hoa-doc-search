-- ============================================================================
-- 469_payments_safe_foundation.sql  (Ed 2026-09-27)
-- ----------------------------------------------------------------------------
-- Record ownership: payments / homeowner_transactions / applications are
-- association_record (the HOA's receivable ledger); stripe_events and
-- community_account_roles are workpaper (processor plumbing / configuration).
--
-- WHY: the Stripe path could credit a homeowner before an ACH payment settled,
-- could credit the wrong owner after a sale (it inferred the owner from
-- properties.vantaca_account_id at webhook time), swallowed posting failures
-- with a 200 so Stripe never retried, and relied on one overwritten metadata
-- field for idempotency. Nothing has ever completed through it (10 test rows,
-- all pending), so this replaces the lifecycle before the first real payment.
--
-- Adds:
--   * payments: payment group, property, owner tenure, contact, Trusted account
--     number, settlement state (awaiting_payment -> processing -> settled |
--     failed | expired), posting state, review flag, ledger + journal links.
--   * stripe_events + claim/finish: each Stripe event processed at most once;
--     failures are retried by Stripe and resume idempotent steps.
--   * payment_settle / payment_mark_processing / payment_mark_failed.
--   * post_stripe_tenure_payment + payment_commit_posting: tenure-stamped AR in a
--     draft batch, committed only after its GL entry posts.
--   * EXPLICIT REVERSALS: a refund or chargeback is its own dated ledger row
--     (reverses_txn_id -> the original payment). The original payment stays
--     visible forever; reversal applications reopen the charges it paid.
--     Reversal rows are never treated as charges (both payment planners,
--     including 461's closing payoff, exclude them).
--   * community_account_roles: operating_cash / stripe_clearing / homeowner_ar.
--     Code reads the ROLE, never an account number. Seeded for the six live-GL
--     communities (1000 / 1090 / 1300 where valid).
--   * GL account 1090 "Cash in Transit - Stripe Clearing" (Cash section of the
--     balance sheet; NOT cash on hand): settled payments held at Stripe before
--     payout. Payment Dr clearing / Cr AR; payout (later) Dr cash / Cr clearing.
--   * Payment sandbox capability: properties.payment_sandbox, at most one lot,
--     only in a demo community. This migration flags NO lot and creates NO demo
--     data; the sandbox lot is provisioned separately (test mode only) by
--     lib/payments/payment_sandbox_provision.js.
--   * Autopay: tenure_id on enrollments; a sale cancels the seller's enrollment.
-- No existing payment, ledger or journal row is changed; balances are guarded.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE _m469_before ON COMMIT DROP AS SELECT
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) AS cur_h,
  (SELECT md5(coalesce(string_agg(id::text || amount_cents::text || coalesce(tenure_id::text, ''), ',' ORDER BY id), '')) FROM homeowner_transactions) AS ht_h,
  (SELECT count(*) FROM payments) AS pay_n;

-- ---------------------------------------------------------------------------
-- 1) Account roles: code asks for a role, never an account number
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_account_roles (
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  role          text NOT NULL CHECK (role IN ('operating_cash', 'stripe_clearing', 'homeowner_ar')),
  account_id    uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  updated_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, role)
);
COMMENT ON TABLE community_account_roles IS 'workpaper: which GL account plays each role for a community. Payment posting reads stripe_clearing / homeowner_ar here; cash-on-hand summaries exclude stripe_clearing.';
ALTER TABLE community_account_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON community_account_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON community_account_roles TO service_role;

CREATE OR REPLACE FUNCTION community_account_roles_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a chart_of_accounts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM chart_of_accounts WHERE id = NEW.account_id;
  IF NOT FOUND OR a.community_id <> NEW.community_id THEN RAISE EXCEPTION 'account % is not in community %', NEW.account_id, NEW.community_id; END IF;
  IF a.is_summary OR NOT a.is_active THEN RAISE EXCEPTION 'account % must be active and postable for role %', a.account_number, NEW.role; END IF;
  IF a.account_type <> 'asset' OR a.normal_balance <> 'debit' THEN
    RAISE EXCEPTION 'role % needs a debit-normal asset account (% is %/%)', NEW.role, a.account_number, a.account_type, a.normal_balance;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_community_account_roles_guard ON community_account_roles;
CREATE TRIGGER trg_community_account_roles_guard BEFORE INSERT OR UPDATE ON community_account_roles
  FOR EACH ROW EXECUTE FUNCTION community_account_roles_guard();

-- Stripe clearing beside every Operating Cash account (numbered 1090 where free).
INSERT INTO chart_of_accounts (community_id, fund_id, account_number, account_name, account_type, account_subtype,
                               normal_balance, is_summary, is_active, description)
SELECT c.community_id, c.fund_id, '1090', 'Cash in Transit - Stripe Clearing', 'asset', c.account_subtype, 'debit', false, true,
       'Settled homeowner payments held at Stripe, not yet paid out to the operating bank account. Not cash on hand. Payment: Dr this / Cr AR. Payout: Dr operating cash / Cr this.'
  FROM chart_of_accounts c
 WHERE c.account_number = '1000'
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.community_id = c.community_id AND x.account_number = '1090');

-- Seed roles where the conventional accounts exist (never overwrite a configured role).
INSERT INTO community_account_roles (community_id, role, account_id, updated_by)
SELECT a.community_id, r.role, a.id, 'migration 469'
  FROM (VALUES ('operating_cash', '1000'), ('stripe_clearing', '1090'), ('homeowner_ar', '1300')) AS r(role, num)
  JOIN chart_of_accounts a ON a.account_number = r.num AND a.is_active AND NOT a.is_summary
 WHERE EXISTS (SELECT 1 FROM chart_of_accounts k WHERE k.community_id = a.community_id AND k.account_number = '1000')
ON CONFLICT (community_id, role) DO NOTHING;

-- One GL entry per Stripe payment (stripe:pay:<id>) and one per reversal (stripe:rev:<id>).
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_stripe_ref ON journal_entries (community_id, source_reference)
  WHERE source_reference LIKE 'stripe:%';

-- ---------------------------------------------------------------------------
-- 2) payments: identity, settlement and posting state
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_group_id          uuid,
  ADD COLUMN IF NOT EXISTS property_id               uuid REFERENCES properties(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS tenure_id                 uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS contact_id                uuid REFERENCES contacts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS trusted_account_number    text,
  ADD COLUMN IF NOT EXISTS portal_user_id            uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_method_type       text CHECK (payment_method_type IS NULL OR payment_method_type IN ('card', 'us_bank_account')),
  ADD COLUMN IF NOT EXISTS livemode                  boolean,
  ADD COLUMN IF NOT EXISTS settlement_state          text CHECK (settlement_state IS NULL OR settlement_state IN ('awaiting_payment', 'processing', 'settled', 'failed', 'expired', 'checkout_failed')),
  ADD COLUMN IF NOT EXISTS settled_at                timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_charge_id          text,
  ADD COLUMN IF NOT EXISTS posting_state             text CHECK (posting_state IS NULL OR posting_state IN ('not_posted', 'posted', 'not_applicable', 'blocked', 'reversed', 'review')),
  ADD COLUMN IF NOT EXISTS posting_note              text,
  ADD COLUMN IF NOT EXISTS posted_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS homeowner_txn_id          uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS journal_entry_id          uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversal_txn_id           uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS needs_review              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason             text;

COMMENT ON COLUMN payments.payment_group_id IS 'One checkout = one group (all fee lines). Generated before the Stripe session and sent as metadata, so a webhook can always find its rows.';
COMMENT ON COLUMN payments.tenure_id IS 'The ownership tenure captured at checkout. The payment credits THIS owner even if the lot sells before it settles. Never inferred from an account number.';
COMMENT ON COLUMN payments.trusted_account_number IS 'The lot''s durable Trusted account number at checkout.';
COMMENT ON COLUMN payments.settlement_state IS 'Only ''settled'' may credit a homeowner. ACH stays ''processing'' until Stripe confirms the funds.';
COMMENT ON COLUMN payments.needs_review IS 'A person must look (partial refund, dispute, paid-after-failure, failure-after-settlement). posting_state keeps stating what the books show.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_assessment_identity_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_assessment_identity_check CHECK (
      payment_group_id IS NULL OR product_type <> 'assessment_payment'
      OR (property_id IS NOT NULL AND tenure_id IS NOT NULL AND trusted_account_number IS NOT NULL
          AND settlement_state IS NOT NULL AND posting_state IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_group_fee ON payments (payment_group_id, fee_type) WHERE payment_group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_session_fee ON payments (processor_session_id, fee_type)
  WHERE payment_group_id IS NOT NULL AND processor_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_tenure ON payments (tenure_id) WHERE tenure_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_property ON payments (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_group ON payments (payment_group_id) WHERE payment_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_needs_review ON payments (community_id) WHERE needs_review;

-- ---------------------------------------------------------------------------
-- 3) stripe_events: every delivery recorded, processed at most once
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id           text PRIMARY KEY,
  event_type         text NOT NULL,
  livemode           boolean NOT NULL,
  account_id         text,
  object_id          text,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  attempts           int  NOT NULL DEFAULT 0,
  last_error         text,
  outcome            jsonb,
  first_received_at  timestamptz NOT NULL DEFAULT now(),
  last_attempt_at    timestamptz,
  processed_at       timestamptz
);
COMMENT ON TABLE stripe_events IS 'workpaper: one row per Stripe webhook event. processed/ignored = never re-run; failed = Stripe retry re-runs it; processing older than 5 minutes is reclaimable.';
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON stripe_events (status, last_attempt_at);
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stripe_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON stripe_events TO service_role;

CREATE OR REPLACE FUNCTION stripe_event_claim(p_event_id text, p_type text, p_livemode boolean, p_account text,
                                              p_object_id text, p_payload jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e stripe_events%ROWTYPE;
BEGIN
  IF coalesce(btrim(p_event_id), '') = '' THEN RAISE EXCEPTION 'event id required'; END IF;
  INSERT INTO stripe_events (event_id, event_type, livemode, account_id, object_id, payload)
  VALUES (p_event_id, p_type, coalesce(p_livemode, false), p_account, p_object_id, coalesce(p_payload, '{}'::jsonb))
  ON CONFLICT (event_id) DO NOTHING;
  SELECT * INTO e FROM stripe_events WHERE event_id = p_event_id FOR UPDATE;
  IF e.status IN ('processed', 'ignored') THEN RETURN 'done'; END IF;
  IF e.status = 'processing' AND e.last_attempt_at > now() - interval '5 minutes' THEN RETURN 'busy'; END IF;
  UPDATE stripe_events SET status = 'processing', attempts = attempts + 1, last_attempt_at = now() WHERE event_id = p_event_id;
  RETURN 'process';
END $$;

CREATE OR REPLACE FUNCTION stripe_event_finish(p_event_id text, p_status text, p_error text, p_outcome jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('processed', 'failed', 'ignored') THEN RAISE EXCEPTION 'bad finish status %', p_status; END IF;
  UPDATE stripe_events
     SET status = p_status, last_error = p_error, outcome = p_outcome,
         processed_at = CASE WHEN p_status IN ('processed', 'ignored') THEN now() ELSE processed_at END
   WHERE event_id = p_event_id AND status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'event % is not being processed', p_event_id; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Settlement state transitions (row-locked compare-and-set)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payment_group_anchor(p_group uuid, p_session text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT id FROM payments
   WHERE product_type = 'assessment_payment' AND fee_type = 'assessment'
     AND ((p_group IS NOT NULL AND payment_group_id = p_group)
          OR (p_group IS NULL AND p_session IS NOT NULL AND processor_session_id = p_session))
   ORDER BY created_at DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION payment_settle(p_group uuid, p_session text, p_payment_intent text, p_charge text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE anchor uuid; p payments%ROWTYPE;
BEGIN
  anchor := payment_group_anchor(p_group, p_session);
  IF anchor IS NULL THEN RETURN jsonb_build_object('action', 'unknown'); END IF;
  SELECT * INTO p FROM payments WHERE id = anchor FOR UPDATE;
  IF p.payment_group_id IS NULL THEN RETURN jsonb_build_object('action', 'legacy', 'payment_id', p.id); END IF;
  IF p.settlement_state IN ('awaiting_payment', 'processing') THEN
    UPDATE payments SET status = 'succeeded', settlement_state = 'settled', settled_at = now(), paid_at = now(),
           processor_payment_id = coalesce(p_payment_intent, processor_payment_id),
           stripe_charge_id = coalesce(p_charge, stripe_charge_id), updated_at = now()
     WHERE payment_group_id = p.payment_group_id;
    RETURN jsonb_build_object('action', 'post', 'payment_id', p.id);
  ELSIF p.settlement_state = 'settled' THEN
    IF p.posting_state IN ('posted', 'not_applicable', 'reversed', 'review') THEN
      RETURN jsonb_build_object('action', 'done', 'payment_id', p.id, 'posting_state', p.posting_state);
    END IF;
    RETURN jsonb_build_object('action', 'post', 'payment_id', p.id);   -- resume an interrupted posting
  END IF;
  -- Paid after we recorded failure/expiry: never guess; hold for a person.
  UPDATE payments SET posting_state = 'review', needs_review = true,
         review_reason = 'Stripe reported payment after the checkout was ' || p.settlement_state,
         processor_payment_id = coalesce(p_payment_intent, processor_payment_id), updated_at = now()
   WHERE payment_group_id = p.payment_group_id;
  RETURN jsonb_build_object('action', 'review', 'payment_id', p.id, 'state', p.settlement_state);
END $$;

CREATE OR REPLACE FUNCTION payment_mark_processing(p_group uuid, p_session text, p_payment_intent text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE anchor uuid; p payments%ROWTYPE;
BEGIN
  anchor := payment_group_anchor(p_group, p_session);
  IF anchor IS NULL THEN RETURN jsonb_build_object('action', 'unknown'); END IF;
  SELECT * INTO p FROM payments WHERE id = anchor FOR UPDATE;
  IF p.payment_group_id IS NULL THEN RETURN jsonb_build_object('action', 'legacy', 'payment_id', p.id); END IF;
  IF p.settlement_state = 'awaiting_payment' THEN
    UPDATE payments SET settlement_state = 'processing', processor_payment_id = coalesce(p_payment_intent, processor_payment_id), updated_at = now()
     WHERE payment_group_id = p.payment_group_id;
    RETURN jsonb_build_object('action', 'processing', 'payment_id', p.id);
  END IF;
  RETURN jsonb_build_object('action', 'done', 'payment_id', p.id, 'state', p.settlement_state);
END $$;

CREATE OR REPLACE FUNCTION payment_mark_failed(p_group uuid, p_session text, p_payment_intent text, p_terminal text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE anchor uuid; p payments%ROWTYPE;
BEGIN
  IF p_terminal NOT IN ('failed', 'expired') THEN RAISE EXCEPTION 'bad terminal state %', p_terminal; END IF;
  anchor := payment_group_anchor(p_group, p_session);
  IF anchor IS NULL AND p_payment_intent IS NOT NULL THEN
    SELECT id INTO anchor FROM payments WHERE processor_payment_id = p_payment_intent AND fee_type = 'assessment'
       AND product_type = 'assessment_payment' ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF anchor IS NULL THEN RETURN jsonb_build_object('action', 'unknown'); END IF;
  SELECT * INTO p FROM payments WHERE id = anchor FOR UPDATE;
  IF p.payment_group_id IS NULL THEN RETURN jsonb_build_object('action', 'legacy', 'payment_id', p.id); END IF;
  IF p.settlement_state IN ('awaiting_payment', 'processing') THEN
    UPDATE payments SET settlement_state = p_terminal,
           status = CASE WHEN p_terminal = 'expired' THEN 'cancelled' ELSE 'failed' END,
           failure_reason = p_reason, processor_payment_id = coalesce(p_payment_intent, processor_payment_id), updated_at = now()
     WHERE payment_group_id = p.payment_group_id;
    RETURN jsonb_build_object('action', p_terminal, 'payment_id', p.id);
  ELSIF p.settlement_state = 'settled' THEN
    -- Money was confirmed, then reported failed: needs a controlled reversal, not a flag flip.
    UPDATE payments SET needs_review = true,
           review_reason = 'Stripe reported failure after settlement: ' || coalesce(p_reason, ''), updated_at = now()
     WHERE payment_group_id = p.payment_group_id;
    RETURN jsonb_build_object('action', 'settled_needs_review', 'payment_id', p.id);
  END IF;
  RETURN jsonb_build_object('action', 'done', 'payment_id', p.id, 'state', p.settlement_state);
END $$;

CREATE OR REPLACE FUNCTION payment_flag_review(p_payment_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a review flag needs a reason'; END IF;
  UPDATE payments SET needs_review = true,
         review_reason = CASE WHEN review_reason IS NULL THEN p_reason ELSE review_reason || ' | ' || p_reason END,
         updated_at = now()
   WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
END $$;

CREATE OR REPLACE FUNCTION payment_mark_posting(p_payment_id uuid, p_state text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_state NOT IN ('not_applicable', 'blocked', 'review') THEN RAISE EXCEPTION 'bad posting state %', p_state; END IF;
  UPDATE payments SET posting_state = p_state, posting_note = p_note, updated_at = now()
   WHERE id = p_payment_id AND posting_state IN ('not_posted', 'blocked');
END $$;

-- ---------------------------------------------------------------------------
-- 5) Ledger: explicit reversals, and reversal rows are never charges
-- ---------------------------------------------------------------------------
ALTER TABLE homeowner_transactions ADD COLUMN IF NOT EXISTS reverses_txn_id uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT;
COMMENT ON COLUMN homeowner_transactions.reverses_txn_id IS 'Set on a refund / chargeback row: the payment it reverses. The original payment stays visible; this row is a separate dated transaction and is never treated as a charge.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_reverses ON homeowner_transactions (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_stripe_payment
  ON homeowner_transactions ((raw_row_jsonb->>'payment_id')) WHERE raw_row_jsonb->>'source' = 'stripe_payment';

-- Categories: superset of 455's list plus the two reversal kinds.
-- Drops only the category-list constraint (455's, or 203's if 455 never ran),
-- never 469's reversal-shape check, so a re-run is clean.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'homeowner_transactions'::regclass AND contype = 'c'
              AND conname <> 'homeowner_transactions_reversal_shape_check'
              AND pg_get_constraintdef(oid) ILIKE '%charge_category%'
              AND pg_get_constraintdef(oid) NOT ILIKE '%reverses_txn_id%' LOOP
    EXECUTE format('ALTER TABLE homeowner_transactions DROP CONSTRAINT IF EXISTS %I', c);
  END LOOP;
END $$;
ALTER TABLE homeowner_transactions ADD CONSTRAINT homeowner_transactions_charge_category_check
  CHECK (charge_category IS NULL OR charge_category IN (
    'assessment', 'late_fee', 'interest',
    'fine', 'attorney_fee', 'admin_fee',
    'payment', 'credit', 'refund',
    'adjustment', 'prior_balance', 'other',
    'certified_letter', 'attorney_fee_other', 'nsf_fee',
    'payment_reversal', 'chargeback'
  ));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'homeowner_transactions_reversal_shape_check') THEN
    ALTER TABLE homeowner_transactions ADD CONSTRAINT homeowner_transactions_reversal_shape_check CHECK (
      reverses_txn_id IS NULL OR (amount_cents > 0 AND charge_category IN ('payment_reversal', 'chargeback') AND reduction_source IS NULL));
  END IF;
END $$;

-- The 209.0063 step for a charge (same map as migration 461's closing payoff).
CREATE OR REPLACE FUNCTION payment_application_step(p_category text, p_charge_date date, p_payment_date date) RETURNS smallint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_category = 'assessment' AND p_charge_date <= p_payment_date THEN 1
              WHEN p_category = 'assessment' THEN 2
              WHEN p_category = 'attorney_fee' THEN 3
              WHEN p_category = 'attorney_fee_other' THEN 4
              WHEN p_category = 'fine' THEN 5
              WHEN p_category IN ('interest', 'late_fee', 'admin_fee', 'nsf_fee', 'certified_letter', 'other', 'adjustment') THEN 6
         END::smallint;
$$;

-- 461's closing payoff, unchanged except that reversal rows are never open charges.
CREATE OR REPLACE FUNCTION post_homeowner_tenure_payment(
  p_community_id  uuid,
  p_property_id   uuid,
  p_tenure_id     uuid,
  p_amount_cents  bigint,
  p_payment_date  date,
  p_check_number  text,
  p_payee         text,
  p_source        jsonb,
  p_approved_by   text,
  p_dry_run       boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t          ownership_tenures%ROWTYPE;
  prop       properties%ROWTYPE;
  existing   record;
  remaining  bigint := p_amount_cents;
  plan       jsonb := '[]'::jsonb;
  flagged    jsonb := '[]'::jsonb;
  before_cat jsonb; after_cat jsonb;
  total_open bigint := 0; allocatable bigint := 0; applied_total bigint := 0;
  r          record;
  a          bigint;
  batch_id   uuid; pay_id uuid; contact uuid; mc uuid;
  n          int := 0;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  IF p_payment_date IS NULL THEN RAISE EXCEPTION 'payment (check) date required'; END IF;
  IF coalesce(btrim(p_check_number), '') = '' THEN RAISE EXCEPTION 'check number required'; END IF;

  SELECT * INTO t FROM ownership_tenures WHERE id = p_tenure_id;
  IF NOT FOUND OR t.kind <> 'owner' THEN RAISE EXCEPTION 'owner tenure % not found', p_tenure_id; END IF;
  IF t.community_id <> p_community_id OR t.property_id IS DISTINCT FROM p_property_id THEN
    RAISE EXCEPTION 'tenure % does not belong to this property/community', p_tenure_id;
  END IF;
  SELECT * INTO prop FROM properties WHERE id = p_property_id;

  -- Already posted (idempotent): return what exists.
  SELECT h.id, h.source_batch_id, b.status INTO existing FROM homeowner_transactions h
    JOIN transaction_upload_batches b ON b.id = h.source_batch_id
   WHERE h.community_id = p_community_id AND h.raw_row_jsonb->>'source' = 'closing_payoff'
     AND h.raw_row_jsonb->>'check_number' = btrim(p_check_number) AND h.amount_cents = -p_amount_cents;
  IF FOUND THEN
    IF existing.status = 'reverted' THEN RAISE EXCEPTION 'check % was posted and later reverted; handle manually', p_check_number; END IF;
    RETURN jsonb_build_object('already_posted', true, 'payment_txn_id', existing.id, 'batch_id', existing.source_batch_id, 'batch_status', existing.status);
  END IF;

  -- Open charges on THIS tenure only, with their 209.0063 step.
  FOR r IN
    WITH ch AS (
      SELECT h.id, h.transaction_date, h.charge_category, h.description, h.amount_cents,
             h.amount_cents - coalesce((SELECT sum(ap.applied_cents) FROM homeowner_txn_applications ap
                                          JOIN homeowner_transactions p ON p.id = ap.payment_txn_id
                                          JOIN transaction_upload_batches pb ON pb.id = p.source_batch_id AND pb.status <> 'reverted'
                                         WHERE ap.charge_txn_id = h.id), 0) AS open_cents
        FROM homeowner_transactions h
        JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
       WHERE h.tenure_id = p_tenure_id AND h.amount_cents > 0 AND h.reverses_txn_id IS NULL   -- 469: reversal rows are never open charges
    )
    SELECT ch.*,
           CASE WHEN charge_category = 'assessment' AND transaction_date <= p_payment_date THEN 1
                WHEN charge_category = 'assessment' THEN 2
                WHEN charge_category = 'attorney_fee' THEN 3
                WHEN charge_category = 'attorney_fee_other' THEN 4
                WHEN charge_category = 'fine' THEN 5
                WHEN charge_category IN ('interest', 'late_fee', 'admin_fee', 'nsf_fee', 'certified_letter', 'other', 'adjustment') THEN 6
           END AS step
      FROM ch WHERE open_cents > 0
     ORDER BY step NULLS LAST, transaction_date, id
  LOOP
    total_open := total_open + r.open_cents;
    IF r.step IS NULL THEN
      flagged := flagged || jsonb_build_object('charge_txn_id', r.id, 'date', r.transaction_date, 'category', r.charge_category, 'open_cents', r.open_cents, 'reason', 'not auto-applied (category needs review)');
      CONTINUE;
    END IF;
    allocatable := allocatable + r.open_cents;
    a := least(remaining, r.open_cents);
    remaining := remaining - a;
    applied_total := applied_total + a;
    plan := plan || jsonb_build_object(
      'charge_txn_id', r.id, 'date', r.transaction_date, 'category', r.charge_category, 'description', r.description,
      'step', r.step, 'basis', CASE r.step WHEN 1 THEN 'delinquent_assessment' WHEN 2 THEN 'current_assessment' WHEN 3 THEN 'attorney_fee_assessment'
                                            WHEN 4 THEN 'attorney_fee_other' WHEN 5 THEN 'fine' ELSE 'other' END,
      'open_before_cents', r.open_cents, 'applied_cents', a, 'open_after_cents', r.open_cents - a);
  END LOOP;

  SELECT coalesce(jsonb_object_agg(cat, before), '{}'), coalesce(jsonb_object_agg(cat, after), '{}') INTO before_cat, after_cat FROM (
    SELECT coalesce(x->>'category', 'uncategorized') AS cat, sum((x->>'open_before_cents')::bigint) AS before, sum((x->>'open_after_cents')::bigint) AS after
      FROM jsonb_array_elements(plan) x GROUP BY 1) s;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'payment $% exceeds what can be applied on this tenure ($% auto-applicable of $% open); overpayment / unapplied credit is not handled here',
      round(p_amount_cents / 100.0, 2), round(allocatable / 100.0, 2), round(total_open / 100.0, 2);
  END IF;
  IF applied_total <> p_amount_cents THEN RAISE EXCEPTION 'plan does not tie: applied % vs payment %', applied_total, p_amount_cents; END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true, 'tenure_id', p_tenure_id, 'tenure_end_date', t.end_date,
      'amount_cents', p_amount_cents, 'applied_cents', applied_total, 'open_before_cents', total_open,
      'open_after_cents', total_open - applied_total, 'by_category_before', before_cat, 'by_category_after', after_cat,
      'applications', plan, 'flagged', flagged);
  END IF;

  -- Post: DRAFT batch (invisible to readers until the GL entry posts), payment row, applications.
  SELECT management_company_id INTO mc FROM communities WHERE id = p_community_id;
  SELECT contact_id INTO contact FROM property_ownerships WHERE tenure_id = p_tenure_id ORDER BY is_primary DESC, start_date, id LIMIT 1;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status,
      row_count, account_count, total_charges_cents, total_payments_cents, min_transaction_date, max_transaction_date, uploaded_by, notes)
  VALUES (mc, p_community_id, 'Closing payoff check ' || btrim(p_check_number), p_payment_date, 'manual', 'draft',
      1, 1, 0, p_amount_cents, p_payment_date, p_payment_date, 'home_sales:closing_payoff',
      'Seller payoff at closing, applied per Tex. Prop. Code 209.0063; approved by ' || coalesce(p_approved_by, '?'))
  RETURNING id INTO batch_id;
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
      property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents,
      reduction_source, raw_row_jsonb)
  VALUES (batch_id, 1, p_community_id, coalesce(t.vantaca_account_id, prop.vantaca_account_id), prop.trusted_account_number,
      p_property_id, contact, p_tenure_id, p_payment_date,
      'Closing payoff: check ' || btrim(p_check_number) || ' from ' || coalesce(p_payee, 'title company'),
      'payment', 'payment', -p_amount_cents, 'cash_payment',
      coalesce(p_source, '{}'::jsonb) || jsonb_build_object('source', 'closing_payoff', 'check_number', btrim(p_check_number), 'payee', p_payee))
  RETURNING id INTO pay_id;
  INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis,
      applied_as_of, method, run_id, approved_by)
  SELECT p_community_id, p_tenure_id, pay_id, (x->>'charge_txn_id')::uuid, (x->>'applied_cents')::bigint, (x->>'step')::smallint, x->>'basis',
         p_payment_date, 'auto_209_0063', batch_id, p_approved_by
    FROM jsonb_array_elements(plan) x WHERE (x->>'applied_cents')::bigint > 0;
  GET DIAGNOSTICS n = ROW_COUNT;

  RETURN jsonb_build_object('dry_run', false, 'batch_id', batch_id, 'payment_txn_id', pay_id, 'tenure_id', p_tenure_id,
    'amount_cents', p_amount_cents, 'applied_cents', applied_total, 'applications_written', n,
    'open_before_cents', total_open, 'open_after_cents', total_open - applied_total,
    'by_category_before', before_cat, 'by_category_after', after_cat, 'applications', plan, 'flagged', flagged);
END;
$$;
REVOKE ALL ON FUNCTION post_homeowner_tenure_payment(uuid, uuid, uuid, bigint, date, text, text, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION post_homeowner_tenure_payment(uuid, uuid, uuid, bigint, date, text, text, jsonb, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION post_stripe_tenure_payment(p_payment_id uuid, p_payment_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p payments%ROWTYPE; t ownership_tenures%ROWTYPE; mc uuid; existing record;
  remaining bigint; applied bigint := 0; a bigint; r record; batch_id uuid; txn_id uuid; n int := 0;
  plan jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR p.product_type <> 'assessment_payment' OR p.fee_type <> 'assessment' THEN RAISE EXCEPTION 'payment % is not an assessment line', p_payment_id; END IF;
  IF p.settlement_state IS DISTINCT FROM 'settled' THEN RAISE EXCEPTION 'payment % is not settled (%); nothing may be credited', p_payment_id, p.settlement_state; END IF;
  IF p.tenure_id IS NULL OR p.property_id IS NULL THEN RAISE EXCEPTION 'payment % has no captured tenure/property', p_payment_id; END IF;
  IF p_payment_date IS NULL THEN RAISE EXCEPTION 'payment date required'; END IF;

  SELECT h.id, h.source_batch_id, b.status INTO existing FROM homeowner_transactions h
    JOIN transaction_upload_batches b ON b.id = h.source_batch_id
   WHERE h.raw_row_jsonb->>'source' = 'stripe_payment' AND h.raw_row_jsonb->>'payment_id' = p_payment_id::text;
  IF FOUND THEN
    RETURN jsonb_build_object('already_posted', true, 'payment_txn_id', existing.id, 'batch_id', existing.source_batch_id, 'batch_status', existing.status);
  END IF;

  SELECT * INTO t FROM ownership_tenures WHERE id = p.tenure_id;
  IF NOT FOUND OR t.kind <> 'owner' OR t.property_id <> p.property_id OR t.community_id <> p.community_id THEN
    RAISE EXCEPTION 'captured tenure % does not match the payment''s property/community', p.tenure_id;
  END IF;

  remaining := abs(p.amount_cents);
  FOR r IN
    WITH ch AS (
      SELECT h.id, h.transaction_date, h.charge_category, h.amount_cents,
             h.amount_cents - coalesce((SELECT sum(ap.applied_cents) FROM homeowner_txn_applications ap
                                          JOIN homeowner_transactions pp ON pp.id = ap.payment_txn_id
                                          JOIN transaction_upload_batches pb ON pb.id = pp.source_batch_id AND pb.status <> 'reverted'
                                         WHERE ap.charge_txn_id = h.id), 0) AS open_cents
        FROM homeowner_transactions h
        JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
       WHERE h.tenure_id = p.tenure_id AND h.amount_cents > 0 AND h.reverses_txn_id IS NULL
    )
    SELECT ch.*, payment_application_step(ch.charge_category, ch.transaction_date, p_payment_date) AS step
      FROM ch WHERE open_cents > 0 AND payment_application_step(ch.charge_category, ch.transaction_date, p_payment_date) IS NOT NULL
     ORDER BY step, transaction_date, id
  LOOP
    EXIT WHEN remaining <= 0;
    a := least(remaining, r.open_cents);
    remaining := remaining - a; applied := applied + a;
    plan := plan || jsonb_build_object('charge_txn_id', r.id, 'applied_cents', a, 'step', r.step);
  END LOOP;

  SELECT management_company_id INTO mc FROM communities WHERE id = p.community_id;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status,
      row_count, account_count, total_charges_cents, total_payments_cents, min_transaction_date, max_transaction_date, uploaded_by, notes)
  VALUES (mc, p.community_id, 'Online payment ' || left(p.payment_group_id::text, 8), p_payment_date, 'manual', 'draft',
      1, 1, 0, abs(p.amount_cents), p_payment_date, p_payment_date, 'stripe_webhook',
      'Stripe payment, credited to the owner tenure captured at checkout. Committed only after its GL entry posts.')
  RETURNING id INTO batch_id;

  -- Account numbers come from the TENURE (and the lot's durable Trusted #), never the lot's Vantaca xref.
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
      property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents,
      reduction_source, raw_row_jsonb)
  VALUES (batch_id, 1, p.community_id, t.vantaca_account_id, p.trusted_account_number,
      p.property_id, p.contact_id, p.tenure_id, p_payment_date,
      'Online payment (' || CASE WHEN p.payment_method_type = 'card' THEN 'card' ELSE 'bank transfer' END || ')',
      'payment', 'payment', -abs(p.amount_cents), 'cash_payment',
      jsonb_build_object('source', 'stripe_payment', 'payment_id', p.id, 'payment_group_id', p.payment_group_id,
                         'checkout_session', p.processor_session_id, 'payment_intent', p.processor_payment_id, 'charge', p.stripe_charge_id))
  RETURNING id INTO txn_id;

  INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis,
      applied_as_of, method, run_id, approved_by)
  SELECT p.community_id, p.tenure_id, txn_id, (x->>'charge_txn_id')::uuid, (x->>'applied_cents')::bigint, (x->>'step')::smallint,
         CASE (x->>'step')::int WHEN 1 THEN 'delinquent_assessment' WHEN 2 THEN 'current_assessment' WHEN 3 THEN 'attorney_fee_assessment'
                                WHEN 4 THEN 'attorney_fee_other' WHEN 5 THEN 'fine' ELSE 'other' END,
         p_payment_date, 'auto_209_0063', batch_id, 'stripe_webhook'
    FROM jsonb_array_elements(plan) x;
  GET DIAGNOSTICS n = ROW_COUNT;

  RETURN jsonb_build_object('already_posted', false, 'payment_txn_id', txn_id, 'batch_id', batch_id, 'batch_status', 'draft',
    'applied_cents', applied, 'unapplied_cents', remaining, 'applications_written', n, 'tenure_id', p.tenure_id);
END $$;

CREATE OR REPLACE FUNCTION payment_commit_posting(p_payment_id uuid, p_journal_entry_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p payments%ROWTYPE; txn record;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF p.posting_state IN ('posted', 'reversed') THEN RETURN jsonb_build_object('already_committed', true); END IF;
  IF p.settlement_state IS DISTINCT FROM 'settled' THEN RAISE EXCEPTION 'payment % is not settled', p_payment_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_journal_entry_id AND community_id = p.community_id AND status = 'posted') THEN
    RAISE EXCEPTION 'journal entry % is not a posted entry for this community', p_journal_entry_id;
  END IF;
  SELECT h.id, h.source_batch_id INTO txn FROM homeowner_transactions h
   WHERE h.raw_row_jsonb->>'source' = 'stripe_payment' AND h.raw_row_jsonb->>'payment_id' = p_payment_id::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'no ledger row for payment %', p_payment_id; END IF;
  UPDATE transaction_upload_batches SET status = 'committed' WHERE id = txn.source_batch_id AND status = 'draft';
  UPDATE payments SET posting_state = 'posted', posted_at = now(), posting_note = NULL,
         homeowner_txn_id = txn.id, journal_entry_id = p_journal_entry_id, updated_at = now()
   WHERE id = p_payment_id;
  RETURN jsonb_build_object('already_committed', false, 'homeowner_txn_id', txn.id, 'batch_id', txn.source_batch_id);
END $$;

-- Draft the reversal row (a separate, dated transaction linked to the original).
-- Invisible until payment_commit_reversal, which runs after the GL reversal posts.
CREATE OR REPLACE FUNCTION reverse_stripe_tenure_payment(p_payment_id uuid, p_kind text, p_reason text, p_reversal_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p payments%ROWTYPE; orig homeowner_transactions%ROWTYPE; existing record; mc uuid; batch_id uuid; rev_id uuid;
BEGIN
  IF p_kind NOT IN ('refund', 'chargeback') THEN RAISE EXCEPTION 'reversal kind must be refund or chargeback'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reversal needs a reason'; END IF;
  IF p_reversal_date IS NULL THEN RAISE EXCEPTION 'reversal date required'; END IF;
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF p.posting_state = 'reversed' THEN
    RETURN jsonb_build_object('already_reversed', true, 'reversal_txn_id', p.reversal_txn_id, 'reversal_journal_entry_id', p.reversal_journal_entry_id);
  END IF;
  IF p.posting_state <> 'posted' OR p.homeowner_txn_id IS NULL THEN
    UPDATE payments SET needs_review = true,
           review_reason = 'Reversal requested (' || p_reason || ') but the payment was ' || coalesce(p.posting_state, 'never posted'), updated_at = now()
     WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'review');
  END IF;
  SELECT * INTO orig FROM homeowner_transactions WHERE id = p.homeowner_txn_id;
  SELECT h.id, h.source_batch_id, b.status INTO existing FROM homeowner_transactions h
    JOIN transaction_upload_batches b ON b.id = h.source_batch_id WHERE h.reverses_txn_id = orig.id;
  IF FOUND THEN
    RETURN jsonb_build_object('already_drafted', true, 'reversal_txn_id', existing.id, 'batch_id', existing.source_batch_id, 'batch_status', existing.status);
  END IF;
  SELECT management_company_id INTO mc FROM communities WHERE id = p.community_id;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status,
      row_count, account_count, total_charges_cents, total_payments_cents, min_transaction_date, max_transaction_date, uploaded_by, notes)
  VALUES (mc, p.community_id, 'Payment reversal ' || left(p.payment_group_id::text, 8), p_reversal_date, 'manual', 'draft',
      1, 1, abs(orig.amount_cents), 0, p_reversal_date, p_reversal_date, 'stripe_webhook',
      'Reversal of an online payment (' || p_kind || '); the original payment stays on the ledger. Committed after the GL reversal posts.')
  RETURNING id INTO batch_id;
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
      property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents,
      reduction_source, reverses_txn_id, raw_row_jsonb)
  VALUES (batch_id, 1, orig.community_id, orig.vantaca_account_id, orig.trusted_account_number,
      orig.property_id, orig.contact_id, orig.tenure_id, p_reversal_date,
      CASE p_kind WHEN 'refund' THEN 'Payment refunded' ELSE 'Payment reversed: chargeback' END || ' (' || to_char(orig.transaction_date, 'Mon FMDD, YYYY') || ' online payment)',
      'adjustment', CASE p_kind WHEN 'refund' THEN 'payment_reversal' ELSE 'chargeback' END, abs(orig.amount_cents),
      NULL, orig.id,
      jsonb_build_object('source', 'stripe_reversal', 'payment_id', p.id, 'kind', p_kind, 'reason', p_reason))
  RETURNING id INTO rev_id;
  RETURN jsonb_build_object('already_drafted', false, 'reversal_txn_id', rev_id, 'batch_id', batch_id, 'batch_status', 'draft');
END $$;

-- The GL reversal posted: make the reversal visible and reopen the charges the
-- payment had paid (exact-negative applications, as 461's guard requires).
CREATE OR REPLACE FUNCTION payment_commit_reversal(p_payment_id uuid, p_journal_entry_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p payments%ROWTYPE; rev homeowner_transactions%ROWTYPE; n int := 0; reopened bigint;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF p.posting_state = 'reversed' THEN RETURN jsonb_build_object('already_committed', true); END IF;
  IF p.posting_state <> 'posted' THEN RAISE EXCEPTION 'payment % is not posted (%)', p_payment_id, p.posting_state; END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_journal_entry_id AND community_id = p.community_id AND status = 'posted') THEN
    RAISE EXCEPTION 'journal entry % is not a posted entry for this community', p_journal_entry_id;
  END IF;
  SELECT * INTO rev FROM homeowner_transactions WHERE reverses_txn_id = p.homeowner_txn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no drafted reversal for payment %', p_payment_id; END IF;
  UPDATE transaction_upload_batches SET status = 'committed' WHERE id = rev.source_batch_id AND status = 'draft';
  SELECT coalesce(sum(a.applied_cents), 0) INTO reopened FROM homeowner_txn_applications a
   WHERE a.payment_txn_id = p.homeowner_txn_id AND a.reverses_application_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM homeowner_txn_applications x WHERE x.reverses_application_id = a.id);
  INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis,
      applied_as_of, method, run_id, reverses_application_id, approved_by, notes)
  SELECT a.community_id, a.tenure_id, a.payment_txn_id, a.charge_txn_id, -a.applied_cents, a.priority_step, a.priority_basis,
         a.applied_as_of, a.method, rev.source_batch_id, a.id, 'stripe_webhook',
         'Payment reversed (' || (rev.raw_row_jsonb->>'kind') || '): ' || coalesce(rev.raw_row_jsonb->>'reason', '')
    FROM homeowner_txn_applications a
   WHERE a.payment_txn_id = p.homeowner_txn_id AND a.reverses_application_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM homeowner_txn_applications x WHERE x.reverses_application_id = a.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE payments SET posting_state = 'reversed', reversal_txn_id = rev.id, reversal_journal_entry_id = p_journal_entry_id,
         posting_note = rev.raw_row_jsonb->>'reason', updated_at = now()
   WHERE id = p_payment_id;
  RETURN jsonb_build_object('already_committed', false, 'reversal_txn_id', rev.id, 'applications_reversed', n, 'reopened_cents', reopened);
END $$;

-- ---------------------------------------------------------------------------
-- 6) Payment sandbox: one lot, demo community only
-- ---------------------------------------------------------------------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS payment_sandbox boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN properties.payment_sandbox IS 'The single lot allowed to run Stripe TEST payments while its community is a demo. Never allowed outside a demo community; live mode stays blocked in code.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_one_payment_sandbox ON properties (payment_sandbox) WHERE payment_sandbox;

CREATE OR REPLACE FUNCTION properties_payment_sandbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.payment_sandbox AND NOT EXISTS (SELECT 1 FROM communities WHERE id = NEW.community_id AND is_demo) THEN
    RAISE EXCEPTION 'only a lot in a demo community can be the payment sandbox (property %)', NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_properties_payment_sandbox_guard ON properties;
CREATE TRIGGER trg_properties_payment_sandbox_guard BEFORE INSERT OR UPDATE OF payment_sandbox, community_id ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_payment_sandbox_guard();

-- ---------------------------------------------------------------------------
-- 7) Autopay containment
-- ---------------------------------------------------------------------------
ALTER TABLE assessment_autopay ADD COLUMN IF NOT EXISTS tenure_id uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT;
COMMENT ON COLUMN assessment_autopay.tenure_id IS 'The owner tenure that authorized this autopay. Ending that tenure (a sale) cancels the enrollment.';

CREATE OR REPLACE FUNCTION autopay_cancel_on_tenure_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE assessment_autopay
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'ownership_transfer',
         status_reason = 'Cancelled automatically: ownership of this property changed.'
   WHERE property_id = NEW.property_id AND status IN ('pending_setup', 'active', 'paused')
     AND (tenure_id IS NULL OR tenure_id = NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_autopay_cancel_on_tenure_end ON ownership_tenures;
CREATE TRIGGER trg_autopay_cancel_on_tenure_end AFTER UPDATE OF end_date ON ownership_tenures
  FOR EACH ROW WHEN (OLD.end_date IS NULL AND NEW.end_date IS NOT NULL AND NEW.kind = 'owner')
  EXECUTE FUNCTION autopay_cancel_on_tenure_end();

-- ---------------------------------------------------------------------------
-- 8) Access
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'stripe_event_claim(text,text,boolean,text,text,jsonb)', 'stripe_event_finish(text,text,text,jsonb)',
    'payment_group_anchor(uuid,text)', 'payment_settle(uuid,text,text,text)', 'payment_mark_processing(uuid,text,text)',
    'payment_mark_failed(uuid,text,text,text,text)', 'payment_flag_review(uuid,text)', 'payment_mark_posting(uuid,text,text)',
    'post_stripe_tenure_payment(uuid,date)', 'payment_commit_posting(uuid,uuid)',
    'reverse_stripe_tenure_payment(uuid,text,text,date)', 'payment_commit_reversal(uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9) Self-test + guards: nothing existing moved
-- ---------------------------------------------------------------------------
DO $$
DECLARE r text; ok boolean; foreign_acct uuid; any_comm uuid;
BEGIN
  BEGIN
    r := stripe_event_claim('evt_selftest_469', 'test.event', false, NULL, NULL, '{}'::jsonb);
    IF r <> 'process' THEN RAISE EXCEPTION 'SELFTEST FAIL: first claim returned %', r; END IF;
    r := stripe_event_claim('evt_selftest_469', 'test.event', false, NULL, NULL, '{}'::jsonb);
    IF r <> 'busy' THEN RAISE EXCEPTION 'SELFTEST FAIL: concurrent claim returned %', r; END IF;
    PERFORM stripe_event_finish('evt_selftest_469', 'failed', 'boom', NULL);
    r := stripe_event_claim('evt_selftest_469', 'test.event', false, NULL, NULL, '{}'::jsonb);
    IF r <> 'process' THEN RAISE EXCEPTION 'SELFTEST FAIL: retry after failure returned %', r; END IF;
    PERFORM stripe_event_finish('evt_selftest_469', 'processed', NULL, NULL);
    r := stripe_event_claim('evt_selftest_469', 'test.event', false, NULL, NULL, '{}'::jsonb);
    IF r <> 'done' THEN RAISE EXCEPTION 'SELFTEST FAIL: redelivery after success returned %', r; END IF;
    -- A role must point at an account in the SAME community.
    SELECT a.id, c.id INTO foreign_acct, any_comm FROM chart_of_accounts a JOIN communities c ON c.id <> a.community_id
     WHERE a.account_type = 'asset' AND a.normal_balance = 'debit' AND a.is_active AND NOT a.is_summary LIMIT 1;
    IF foreign_acct IS NOT NULL THEN
      ok := false;
      BEGIN
        INSERT INTO community_account_roles (community_id, role, account_id, updated_by) VALUES (any_comm, 'stripe_clearing', foreign_acct, 'selftest')
        ON CONFLICT (community_id, role) DO UPDATE SET account_id = EXCLUDED.account_id;
      EXCEPTION WHEN raise_exception THEN ok := true; END;
      IF NOT ok THEN RAISE EXCEPTION 'SELFTEST FAIL: a role accepted another community''s account'; END IF;
    END IF;
    RAISE EXCEPTION 'm469_selftest_ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'm469_selftest_ok' THEN RAISE; END IF;
  END;
END $$;

DO $guard$
DECLARE b record; n int;
BEGIN
  SELECT * INTO b FROM _m469_before;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: GL changed';
  END IF;
  IF b.cur_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) THEN
    RAISE EXCEPTION 'guard: homeowner balances changed';
  END IF;
  IF b.ht_h <> (SELECT md5(coalesce(string_agg(id::text || amount_cents::text || coalesce(tenure_id::text, ''), ',' ORDER BY id), '')) FROM homeowner_transactions) THEN
    RAISE EXCEPTION 'guard: homeowner ledger rows changed';
  END IF;
  IF b.pay_n <> (SELECT count(*) FROM payments) THEN RAISE EXCEPTION 'guard: payments row count changed'; END IF;
  SELECT count(*) INTO n FROM properties p JOIN communities c ON c.id = p.community_id WHERE p.payment_sandbox AND NOT c.is_demo;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: a non-demo lot is flagged payment_sandbox'; END IF;
  SELECT count(*) INTO n FROM community_account_roles r JOIN chart_of_accounts a ON a.id = r.account_id WHERE a.community_id <> r.community_id;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: an account role crosses communities'; END IF;
END
$guard$;

COMMIT;
