-- ============================================================================
-- 470_payment_terms_acceptances.sql  (Ed 2026-09-27)  PROPOSED
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. It is the payer's authorization for a
-- payment on the Association's receivable (the same class of evidence as the
-- autopay mandate), and it is handed over with the Association's records.
--
-- WHY: Trusted Pay requires the payer to review the exact Assessment/Payment
-- Amount, Payment Processing Fee and Total Payment and accept the Trusted Pay
-- Payment Terms and Conditions before checkout. That acceptance must be kept as
-- an immutable, auditable record tied to the exact checkout. payments rows are
-- updated by webhooks and cannot serve as an immutable record, so this adds one
-- small append-only table.
--
-- Adds:
--   * payment_terms_acceptances: one row per checkout (unique payment_group_id):
--     who (actor type/label, portal user), what (property, owner tenure,
--     method, amount, fee, total), which terms (version + sha256 of the
--     rendered terms), when (quote issued, accepted). No IP or user agent.
--   * Insert guard: the checkout's payments rows must already exist and match
--     the recorded property, tenure, method, amount and fee exactly (so an
--     acceptance can never be attached to a different amount).
--   * Immutability: no UPDATE or DELETE, ever.
-- Creates no data; changes no existing row. Written by
-- lib/payments/assessment_checkout.js, service role only.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE _m470_before ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM payments) AS pay_n,
  (SELECT count(*) FROM homeowner_transactions) AS ht_n,
  (SELECT count(*) FROM journal_entries) AS je_n;

CREATE TABLE IF NOT EXISTS payment_terms_acceptances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_group_id  uuid NOT NULL UNIQUE,
  community_id      uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id         uuid NOT NULL REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  portal_user_id    uuid REFERENCES portal_users(id) ON DELETE RESTRICT,
  actor_type        text NOT NULL CHECK (actor_type IN ('homeowner', 'payment_link', 'staff_test')),
  actor_label       text,
  source            text NOT NULL CHECK (source IN ('portal', 'pay_link', 'staff_test')),
  payment_method    text NOT NULL CHECK (payment_method IN ('card', 'us_bank_account')),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents         bigint NOT NULL CHECK (fee_cents >= 0),
  total_cents       bigint NOT NULL,
  terms_version     text NOT NULL CHECK (btrim(terms_version) <> ''),
  terms_sha256      text NOT NULL CHECK (terms_sha256 ~ '^[0-9a-f]{64}$'),
  quote_issued_at   timestamptz NOT NULL,
  accepted_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_terms_acceptances_total_check CHECK (total_cents = amount_cents + fee_cents),
  CONSTRAINT payment_terms_acceptances_portal_actor_check CHECK (actor_type <> 'homeowner' OR portal_user_id IS NOT NULL)
);
COMMENT ON TABLE payment_terms_acceptances IS 'association_record: the payer''s acceptance of the Trusted Pay Payment Terms and Conditions and the exact amounts shown, one row per checkout (payment_group_id). Append-only.';
CREATE INDEX IF NOT EXISTS idx_payment_terms_acceptances_property ON payment_terms_acceptances (property_id);
CREATE INDEX IF NOT EXISTS idx_payment_terms_acceptances_tenure ON payment_terms_acceptances (tenure_id);

-- The acceptance must describe the checkout's actual payments rows exactly.
CREATE OR REPLACE FUNCTION payment_terms_acceptances_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a payments%ROWTYPE; f bigint; n int;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment terms acceptances are permanent (acceptance %)', OLD.id;
  END IF;
  SELECT * INTO a FROM payments WHERE payment_group_id = NEW.payment_group_id AND fee_type = 'assessment';
  IF NOT FOUND THEN RAISE EXCEPTION 'no checkout payment rows for group %', NEW.payment_group_id; END IF;
  IF a.property_id IS DISTINCT FROM NEW.property_id OR a.tenure_id IS DISTINCT FROM NEW.tenure_id
     OR a.community_id IS DISTINCT FROM NEW.community_id OR a.payment_method_type IS DISTINCT FROM NEW.payment_method
     OR a.amount_cents <> NEW.amount_cents THEN
    RAISE EXCEPTION 'acceptance does not match the checkout (group %)', NEW.payment_group_id;
  END IF;
  SELECT coalesce(sum(amount_cents), 0), count(*) INTO f, n FROM payments
   WHERE payment_group_id = NEW.payment_group_id AND fee_type <> 'assessment';
  IF f <> NEW.fee_cents THEN
    RAISE EXCEPTION 'acceptance fee % does not match the checkout fee % (group %)', NEW.fee_cents, f, NEW.payment_group_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payment_terms_acceptances_guard ON payment_terms_acceptances;
CREATE TRIGGER trg_payment_terms_acceptances_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION payment_terms_acceptances_guard();

ALTER TABLE payment_terms_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_terms_acceptances FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON payment_terms_acceptances TO service_role;

DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m470_before;
  IF b.pay_n <> (SELECT count(*) FROM payments) OR b.ht_n <> (SELECT count(*) FROM homeowner_transactions)
     OR b.je_n <> (SELECT count(*) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: 470 must not change payments, ledger or journal rows';
  END IF;
END
$guard$;

COMMIT;
