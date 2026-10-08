-- ============================================================================
-- 500_transfer_assessment_proration.sql  (Ed 2026-10-08, GitHub issue #94)
-- ----------------------------------------------------------------------------
-- Builder-to-homeowner assessment proration INSIDE the ownership transfer.
--
-- Still Creek Ranch: Lennar pays 50% of the annual assessment while it owns a
-- lot; the original homeowner pays 100% from the day they own it. When a lot
-- transfers Lennar -> homeowner, the year splits by actual calendar days on the
-- transfer engine's own convention (approve_ownership_proposal, mig 459/460):
-- the seller owns through settlement - 1, the buyer from the settlement date.
--
--   builder_due   = annual x builder% x builder_days / days_in_year
--   homeowner_due = annual x homeowner_days / days_in_year
--   builder adjustment = builder_due - what the builder was already billed for
--                        the year (so the builder's NET is its prorated share)
--
-- Configuration, not code:
--   community_assessment_rates (mig 360) keeps the annual rates. A builder rate
--     may now be a PERCENT of the homeowner rate (pct_of_homeowner_rate), so a
--     change to the homeowner rate flows through. Still Creek is seeded with
--     its current $495.00 homeowner rate and a 50% builder rate.
--   transfer_proration_builders: which builder companies trigger the proration
--     at which community. Only Still Creek / Lennar is seeded. A community with
--     no row here is untouched: its transfers behave exactly as before.
--
-- Functions (service_role only):
--   transfer_proration_plan(...)          read-only: the calculation, the
--     builder's existing assessment activity, and whether it is safe to post.
--     Ambiguous activity BLOCKS (listed for a human); nothing is guessed.
--   post_transfer_assessment_proration(p_proposal_id, p_posted_by, p_dry_run)
--     after an approved transfer: writes the builder adjustment (seller tenure)
--     and the homeowner charge (buyer tenure) to a DRAFT batch plus one
--     assessment_prorations row per role. The caller posts the GL entry and
--     commits the batch (lib/accounting/transfer_proration.js), the same
--     pattern as the closing payoff (mig 461). One proposal can be prorated
--     once: UNIQUE (proposal_id, role) and a unique ledger-row key.
--
-- Record ownership: rates + builder rules are association configuration
-- (association_record); assessment_prorations is the audit trail of charges on
-- the association's books (association_record).
-- No existing ledger, GL, tenure or ownership row is changed. Seeds: 2 rate
-- rows + 1 builder rule for Still Creek Ranch (only if that community and the
-- Lennar builder company exist).
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1) A builder rate can be a percent of the homeowner rate.
-- ---------------------------------------------------------------------------
ALTER TABLE community_assessment_rates ADD COLUMN IF NOT EXISTS pct_of_homeowner_rate numeric(5,2);
ALTER TABLE community_assessment_rates ALTER COLUMN annual_amount_cents DROP NOT NULL;
ALTER TABLE community_assessment_rates DROP CONSTRAINT IF EXISTS community_assessment_rates_amount_or_pct;
ALTER TABLE community_assessment_rates ADD CONSTRAINT community_assessment_rates_amount_or_pct CHECK (
  (owner_class = 'homeowner' AND annual_amount_cents IS NOT NULL AND pct_of_homeowner_rate IS NULL)
  OR (owner_class = 'builder' AND ((annual_amount_cents IS NOT NULL) <> (pct_of_homeowner_rate IS NOT NULL)))
);
ALTER TABLE community_assessment_rates DROP CONSTRAINT IF EXISTS community_assessment_rates_pct_range;
ALTER TABLE community_assessment_rates ADD CONSTRAINT community_assessment_rates_pct_range
  CHECK (pct_of_homeowner_rate IS NULL OR (pct_of_homeowner_rate > 0 AND pct_of_homeowner_rate <= 100));

-- ---------------------------------------------------------------------------
-- 2) Which builders trigger the transfer proration, per community.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfer_proration_builders (
  community_id       uuid NOT NULL,
  builder_company_id uuid NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  notes              text,
  created_by         text NOT NULL DEFAULT 'migration',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_proration_builders_pkey PRIMARY KEY (community_id, builder_company_id),
  CONSTRAINT transfer_proration_builders_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT transfer_proration_builders_builder_fk FOREIGN KEY (builder_company_id) REFERENCES builder_companies(id) ON DELETE RESTRICT
);
GRANT SELECT, INSERT, UPDATE ON transfer_proration_builders TO service_role;

-- ---------------------------------------------------------------------------
-- 3) The proration audit row ties to the transfer, the tenure, the ledger row,
--    the batch and the GL entry. One row per (transfer, role).
-- ---------------------------------------------------------------------------
ALTER TABLE assessment_prorations
  ADD COLUMN IF NOT EXISTS proposal_id              uuid,
  ADD COLUMN IF NOT EXISTS role                     text,
  ADD COLUMN IF NOT EXISTS tenure_id                uuid,
  ADD COLUMN IF NOT EXISTS period_start             date,
  ADD COLUMN IF NOT EXISTS period_end               date,
  ADD COLUMN IF NOT EXISTS rate_pct                 numeric(5,2),
  ADD COLUMN IF NOT EXISTS net_responsibility_cents bigint,
  ADD COLUMN IF NOT EXISTS prior_billed_cents       bigint,
  ADD COLUMN IF NOT EXISTS homeowner_txn_id         uuid,
  ADD COLUMN IF NOT EXISTS batch_id                 uuid,
  ADD COLUMN IF NOT EXISTS journal_entry_id         uuid,
  ADD COLUMN IF NOT EXISTS status                   text;
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_proposal_fk;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_proposal_fk FOREIGN KEY (proposal_id) REFERENCES ownership_change_proposals(id) ON DELETE RESTRICT;
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_tenure_fk;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_tenure_fk FOREIGN KEY (tenure_id) REFERENCES ownership_tenures(id) ON DELETE RESTRICT;
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_txn_fk;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_txn_fk FOREIGN KEY (homeowner_txn_id) REFERENCES homeowner_transactions(id) ON DELETE RESTRICT;
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_batch_fk;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_batch_fk FOREIGN KEY (batch_id) REFERENCES transaction_upload_batches(id) ON DELETE RESTRICT;
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_je_fk;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_je_fk FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT;
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_role_check;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_role_check CHECK (role IS NULL OR role IN ('builder_adjustment', 'homeowner_charge'));
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_status_check;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_status_check CHECK (status IS NULL OR status IN ('draft', 'posted'));
ALTER TABLE assessment_prorations DROP CONSTRAINT IF EXISTS assessment_prorations_transfer_complete;
ALTER TABLE assessment_prorations ADD CONSTRAINT assessment_prorations_transfer_complete CHECK (
  proposal_id IS NULL
  OR (role IS NOT NULL AND tenure_id IS NOT NULL AND status IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL
      AND net_responsibility_cents IS NOT NULL AND prior_billed_cents IS NOT NULL
      AND (prorated_amount_cents = 0 OR homeowner_txn_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_prorations_transfer_role
  ON assessment_prorations (proposal_id, role) WHERE proposal_id IS NOT NULL;

-- The ledger rows themselves can never be written twice for one transfer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_transfer_proration
  ON homeowner_transactions ((raw_row_jsonb->>'proposal_id'), (raw_row_jsonb->>'role'))
  WHERE raw_row_jsonb->>'source' = 'transfer_proration';

-- ---------------------------------------------------------------------------
-- 4) Name match: does an owner name carry the builder's name as whole words?
--    "Lennar Homes LLC" and "Attn: Lennar Homes of Texas ... LTD" carry "Lennar".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION transfer_proration_name_has(p_name text, p_word text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(btrim(regexp_replace(lower(p_word), '[^a-z0-9]+', ' ', 'g')), '') <> ''
     AND (' ' || btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g')) || ' ')
         LIKE ('% ' || btrim(regexp_replace(lower(p_word), '[^a-z0-9]+', ' ', 'g')) || ' %')
$fn$;

-- ---------------------------------------------------------------------------
-- 5) The plan. Read-only. Works before approval (seller = the lot's open tenure,
--    buyer named) and after (both tenures known).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION transfer_proration_plan(
  p_property_id     uuid,
  p_seller_tenure_id uuid,
  p_settlement_date date,
  p_buyer_name      text,
  p_buyer_tenure_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  prop    properties%ROWTYPE;
  comm    communities%ROWTYPE;
  st      ownership_tenures%ROWTYPE;
  ho      community_assessment_rates%ROWTYPE;
  bl      community_assessment_rates%ROWTYPE;
  y int; jan1 date; dec31 date; diy int;
  seller_names jsonb; n_owners int; n_matched int; builder_ids uuid[]; builder_label text;
  buyer_names text[];
  b_start date; b_days int; h_days int;
  pct numeric; b_due bigint; h_due bigint; b_full bigint;
  prior jsonb := '[]'::jsonb; prior_n int := 0; prior_billed bigint := 0; one record;
  buyer_prior jsonb := '[]'::jsonb;
  blocked text[] := '{}';
  base jsonb;
BEGIN
  IF p_settlement_date IS NULL THEN RAISE EXCEPTION 'settlement date required'; END IF;
  SELECT * INTO prop FROM properties WHERE id = p_property_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'property % not found', p_property_id; END IF;
  SELECT * INTO comm FROM communities WHERE id = prop.community_id;

  -- Only configured communities. Everyone else keeps today's transfer exactly.
  IF NOT EXISTS (SELECT 1 FROM transfer_proration_builders WHERE community_id = comm.id AND active) THEN
    RETURN jsonb_build_object('applies', false, 'reason', 'community_not_configured');
  END IF;

  SELECT * INTO st FROM ownership_tenures WHERE id = p_seller_tenure_id;
  IF NOT FOUND OR st.property_id IS DISTINCT FROM prop.id OR st.kind <> 'owner' THEN
    RAISE EXCEPTION 'seller tenure % does not belong to this lot', p_seller_tenure_id;
  END IF;

  -- Who is selling: every owner on the seller tenure must be the same configured builder.
  WITH owners AS (
    SELECT c.full_name,
           (SELECT array_agg(DISTINCT tb.builder_company_id)
              FROM transfer_proration_builders tb JOIN builder_companies bc ON bc.id = tb.builder_company_id
             WHERE tb.community_id = comm.id AND tb.active AND transfer_proration_name_has(c.full_name, bc.company_name)) AS hits
      FROM property_ownerships po JOIN contacts c ON c.id = po.contact_id
     WHERE po.tenure_id = st.id
  )
  SELECT coalesce(jsonb_agg(full_name ORDER BY full_name), '[]'::jsonb), count(*), count(*) FILTER (WHERE hits IS NOT NULL),
         (SELECT array_agg(DISTINCT x) FROM owners o2, unnest(o2.hits) x)
    INTO seller_names, n_owners, n_matched, builder_ids
    FROM owners;
  IF n_matched = 0 THEN
    RETURN jsonb_build_object('applies', false, 'reason', 'seller_not_builder', 'seller_names', seller_names);
  END IF;
  SELECT string_agg(company_name, ', ' ORDER BY company_name) INTO builder_label FROM builder_companies WHERE id = ANY (builder_ids);
  IF n_matched < n_owners THEN blocked := blocked || 'seller_mixed_owners'::text; END IF;
  IF coalesce(array_length(builder_ids, 1), 0) > 1 THEN blocked := blocked || 'multiple_builders'::text; END IF;

  -- The buyer must be a homeowner, not another builder (any builder company on file).
  buyer_names := ARRAY[p_buyer_name];
  IF p_buyer_tenure_id IS NOT NULL THEN
    buyer_names := buyer_names || ARRAY(SELECT c.full_name FROM property_ownerships po JOIN contacts c ON c.id = po.contact_id WHERE po.tenure_id = p_buyer_tenure_id);
  END IF;
  IF EXISTS (SELECT 1 FROM builder_companies bc, unnest(buyer_names) bn
              WHERE bc.management_company_id IS NOT DISTINCT FROM comm.management_company_id
                AND transfer_proration_name_has(bn, bc.company_name)) THEN
    RETURN jsonb_build_object('applies', false, 'reason', 'buyer_is_builder', 'seller_names', seller_names, 'builder', builder_label);
  END IF;

  -- Rates (configuration, never constants).
  SELECT * INTO ho FROM community_assessment_rates WHERE community_id = comm.id AND owner_class = 'homeowner';
  SELECT * INTO bl FROM community_assessment_rates WHERE community_id = comm.id AND owner_class = 'builder';
  IF ho.id IS NULL OR bl.id IS NULL THEN
    RETURN jsonb_build_object('applies', true, 'blocked', true, 'blocked_reasons', to_jsonb(blocked || 'rates_missing'::text),
      'seller_names', seller_names, 'builder', builder_label);
  END IF;
  IF ho.fiscal_year_end_mmdd <> '12-31' OR bl.fiscal_year_end_mmdd <> '12-31' THEN blocked := blocked || 'fiscal_year_not_calendar'::text; END IF;

  -- Days, on the transfer engine's convention.
  y := extract(year FROM p_settlement_date)::int;
  jan1 := make_date(y, 1, 1); dec31 := make_date(y, 12, 31);
  diy := dec31 - jan1 + 1;
  b_start := jan1;
  -- A builder that took the lot through a recorded transfer this year owned it from that date.
  IF st.origin = 'transfer' AND st.start_date > jan1 AND st.start_date <= p_settlement_date THEN b_start := st.start_date; END IF;
  b_days := greatest(p_settlement_date - b_start, 0);
  h_days := dec31 - p_settlement_date + 1;
  IF bl.pct_of_homeowner_rate IS NOT NULL THEN
    pct := bl.pct_of_homeowner_rate;
    b_due := round(ho.annual_amount_cents::numeric * pct * b_days / (100 * diy));
    b_full := round(ho.annual_amount_cents::numeric * pct / 100);
  ELSE
    pct := round(bl.annual_amount_cents::numeric * 100 / nullif(ho.annual_amount_cents, 0), 2);
    b_due := round(bl.annual_amount_cents::numeric * b_days / diy);
    b_full := bl.annual_amount_cents;
  END IF;
  h_due := round(ho.annual_amount_cents::numeric * h_days / diy);

  -- What the builder was already billed for this year (its own tenure only).
  FOR one IN
    SELECT h.id, h.transaction_date, h.description, h.txn_type, h.charge_category, h.amount_cents
      FROM homeowner_transactions h
      JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
     WHERE h.transaction_date BETWEEN jan1 AND dec31
       AND coalesce(h.raw_row_jsonb->>'source', '') <> 'transfer_proration'
       AND (h.charge_category = 'assessment' OR (h.charge_category IS NULL AND h.description ILIKE '%assessment%'))
       AND (h.tenure_id = st.id
            OR (st.end_date IS NULL AND h.id IN (SELECT v.id FROM v_current_owner_ledger v WHERE v.property_id = prop.id AND v.tenure_id = st.id)))
     ORDER BY h.transaction_date, h.id
  LOOP
    prior_n := prior_n + 1;
    prior_billed := prior_billed + one.amount_cents;
    prior := prior || jsonb_build_object('id', one.id, 'date', one.transaction_date, 'description', one.description,
      'txn_type', one.txn_type, 'category', one.charge_category, 'amount_cents', one.amount_cents);
  END LOOP;
  -- Unambiguous only when the builder has nothing for the year, or exactly one
  -- positively identified ANNUAL assessment charge: a charge, described as the
  -- annual assessment (or categorized 'assessment'), dated Jan 1, at the full
  -- homeowner rate or the full builder rate. Anything else (a special
  -- assessment, a partial amount like $90.18, a credit, two rows) stops for a
  -- person. Only that one charge is netted; prior balances, late fees,
  -- interest and payments are never part of the adjustment.
  IF prior_n > 1 OR (prior_n = 1 AND NOT (
       (prior->0->>'date')::date = jan1
       AND prior->0->>'txn_type' = 'charge'
       AND (prior->0->>'category' = 'assessment' OR prior->0->>'description' ILIKE '%annual%assessment%')
       AND prior->0->>'description' NOT ILIKE '%special%'
       AND (prior->0->>'amount_cents')::bigint IN (ho.annual_amount_cents::bigint, b_full))) THEN
    blocked := blocked || 'ambiguous_builder_assessment'::text;
  END IF;

  -- The buyer starts the year clean (after approval: its new tenure).
  IF p_buyer_tenure_id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'date', h.transaction_date, 'description', h.description, 'amount_cents', h.amount_cents)), '[]'::jsonb)
      INTO buyer_prior
      FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
     WHERE h.tenure_id = p_buyer_tenure_id AND h.transaction_date BETWEEN jan1 AND dec31
       AND coalesce(h.raw_row_jsonb->>'source', '') <> 'transfer_proration'
       AND (h.charge_category = 'assessment' OR (h.charge_category IS NULL AND h.description ILIKE '%assessment%'));
    IF jsonb_array_length(buyer_prior) > 0 THEN blocked := blocked || 'buyer_already_billed'::text; END IF;
  END IF;

  -- The GL must be the book of record on the settlement date.
  IF coalesce(comm.books_of_record, '') <> 'trusted' OR comm.gl_cutover_date IS NULL OR p_settlement_date < comm.gl_cutover_date THEN
    blocked := blocked || 'before_gl_cutover'::text;
  END IF;

  base := jsonb_build_object(
    'applies', true, 'blocked', coalesce(array_length(blocked, 1), 0) > 0, 'blocked_reasons', to_jsonb(blocked),
    'builder', builder_label, 'seller_names', seller_names, 'buyer_name', p_buyer_name,
    'settlement_date', p_settlement_date, 'fiscal_year', y, 'days_in_year', diy,
    'annual_assessment_cents', ho.annual_amount_cents, 'builder_rate_pct', pct, 'homeowner_rate_pct', 100,
    'builder_period_start', b_start, 'builder_period_end', p_settlement_date - 1, 'builder_days', b_days,
    'homeowner_period_start', p_settlement_date, 'homeowner_period_end', dec31, 'homeowner_days', h_days,
    'builder_due_cents', b_due, 'homeowner_due_cents', h_due, 'total_recognized_cents', b_due + h_due,
    'builder_prior_billed_cents', prior_billed, 'builder_prior_rows', prior,
    'builder_adjustment_cents', b_due - prior_billed, 'buyer_prior_rows', buyer_prior,
    'gl_cutover_date', comm.gl_cutover_date, 'books_of_record', comm.books_of_record);
  RETURN base;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6) Post, after an approved transfer. Writes the subledger to a DRAFT batch;
--    lib/accounting/transfer_proration.js posts the GL and commits it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_transfer_assessment_proration(
  p_proposal_id uuid, p_posted_by text, p_dry_run boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  pr   ownership_change_proposals%ROWTYPE;
  prop properties%ROWTYPE;
  plan jsonb;
  existing jsonb;
  st ownership_tenures%ROWTYPE; bt ownership_tenures%ROWTYPE;
  mc uuid; batch_id uuid; b_txn uuid; h_txn uuid; s_contact uuid; b_contact uuid;
  adj bigint; h_due bigint; idx int := 0; n_rows int;
  money_fmt text := 'FM999,999,990.00';
  b_desc text; h_desc text;
BEGIN
  IF coalesce(btrim(p_posted_by), '') = '' THEN RAISE EXCEPTION 'posted_by required'; END IF;
  SELECT * INTO pr FROM ownership_change_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer % not found', p_proposal_id; END IF;
  IF pr.status <> 'approved' OR pr.seller_tenure_id IS NULL OR pr.buyer_tenure_id IS NULL OR pr.effective_start_date IS NULL THEN
    RAISE EXCEPTION 'transfer % is not an approved transfer with both tenures', p_proposal_id;
  END IF;

  -- Already prorated: return what exists (never a second set).
  SELECT jsonb_agg(jsonb_build_object('role', a.role, 'status', a.status, 'amount_cents', a.prorated_amount_cents,
           'homeowner_txn_id', a.homeowner_txn_id, 'batch_id', a.batch_id, 'journal_entry_id', a.journal_entry_id) ORDER BY a.role)
    INTO existing FROM assessment_prorations a WHERE a.proposal_id = p_proposal_id;
  IF existing IS NOT NULL THEN
    RETURN jsonb_build_object('already_prorated', true, 'proposal_id', p_proposal_id, 'rows', existing,
      'batch_id', (SELECT max(a.batch_id::text) FROM assessment_prorations a WHERE a.proposal_id = p_proposal_id),
      'all_posted', NOT EXISTS (SELECT 1 FROM assessment_prorations a WHERE a.proposal_id = p_proposal_id AND a.status <> 'posted'));
  END IF;

  plan := transfer_proration_plan(pr.property_id, pr.seller_tenure_id, pr.effective_start_date, pr.proposed_owner_name, pr.buyer_tenure_id);
  IF NOT (plan->>'applies')::boolean OR (plan->>'blocked')::boolean OR p_dry_run THEN
    RETURN plan || jsonb_build_object('proposal_id', p_proposal_id, 'dry_run', p_dry_run, 'posted', false);
  END IF;
  IF pr.effective_start_date > current_date THEN RAISE EXCEPTION 'settlement % is in the future', pr.effective_start_date; END IF;

  SELECT * INTO prop FROM properties WHERE id = pr.property_id;
  SELECT * INTO st FROM ownership_tenures WHERE id = pr.seller_tenure_id;
  SELECT * INTO bt FROM ownership_tenures WHERE id = pr.buyer_tenure_id;
  SELECT management_company_id INTO mc FROM communities WHERE id = prop.community_id;
  SELECT contact_id INTO s_contact FROM property_ownerships WHERE tenure_id = st.id ORDER BY is_primary DESC, start_date, id LIMIT 1;
  SELECT contact_id INTO b_contact FROM property_ownerships WHERE tenure_id = bt.id ORDER BY is_primary DESC, start_date, id LIMIT 1;
  adj := (plan->>'builder_adjustment_cents')::bigint;
  h_due := (plan->>'homeowner_due_cents')::bigint;

  b_desc := format('Builder assessment proration %s: %s/%s days at %s%% of $%s (%s to %s)%s',
    plan->>'fiscal_year', plan->>'builder_days', plan->>'days_in_year', trim(trailing '.' FROM trim(trailing '0' FROM (plan->>'builder_rate_pct'))),
    to_char((plan->>'annual_assessment_cents')::numeric / 100, money_fmt),
    to_char((plan->>'builder_period_start')::date, 'Mon DD'), to_char((plan->>'builder_period_end')::date, 'Mon DD'),
    CASE WHEN (plan->>'builder_prior_billed_cents')::bigint <> 0
         THEN format('; adjusts $%s already billed', to_char((plan->>'builder_prior_billed_cents')::numeric / 100, money_fmt)) ELSE '' END);
  h_desc := format('Prorated %s annual assessment: %s/%s days of $%s (%s to %s)',
    plan->>'fiscal_year', plan->>'homeowner_days', plan->>'days_in_year',
    to_char((plan->>'annual_assessment_cents')::numeric / 100, money_fmt),
    to_char((plan->>'homeowner_period_start')::date, 'Mon DD'), to_char((plan->>'homeowner_period_end')::date, 'Mon DD'));

  n_rows := (CASE WHEN adj <> 0 THEN 1 ELSE 0 END) + (CASE WHEN h_due > 0 THEN 1 ELSE 0 END);
  IF n_rows > 0 THEN
    INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status,
        row_count, account_count, total_charges_cents, total_payments_cents, min_transaction_date, max_transaction_date, uploaded_by, notes)
    VALUES (mc, prop.community_id, 'Transfer proration ' || pr.effective_start_date, pr.effective_start_date, 'manual', 'draft',
        n_rows, n_rows, greatest(adj, 0) + greatest(h_due, 0), 0, pr.effective_start_date, pr.effective_start_date,
        'transfer_proration', format('Assessment proration for transfer %s; posted by %s', p_proposal_id, p_posted_by))
    RETURNING id INTO batch_id;
  END IF;

  IF adj <> 0 THEN
    idx := idx + 1;
    INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
        property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, reduction_source, raw_row_jsonb)
    VALUES (batch_id, idx, prop.community_id, coalesce(st.vantaca_account_id, prop.vantaca_account_id), prop.trusted_account_number,
        prop.id, s_contact, st.id, pr.effective_start_date, b_desc,
        CASE WHEN adj > 0 THEN 'charge' ELSE 'adjustment' END, 'assessment', adj,
        CASE WHEN adj < 0 THEN 'correcting_adjustment' END,
        jsonb_build_object('source', 'transfer_proration', 'proposal_id', p_proposal_id::text, 'role', 'builder_adjustment', 'plan', plan))
    RETURNING id INTO b_txn;
  END IF;
  IF h_due > 0 THEN
    idx := idx + 1;
    INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
        property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, raw_row_jsonb)
    VALUES (batch_id, idx, prop.community_id, coalesce(bt.vantaca_account_id, prop.vantaca_account_id), prop.trusted_account_number,
        prop.id, b_contact, bt.id, pr.effective_start_date, h_desc, 'charge', 'assessment', h_due,
        jsonb_build_object('source', 'transfer_proration', 'proposal_id', p_proposal_id::text, 'role', 'homeowner_charge', 'plan', plan))
    RETURNING id INTO h_txn;
  END IF;

  INSERT INTO assessment_prorations (community_id, property_id, transfer_type, owner_class, effective_date, fiscal_year_end,
      days_prorated, days_in_year, annual_amount_cents, prorated_amount_cents, ar_charge_id, posted_by, notes,
      proposal_id, role, tenure_id, period_start, period_end, rate_pct, net_responsibility_cents, prior_billed_cents,
      homeowner_txn_id, batch_id, status)
  VALUES
    (prop.community_id, prop.id, 'builder_to_homeowner', 'builder', pr.effective_start_date, (plan->>'homeowner_period_end')::date,
      (plan->>'builder_days')::int, (plan->>'days_in_year')::int, (plan->>'annual_assessment_cents')::int, adj, b_txn, p_posted_by, b_desc,
      p_proposal_id, 'builder_adjustment', st.id, (plan->>'builder_period_start')::date, (plan->>'builder_period_end')::date,
      (plan->>'builder_rate_pct')::numeric, (plan->>'builder_due_cents')::bigint, (plan->>'builder_prior_billed_cents')::bigint,
      b_txn, batch_id, CASE WHEN adj <> 0 THEN 'draft' ELSE 'posted' END),
    (prop.community_id, prop.id, 'builder_to_homeowner', 'homeowner', pr.effective_start_date, (plan->>'homeowner_period_end')::date,
      (plan->>'homeowner_days')::int, (plan->>'days_in_year')::int, (plan->>'annual_assessment_cents')::int, h_due, h_txn, p_posted_by, h_desc,
      p_proposal_id, 'homeowner_charge', bt.id, (plan->>'homeowner_period_start')::date, (plan->>'homeowner_period_end')::date,
      100, h_due, 0, h_txn, batch_id, CASE WHEN h_due > 0 THEN 'draft' ELSE 'posted' END);

  RETURN plan || jsonb_build_object('proposal_id', p_proposal_id, 'dry_run', false, 'posted', false, 'written', true,
    'batch_id', batch_id, 'builder_txn_id', b_txn, 'homeowner_txn_id', h_txn,
    'seller_tenure_id', st.id, 'buyer_tenure_id', bt.id, 'property_id', prop.id, 'community_id', prop.community_id);
END;
$fn$;

REVOKE ALL ON FUNCTION transfer_proration_plan(uuid, uuid, date, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION transfer_proration_plan(uuid, uuid, date, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION post_transfer_assessment_proration(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION post_transfer_assessment_proration(uuid, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 7) Still Creek Ranch: the current rates and the Lennar rule (configuration).
-- ---------------------------------------------------------------------------
INSERT INTO community_assessment_rates (community_id, owner_class, annual_amount_cents, fiscal_year_end_mmdd, notes)
SELECT 'a0000000-0000-4000-8000-000000000006', 'homeowner', 49500, '12-31', 'Annual assessment (issue #94, 2026-10-08)'
 WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000006')
ON CONFLICT (community_id, owner_class) DO NOTHING;
INSERT INTO community_assessment_rates (community_id, owner_class, annual_amount_cents, pct_of_homeowner_rate, fiscal_year_end_mmdd, notes)
SELECT 'a0000000-0000-4000-8000-000000000006', 'builder', NULL, 50, '12-31', 'Builder (Lennar) rate: 50% of the homeowner rate (issue #94)'
 WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000006')
ON CONFLICT (community_id, owner_class) DO NOTHING;
INSERT INTO transfer_proration_builders (community_id, builder_company_id, notes, created_by)
SELECT 'a0000000-0000-4000-8000-000000000006', '0eda1b79-0526-4e5d-8a4b-5488a0938ed1', 'Lennar to original homeowner (issue #94)', 'migration 500'
 WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000006')
   AND EXISTS (SELECT 1 FROM builder_companies WHERE id = '0eda1b79-0526-4e5d-8a4b-5488a0938ed1')
ON CONFLICT ON CONSTRAINT transfer_proration_builders_pkey DO NOTHING;

COMMIT;
