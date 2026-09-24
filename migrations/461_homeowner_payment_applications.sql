-- ============================================================================
-- 461_homeowner_payment_applications.sql
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (the HOA's receivable ledger + how each
-- payment was applied). Minimal slice of the approved payment-application design
-- (memory: project_homeowner_interest_payment_applications), built only for the
-- Home Sales closing payoff (first case: LOPF 4707 Lakes of Pine Forest Ct).
-- NOT included (deferred): interest_eligible_date, corrects_txn_id, the prepaid
-- credit stamp, the open-principal reader, any monthly run.
--
-- WHY: the only writers of homeowner payments today either stamp no owner tenure
-- (Stripe path: a seller payoff recorded after a sale would land on the BUYER by
-- account) or write the native ar_charges ledger LOPF does not use. A closing
-- payoff must post to the explicit SELLER tenure and record exactly which seller
-- charges it paid, in Tex. Prop. Code 209.0063 order.
--
-- Adds:
--   * homeowner_transactions.reduction_source (provenance of a reduction);
--   * a unique key so the same closing check can never post twice;
--   * homeowner_txn_applications: one row per slice of a payment applied to one
--     charge; append-only (reversal = new negative row); never crosses tenures;
--   * post_homeowner_tenure_payment(): plans (dry run) or posts a payment to an
--     explicit tenure and applies it by the approved 209.0063 map. The payment's
--     batch stays DRAFT (invisible to every reader) until the caller posts the GL
--     entry and commits it.
-- No existing row is changed.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m461_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) AS cur_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || coalesce(tenure_id::text, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(vantaca_account_id, '') || '|' || balance_cents::text, ',' ORDER BY community_id, tenure_id, property_id, vantaca_account_id), '')) FROM v_former_owner_ledger_balances) AS former_h,
  (SELECT md5(coalesce(string_agg(id::text || amount_cents::text || transaction_date::text || coalesce(tenure_id::text, '') || coalesce(charge_category, ''), ',' ORDER BY id), '')) FROM homeowner_transactions) AS ht_h;

-- 1) Provenance of a reduction (payment / credit / waiver / correction).
ALTER TABLE homeowner_transactions ADD COLUMN IF NOT EXISTS reduction_source text;
ALTER TABLE homeowner_transactions DROP CONSTRAINT IF EXISTS homeowner_transactions_reduction_source_check;
ALTER TABLE homeowner_transactions ADD CONSTRAINT homeowner_transactions_reduction_source_check
  CHECK (reduction_source IS NULL OR (reduction_source IN ('cash_payment', 'prepaid_credit', 'credit_waiver', 'correcting_adjustment') AND amount_cents < 0));

-- 2) A closing check posts once: community + check number + amount.
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_closing_payoff
  ON homeowner_transactions (community_id, (raw_row_jsonb->>'check_number'), amount_cents)
  WHERE raw_row_jsonb->>'source' = 'closing_payoff';

-- 3) Applications.
CREATE TABLE IF NOT EXISTS homeowner_txn_applications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  tenure_id                uuid NOT NULL REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  payment_txn_id           uuid NOT NULL REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  charge_txn_id            uuid NOT NULL REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  applied_cents            bigint NOT NULL CHECK (applied_cents <> 0),
  priority_step            smallint CHECK (priority_step BETWEEN 1 AND 6),
  priority_basis           text NOT NULL CHECK (priority_basis IN ('delinquent_assessment', 'current_assessment', 'attorney_fee_assessment', 'attorney_fee_other', 'fine', 'other', 'manual')),
  applied_as_of            date NOT NULL,
  method                   text NOT NULL CHECK (method IN ('auto_209_0063', 'targeted_correction', 'manual_exception')),
  run_id                   uuid,
  reverses_application_id  uuid REFERENCES homeowner_txn_applications(id) ON DELETE RESTRICT,
  approved_by              text,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE homeowner_txn_applications IS 'association_record: how each homeowner payment/credit was applied to specific charges (Tex. Prop. Code 209.0063). Append-only; corrections are negative reversal rows. Never crosses tenures.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_app_reversal ON homeowner_txn_applications (reverses_application_id) WHERE reverses_application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_homeowner_txn_app_payment ON homeowner_txn_applications (payment_txn_id);
CREATE INDEX IF NOT EXISTS idx_homeowner_txn_app_charge  ON homeowner_txn_applications (charge_txn_id);
CREATE INDEX IF NOT EXISTS idx_homeowner_txn_app_tenure  ON homeowner_txn_applications (tenure_id);
GRANT SELECT, INSERT ON homeowner_txn_applications TO service_role;
GRANT SELECT ON homeowner_txn_applications TO authenticated;

-- "Live" application = its payment row's batch is not reverted.
CREATE OR REPLACE FUNCTION homeowner_txn_applications_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE pay homeowner_transactions%ROWTYPE; chg homeowner_transactions%ROWTYPE; orig homeowner_txn_applications%ROWTYPE;
        chg_batch text; net_charge bigint; net_payment bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment applications are permanent; correct with a reversal (application %)', OLD.id;
  END IF;
  SELECT * INTO pay FROM homeowner_transactions WHERE id = NEW.payment_txn_id FOR UPDATE;
  SELECT * INTO chg FROM homeowner_transactions WHERE id = NEW.charge_txn_id FOR UPDATE;
  IF pay.id IS NULL OR chg.id IS NULL THEN RAISE EXCEPTION 'payment or charge row not found'; END IF;
  IF pay.tenure_id IS DISTINCT FROM NEW.tenure_id OR chg.tenure_id IS DISTINCT FROM NEW.tenure_id THEN
    RAISE EXCEPTION 'a payment is applied only within one owner tenure (payment %, charge %, tenure %)', pay.tenure_id, chg.tenure_id, NEW.tenure_id;
  END IF;
  IF pay.community_id <> NEW.community_id OR chg.community_id <> NEW.community_id THEN RAISE EXCEPTION 'community mismatch'; END IF;
  IF pay.amount_cents >= 0 OR pay.reduction_source IS NULL THEN RAISE EXCEPTION 'the paying row must be a negative row with a reduction_source'; END IF;
  IF chg.amount_cents <= 0 THEN RAISE EXCEPTION 'the charge row must be a positive amount'; END IF;
  SELECT status INTO chg_batch FROM transaction_upload_batches WHERE id = chg.source_batch_id;
  IF chg_batch <> 'committed' THEN RAISE EXCEPTION 'charge % is not in a committed batch', chg.id; END IF;

  IF NEW.reverses_application_id IS NOT NULL THEN
    SELECT * INTO orig FROM homeowner_txn_applications WHERE id = NEW.reverses_application_id;
    IF orig.id IS NULL OR orig.reverses_application_id IS NOT NULL THEN RAISE EXCEPTION 'a reversal must reverse an original application'; END IF;
    IF NEW.applied_cents <> -orig.applied_cents OR NEW.payment_txn_id <> orig.payment_txn_id OR NEW.charge_txn_id <> orig.charge_txn_id THEN
      RAISE EXCEPTION 'a reversal must be exactly the negative of the original application';
    END IF;
    IF coalesce(btrim(NEW.approved_by), '') = '' OR coalesce(btrim(NEW.notes), '') = '' THEN
      RAISE EXCEPTION 'a reversal needs a reason (notes) and an approver';
    END IF;
  ELSE
    IF NEW.applied_cents <= 0 THEN RAISE EXCEPTION 'an application must be positive'; END IF;
    IF NEW.applied_as_of <> pay.transaction_date THEN RAISE EXCEPTION 'applied_as_of must be the payment''s received date %', pay.transaction_date; END IF;
    IF NEW.method = 'auto_209_0063' AND (NEW.priority_step IS NULL OR chg.charge_category IS NULL OR chg.charge_category = 'prior_balance') THEN
      RAISE EXCEPTION 'charge % (category %) cannot be applied automatically', chg.id, chg.charge_category;
    END IF;
    IF NEW.method = 'manual_exception' AND coalesce(btrim(NEW.approved_by), '') = '' THEN RAISE EXCEPTION 'a manual exception needs an approver'; END IF;
  END IF;

  SELECT coalesce(sum(a.applied_cents), 0) INTO net_charge FROM homeowner_txn_applications a
    JOIN homeowner_transactions p ON p.id = a.payment_txn_id
    JOIN transaction_upload_batches pb ON pb.id = p.source_batch_id AND pb.status <> 'reverted'
   WHERE a.charge_txn_id = NEW.charge_txn_id;
  IF net_charge + NEW.applied_cents < 0 OR net_charge + NEW.applied_cents > chg.amount_cents THEN
    RAISE EXCEPTION 'charge % would be over-applied (% of %)', chg.id, net_charge + NEW.applied_cents, chg.amount_cents;
  END IF;
  SELECT coalesce(sum(applied_cents), 0) INTO net_payment FROM homeowner_txn_applications WHERE payment_txn_id = NEW.payment_txn_id;
  IF net_payment + NEW.applied_cents < 0 OR net_payment + NEW.applied_cents > -pay.amount_cents THEN
    RAISE EXCEPTION 'payment % would be over-applied (% of %)', pay.id, net_payment + NEW.applied_cents, -pay.amount_cents;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_homeowner_txn_applications_guard ON homeowner_txn_applications;
CREATE TRIGGER trg_homeowner_txn_applications_guard BEFORE INSERT OR UPDATE OR DELETE ON homeowner_txn_applications
  FOR EACH ROW EXECUTE FUNCTION homeowner_txn_applications_guard();

-- 4) Plan or post a payment to an explicit tenure, applied by the approved map:
--    1 delinquent assessment (dated on/before the payment), 2 current assessment,
--    3 attorney_fee, 4 attorney_fee_other, 5 fine, 6 interest / late_fee /
--    admin_fee / nsf_fee / certified_letter / other / adjustment; oldest first
--    within a step. prior_balance and uncategorized rows are never auto-applied.
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
       WHERE h.tenure_id = p_tenure_id AND h.amount_cents > 0
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

-- 5) Guards: nothing existing moved.
DO $guard$
DECLARE b record; v bigint;
BEGIN
  SELECT * INTO b FROM _m461_before;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: GL changed';
  END IF;
  IF b.cur_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance)
  OR b.former_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || coalesce(tenure_id::text, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(vantaca_account_id, '') || '|' || balance_cents::text, ',' ORDER BY community_id, tenure_id, property_id, vantaca_account_id), '')) FROM v_former_owner_ledger_balances) THEN
    RAISE EXCEPTION 'guard: homeowner balances changed';
  END IF;
  IF b.ht_h <> (SELECT md5(coalesce(string_agg(id::text || amount_cents::text || transaction_date::text || coalesce(tenure_id::text, '') || coalesce(charge_category, ''), ',' ORDER BY id), '')) FROM homeowner_transactions) THEN
    RAISE EXCEPTION 'guard: homeowner ledger rows changed';
  END IF;
  SELECT coalesce(sum(h.amount_cents), 0) INTO v FROM homeowner_transactions h
    JOIN transaction_upload_batches tb ON tb.id = h.source_batch_id AND tb.status = 'committed'
   WHERE h.community_id = 'a0000000-0000-4000-8000-000000000002' AND h.transaction_date <= '2026-07-31';
  IF v <> 5848342 THEN RAISE EXCEPTION 'guard: LOPF committed ledger as of 7/31 = % (expected 5848342)', v; END IF;
  --@@END@@
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
