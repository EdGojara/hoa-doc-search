-- ============================================================================
-- 469_payments_safe_foundation.sql  (Ed 2026-09-27)
-- ----------------------------------------------------------------------------
-- Record ownership: payments / homeowner_transactions / applications are
-- association_record (the HOA's receivable ledger); stripe_events is workpaper
-- (processor plumbing).
--
-- WHY: the Stripe path could credit a homeowner before an ACH payment settled,
-- could credit the wrong owner after a sale (it inferred the owner from
-- properties.vantaca_account_id at webhook time), swallowed posting failures
-- with a 200 so Stripe never retried, and relied on one overwritten metadata
-- field for idempotency. Nothing has ever completed through it (10 test rows,
-- all pending), so this replaces the lifecycle before the first real payment.
--
-- Adds:
--   * payments: payment_group_id, property_id, tenure_id, contact_id,
--     trusted_account_number, portal_user_id, payment_method_type, livemode,
--     settlement_state (awaiting_payment -> processing -> settled | failed |
--     expired), posting_state (not_posted -> posted | not_applicable | blocked |
--     reversed | review), links to the ledger row and journal entries.
--   * stripe_events: one row per Stripe event id; claim/finish functions make
--     webhook processing single-writer and retry-safe.
--   * payment_settle / payment_mark_processing / payment_mark_failed: the only
--     state transitions, each atomic (row lock + compare-and-set).
--   * post_stripe_tenure_payment: tenure-stamped AR posting modeled on 461
--     (draft batch until the GL entry posts; applications in 209.0063 order),
--     but unapplied remainder is allowed and it never reads the lot's Vantaca #.
--   * payment_commit_posting / payment_mark_posting / reverse_stripe_tenure_payment.
--   * GL account 1090 "Stripe Clearing" beside every community's 1000:
--       payment  Dr 1090 / Cr 1300      payout (later)  Dr 1000 / Cr 1090
--   * unique keys so a payment, its ledger row and its journal entry can each
--     exist only once.
--   * autopay: tenure_id on enrollments; an ownership transfer cancels the
--     seller's enrollment automatically.
-- No existing payment, ledger or journal row is changed.
-- ============================================================================
BEGIN;

-- Guards: capture balances + GL before anything runs.
CREATE TEMP TABLE _m469_before ON COMMIT DROP AS SELECT
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) AS cur_h,
  (SELECT count(*) FROM payments) AS pay_n;

-- ---------------------------------------------------------------------------
-- 1) payments: identity, settlement and posting state
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
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS needs_review              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason             text;

COMMENT ON COLUMN payments.payment_group_id IS 'One checkout = one group (all fee lines). Generated before the Stripe session and sent as metadata, so a webhook can always find its rows.';
COMMENT ON COLUMN payments.tenure_id IS 'The ownership tenure captured at checkout. The payment credits THIS owner even if the lot sells before it settles. Never inferred from an account number.';
COMMENT ON COLUMN payments.trusted_account_number IS 'The lot''s durable Trusted account number at checkout.';
COMMENT ON COLUMN payments.needs_review IS 'A person must look (partial refund, dispute, paid-after-failure, failure-after-settlement). posting_state keeps stating what the books show.';
CREATE INDEX IF NOT EXISTS idx_payments_needs_review ON payments (community_id) WHERE needs_review;
COMMENT ON COLUMN payments.settlement_state IS 'Only ''settled'' may credit a homeowner. ACH stays ''processing'' until Stripe confirms the funds.';

-- New-model assessment rows must carry full identity (legacy rows have no group id).
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

-- ---------------------------------------------------------------------------
-- 2) stripe_events: every delivery recorded, processed at most once
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

-- 'process' = caller owns this attempt; 'done' = already handled; 'busy' = another attempt is running.
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
-- 3) Settlement state transitions (row-locked compare-and-set)
-- ---------------------------------------------------------------------------
-- Finds the checkout's assessment row by group id, falling back to session id.
CREATE OR REPLACE FUNCTION payment_group_anchor(p_group uuid, p_session text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT id FROM payments
   WHERE product_type = 'assessment_payment' AND fee_type = 'assessment'
     AND ((p_group IS NOT NULL AND payment_group_id = p_group)
          OR (p_group IS NULL AND p_session IS NOT NULL AND processor_session_id = p_session))
   ORDER BY created_at DESC LIMIT 1;
$$;

-- Stripe confirmed the money. Returns {action: post | done | legacy | unknown | review}.
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

-- ACH submitted, funds not yet confirmed. Never credits anyone.
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

-- Payment failed or checkout expired. A settled payment is never un-settled here.
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

-- ---------------------------------------------------------------------------
-- 4) Tenure-stamped AR posting (draft until the GL entry posts)
-- ---------------------------------------------------------------------------
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_stripe_payment
  ON homeowner_transactions ((raw_row_jsonb->>'payment_id')) WHERE raw_row_jsonb->>'source' = 'stripe_payment';

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
       WHERE h.tenure_id = p.tenure_id AND h.amount_cents > 0
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

-- The GL entry posted: make the credit visible (commit the batch) and record the links.
CREATE OR REPLACE FUNCTION payment_commit_posting(p_payment_id uuid, p_journal_entry_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p payments%ROWTYPE; txn record;
BEGIN
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF p.posting_state = 'posted' THEN RETURN jsonb_build_object('already_committed', true); END IF;
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

-- Record a posting outcome that is not a credit (not live GL, blocked, needs review).
CREATE OR REPLACE FUNCTION payment_mark_posting(p_payment_id uuid, p_state text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_state NOT IN ('not_applicable', 'blocked', 'review') THEN RAISE EXCEPTION 'bad posting state %', p_state; END IF;
  UPDATE payments SET posting_state = p_state, posting_note = p_note, updated_at = now()
   WHERE id = p_payment_id AND posting_state IN ('not_posted', 'blocked');
END $$;

-- Full reversal (refund / dispute): the credit disappears by reverting the payment's
-- own batch (its applications stop counting automatically); the GL reversal
-- (Dr 1300 / Cr 1090) is posted by the caller and linked with payment_link_reversal.
CREATE OR REPLACE FUNCTION reverse_stripe_tenure_payment(p_payment_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p payments%ROWTYPE; txn record;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reversal needs a reason'; END IF;
  SELECT * INTO p FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF p.posting_state = 'reversed' THEN RETURN jsonb_build_object('already_reversed', true, 'journal_entry_id', p.journal_entry_id, 'reversal_journal_entry_id', p.reversal_journal_entry_id); END IF;
  IF p.posting_state <> 'posted' THEN
    UPDATE payments SET needs_review = true,
           review_reason = 'Reversal requested (' || p_reason || ') but the payment was ' || coalesce(p.posting_state, 'never posted'), updated_at = now()
     WHERE id = p_payment_id;
    RETURN jsonb_build_object('action', 'review');
  END IF;
  SELECT h.id, h.source_batch_id INTO txn FROM homeowner_transactions h WHERE h.id = p.homeowner_txn_id;
  UPDATE transaction_upload_batches SET status = 'reverted', notes = coalesce(notes, '') || ' | Reversed: ' || p_reason
   WHERE id = txn.source_batch_id AND status = 'committed';
  UPDATE payments SET posting_state = 'reversed', posting_note = p_reason, updated_at = now() WHERE id = p_payment_id;
  RETURN jsonb_build_object('already_reversed', false, 'homeowner_txn_id', txn.id, 'batch_id', txn.source_batch_id, 'journal_entry_id', p.journal_entry_id);
END $$;

CREATE OR REPLACE FUNCTION payment_link_reversal(p_payment_id uuid, p_journal_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payments SET reversal_journal_entry_id = p_journal_entry_id, updated_at = now()
   WHERE id = p_payment_id AND posting_state = 'reversed' AND reversal_journal_entry_id IS NULL;
END $$;

-- Flag for a person without changing what the books show.
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

-- ---------------------------------------------------------------------------
-- 5) GL: Stripe Clearing beside every Operating Cash account; one entry per key
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts (community_id, fund_id, account_number, account_name, account_type, account_subtype,
                               normal_balance, is_summary, is_active, description)
SELECT c.community_id, c.fund_id, '1090', 'Stripe Clearing', 'asset', c.account_subtype, 'debit', false, true,
       'Homeowner payments received through Stripe and not yet paid out to the operating bank account. Payment: Dr 1090 / Cr 1300. Payout: Dr 1000 / Cr 1090.'
  FROM chart_of_accounts c
 WHERE c.account_number = '1000'
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.community_id = c.community_id AND x.account_number = '1090');

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_stripe_ref ON journal_entries (community_id, source_reference)
  WHERE source_reference LIKE 'stripe:%';

-- ---------------------------------------------------------------------------
-- 6) Autopay containment
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
-- 7) Access
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'stripe_event_claim(text,text,boolean,text,text,jsonb)', 'stripe_event_finish(text,text,text,jsonb)',
    'payment_group_anchor(uuid,text)', 'payment_settle(uuid,text,text,text)', 'payment_mark_processing(uuid,text,text)',
    'payment_mark_failed(uuid,text,text,text,text)', 'post_stripe_tenure_payment(uuid,date)',
    'payment_commit_posting(uuid,uuid)', 'payment_mark_posting(uuid,text,text)',
    'reverse_stripe_tenure_payment(uuid,text)', 'payment_link_reversal(uuid,uuid)', 'payment_flag_review(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 8) Self-test (event claim semantics) + guards: nothing existing moved
-- ---------------------------------------------------------------------------
DO $$
DECLARE r text; ok boolean;
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
    IF (SELECT attempts FROM stripe_events WHERE event_id = 'evt_selftest_469') <> 2 THEN RAISE EXCEPTION 'SELFTEST FAIL: attempts not counted'; END IF;
    RAISE EXCEPTION 'm469_selftest_ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'm469_selftest_ok' THEN RAISE; END IF;
  END;
END $$;

DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m469_before;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: GL changed';
  END IF;
  IF b.cur_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) THEN
    RAISE EXCEPTION 'guard: homeowner balances changed';
  END IF;
  IF b.pay_n <> (SELECT count(*) FROM payments) THEN RAISE EXCEPTION 'guard: payments row count changed'; END IF;
END
$guard$;

COMMIT;
