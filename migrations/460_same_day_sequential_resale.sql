-- ============================================================================
-- 460_same_day_sequential_resale.sql
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (ownership roster). No new tables or
-- columns; no existing row is changed.
--
-- WHY: a lot can legitimately close twice on one day (LOPF 8/12/2026: owner ->
-- builder LLC -> second LLC). Mig 459 required the settlement date to be AFTER
-- the seller's start, so the second closing was refused, and "seller ends
-- settlement - 1" would end the intermediate owner before it began.
--
-- CHANGE (approve_ownership_proposal only, same signature):
--   * settlement = seller tenure start is allowed ONLY when that tenure was
--     created by an approved transfer (origin = 'transfer') AND the proposal
--     names the seller (current_contact_id), who must still be the current owner;
--   * in that case the seller ends ON the settlement date (a one-day tenure,
--     start = end, which the existing end >= start rule allows) and the buyer
--     starts the same day;
--   * everything else is unchanged: settlement before the seller's start, a
--     future date, an import/backfill start date, a stale or unnamed seller and
--     re-approval are refused; balances never move; rows dated on/after the
--     settlement that sit on the seller are listed for review.
-- Order within a day needs no new column: only the CURRENT (open) tenure can be
-- a seller, so each same-day closing must follow the previous one; display
-- order is start_date, end_date (open last), created_at.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m460_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) AS cur_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || coalesce(tenure_id::text, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(vantaca_account_id, '') || '|' || balance_cents::text, ',' ORDER BY community_id, tenure_id, property_id, vantaca_account_id), '')) FROM v_former_owner_ledger_balances) AS former_h,
  (SELECT md5(coalesce(string_agg(id::text || coalesce(tenure_id::text, '') || coalesce(end_date::text, '') || contact_id::text, ',' ORDER BY id), '')) FROM property_ownerships) AS own_h,
  (SELECT md5(coalesce(string_agg(id::text || coalesce(end_date::text, '') || coalesce(vantaca_account_id, ''), ',' ORDER BY id), '')) FROM ownership_tenures) AS ten_h;

CREATE OR REPLACE FUNCTION approve_ownership_proposal(
  p_proposal_id     uuid,
  p_reviewed_by     text,
  p_notes           text DEFAULT NULL,
  p_settlement_date date DEFAULT NULL,
  p_home_sale_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pr           ownership_change_proposals%ROWTYPE;
  prop         properties%ROWTYPE;
  seller_t     ownership_tenures%ROWTYPE;
  settle       date;
  seller_end   date;
  seller_cid   uuid;
  buyer_cid    uuid;
  buyer_tid    uuid;
  new_acct     text;
  sale_id      uuid;
  n            int;
  closed_n     int;
  stamped_n    int := 0;
  seller_ids   uuid[];
  seller_bal   bigint;
  exceptions   jsonb;
  same_day     boolean := false;
BEGIN
  IF p_reviewed_by IS NULL OR btrim(p_reviewed_by) = '' THEN RAISE EXCEPTION 'reviewed_by_required'; END IF;

  SELECT * INTO pr FROM ownership_change_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'proposal % not found', p_proposal_id; END IF;
  IF pr.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal is already %; a transfer is approved once', pr.status;
  END IF;
  IF pr.property_id IS NULL THEN RAISE EXCEPTION 'property_required'; END IF;
  IF pr.proposed_owner_name IS NULL OR btrim(pr.proposed_owner_name) = '' THEN RAISE EXCEPTION 'buyer_required'; END IF;

  settle := coalesce(p_settlement_date, pr.effective_start_date);
  IF settle IS NULL THEN RAISE EXCEPTION 'settlement_date_required'; END IF;
  IF settle > CURRENT_DATE THEN
    RAISE EXCEPTION 'settlement date % is in the future; record the transfer after it closes', settle;
  END IF;

  SELECT * INTO prop FROM properties WHERE id = pr.property_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'property % not found', pr.property_id; END IF;
  IF prop.community_id <> pr.community_id THEN RAISE EXCEPTION 'proposal community does not match the property'; END IF;

  SELECT * INTO seller_t FROM ownership_tenures
   WHERE property_id = prop.id AND kind = 'owner' AND end_date IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'property % has no current ownership tenure', prop.id; END IF;
  IF seller_t.start_date IS NOT NULL AND settle < seller_t.start_date THEN
    RAISE EXCEPTION 'settlement date % must be after the current owner''s start date %', settle, seller_t.start_date;
  END IF;
  -- Same-day sequential resale (mig 460): the seller bought AND resold on the
  -- settlement date. Allowed only when the seller's tenure was itself created by
  -- an approved transfer (never an import/backfill start date) and the proposal
  -- names that seller, who must still be the current owner (checked below).
  -- The intermediate owner then holds a one-day tenure: start = end = settlement.
  IF seller_t.start_date IS NOT NULL AND settle = seller_t.start_date THEN
    IF seller_t.origin <> 'transfer' THEN
      RAISE EXCEPTION 'settlement date % must be after the current owner''s start date %', settle, seller_t.start_date;
    END IF;
    IF pr.current_contact_id IS NULL THEN
      RAISE EXCEPTION 'same-day resale on %: the proposal must name the seller (the current owner)', settle;
    END IF;
    same_day := true;
  END IF;
  seller_end := CASE WHEN same_day THEN settle ELSE settle - 1 END;

  -- Seller = the lot's current owner(s).
  SELECT count(*) INTO n FROM property_ownerships WHERE property_id = prop.id AND end_date IS NULL;
  IF n = 0 THEN RAISE EXCEPTION 'seller_required: the property has no current owner on file'; END IF;
  IF pr.current_contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM property_ownerships
        WHERE property_id = prop.id AND end_date IS NULL AND contact_id = pr.current_contact_id) THEN
    RAISE EXCEPTION 'seller_changed: the seller on this proposal is no longer the current owner';
  END IF;
  IF EXISTS (SELECT 1 FROM property_ownerships
              WHERE property_id = prop.id AND end_date IS NULL AND start_date > seller_end) THEN
    RAISE EXCEPTION 'settlement date % is not after a current owner''s start date', settle;
  END IF;
  SELECT contact_id INTO seller_cid FROM property_ownerships
   WHERE property_id = prop.id AND end_date IS NULL
   ORDER BY is_primary DESC, start_date ASC, created_at ASC, id ASC LIMIT 1;

  -- New source account: only a supplied, well-formed, unused one.
  new_acct := nullif(btrim(pr.vantaca_account_id), '');
  IF new_acct IS NOT NULL THEN
    IF new_acct !~ '^[0-9]{5,12}$' THEN RAISE EXCEPTION 'unsupported source account "%"', new_acct; END IF;
    IF new_acct = prop.vantaca_account_id THEN
      new_acct := NULL;                                   -- same account: nothing to change
    ELSIF EXISTS (SELECT 1 FROM properties WHERE community_id = prop.community_id AND vantaca_account_id = new_acct AND id <> prop.id)
       OR EXISTS (SELECT 1 FROM ownership_tenures WHERE community_id = prop.community_id AND vantaca_account_id = new_acct) THEN
      RAISE EXCEPTION 'source account % already belongs to another lot or owner', new_acct;
    END IF;
  END IF;

  -- Buyer contact: match by email only within this community, else create.
  IF nullif(btrim(pr.proposed_owner_email), '') IS NOT NULL THEN
    SELECT c.id INTO buyer_cid FROM contacts c
     WHERE lower(c.primary_email) = lower(btrim(pr.proposed_owner_email))
       AND EXISTS (SELECT 1 FROM property_ownerships po JOIN properties pp ON pp.id = po.property_id
                    WHERE po.contact_id = c.id AND pp.community_id = prop.community_id)
     ORDER BY c.created_at, c.id LIMIT 1;
  END IF;
  IF buyer_cid IS NOT NULL AND EXISTS (
       SELECT 1 FROM property_ownerships WHERE property_id = prop.id AND end_date IS NULL AND contact_id = buyer_cid) THEN
    RAISE EXCEPTION 'buyer is already a current owner of this lot; that is not a sale';
  END IF;
  IF buyer_cid IS NULL THEN
    INSERT INTO contacts (full_name, primary_email, primary_phone, mailing_address, vantaca_account_id)
    VALUES (btrim(pr.proposed_owner_name), nullif(btrim(pr.proposed_owner_email), ''), pr.proposed_owner_phone,
            pr.proposed_mailing_address, new_acct)
    RETURNING id INTO buyer_cid;
  ELSIF pr.proposed_mailing_address IS NOT NULL THEN
    UPDATE contacts SET mailing_address = pr.proposed_mailing_address, updated_at = now() WHERE id = buyer_cid;
  END IF;

  -- The current owner's money before the transfer (row ids + total).
  SELECT coalesce(array_agg(id), '{}'), coalesce(sum(amount_cents), 0)
    INTO seller_ids, seller_bal
    FROM v_current_owner_ledger WHERE property_id = prop.id;

  PERFORM set_config('trusted.ownership_transfer', 'on', true);

  -- Attribute the seller's not-yet-stamped rows to the seller (no movement:
  -- they are the current owner's today; this pins them before the tenure ends).
  UPDATE homeowner_transactions SET tenure_id = seller_t.id
   WHERE id IN (SELECT id FROM v_current_owner_ledger WHERE property_id = prop.id AND NOT stamped);
  GET DIAGNOSTICS stamped_n = ROW_COUNT;
  UPDATE ar_charges  SET tenure_id = seller_t.id WHERE property_id = prop.id AND tenure_id IS NULL;
  UPDATE ar_payments SET tenure_id = seller_t.id WHERE property_id = prop.id AND tenure_id IS NULL;

  -- Seller ends settlement - 1 (ownerships + tenure).
  UPDATE property_ownerships SET tenure_id = seller_t.id
   WHERE property_id = prop.id AND end_date IS NULL AND tenure_id IS NULL;
  UPDATE property_ownerships SET end_date = seller_end, updated_at = now()
   WHERE property_id = prop.id AND end_date IS NULL;
  GET DIAGNOSTICS closed_n = ROW_COUNT;
  UPDATE ownership_tenures SET end_date = seller_end WHERE id = seller_t.id;

  -- Buyer starts on the settlement date with a new tenure.
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin, created_by_proposal_id, notes)
  VALUES (prop.community_id, prop.id, 'owner', settle, new_acct, 'transfer', pr.id,
          'Transfer approved by ' || p_reviewed_by || ' on ' || CURRENT_DATE::text)
  RETURNING id INTO buyer_tid;
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source, notes, tenure_id)
  VALUES (prop.id, buyer_cid, settle, true, 'ownership_proposal_approval',
          'Approved from proposal ' || pr.id::text
            || CASE WHEN new_acct IS NOT NULL THEN ' (source acct -> ' || new_acct || ')' ELSE '' END,
          buyer_tid);

  IF new_acct IS NOT NULL THEN
    UPDATE properties SET vantaca_account_id = new_acct, updated_at = now() WHERE id = prop.id;
  END IF;

  -- Post-checks: the seller's rows stayed on the seller; the buyer inherits nothing.
  SELECT count(*) INTO n FROM homeowner_transactions
   WHERE id = ANY (seller_ids) AND tenure_id IS DISTINCT FROM seller_t.id;
  IF n <> 0 THEN RAISE EXCEPTION 'post-check: % seller ledger rows are not on the seller tenure', n; END IF;
  SELECT count(*) INTO n FROM v_current_owner_ledger WHERE property_id = prop.id;
  IF n <> 0 THEN RAISE EXCEPTION 'post-check: buyer would start with % ledger rows', n; END IF;
  IF (SELECT trusted_account_number FROM properties WHERE id = prop.id) IS DISTINCT FROM prop.trusted_account_number THEN
    RAISE EXCEPTION 'post-check: trusted account number changed';
  END IF;
  SELECT count(*) INTO n FROM ownership_tenures WHERE property_id = prop.id AND kind = 'owner' AND end_date IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'post-check: % open tenures on the lot', n; END IF;

  -- Rows dated on/after settlement that sit on the seller: listed, never moved.
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'date', x->>'id'), '[]'::jsonb) INTO exceptions FROM (
    SELECT jsonb_build_object('table', 'homeowner_transactions', 'id', h.id, 'date', h.transaction_date,
                              'amount_cents', h.amount_cents, 'description', h.description) AS x
      FROM homeowner_transactions h
      JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
     WHERE h.tenure_id = seller_t.id AND h.transaction_date >= settle
    UNION ALL
    SELECT jsonb_build_object('table', 'ar_charges', 'id', c.id, 'date', c.charge_date,
                              'amount_cents', c.balance_remaining_cents, 'description', c.description)
      FROM ar_charges c WHERE c.tenure_id = seller_t.id AND c.charge_date >= settle
    UNION ALL
    SELECT jsonb_build_object('table', 'ar_payments', 'id', p.id, 'date', p.payment_date,
                              'amount_cents', -p.amount_cents, 'description', coalesce(p.notes, 'payment'))
      FROM ar_payments p WHERE p.tenure_id = seller_t.id AND p.payment_date >= settle
  ) s;

  -- Home Sales row, same transaction.
  sale_id := coalesce(p_home_sale_id, pr.home_sale_id);
  IF sale_id IS NOT NULL THEN
    UPDATE home_sales
       SET status = 'closed', closing_date = settle, buyer_contact_id = buyer_cid,
           ownership_proposal_id = pr.id, ownership_updated_at = now(),
           seller_final_balance_cents = seller_bal, updated_at = now()
     WHERE id = sale_id AND property_id = prop.id AND status IN ('requested', 'disclosed');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'home sale % not found for this lot, or already closed/cancelled', sale_id; END IF;
  END IF;

  UPDATE ownership_change_proposals
     SET status = 'approved', reviewed_at = now(), reviewed_by = p_reviewed_by, decision_notes = p_notes,
         effective_start_date = settle, effective_end_date_prior = seller_end,
         current_contact_id = coalesce(current_contact_id, seller_cid),
         home_sale_id = sale_id, seller_tenure_id = seller_t.id, buyer_tenure_id = buyer_tid,
         transfer_exceptions = exceptions, updated_at = now()
   WHERE id = pr.id;
  -- Any other pending proposal for this lot was written against the seller.
  UPDATE ownership_change_proposals
     SET status = 'superseded', reviewed_at = now(), reviewed_by = p_reviewed_by,
         decision_notes = 'Superseded by approved transfer ' || pr.id::text, updated_at = now()
   WHERE property_id = prop.id AND status = 'pending' AND id <> pr.id;

  PERFORM set_config('trusted.ownership_transfer', 'off', true);

  RETURN jsonb_build_object(
    'ok', true,
    'proposal_id', pr.id,
    'property_id', prop.id,
    'settlement_date', settle,
    'seller_end_date', seller_end,
    'same_day_resale', same_day,
    'seller_tenure_id', seller_t.id,
    'buyer_tenure_id', buyer_tid,
    'new_contact_id', buyer_cid,
    'prior_ownerships_closed', closed_n,
    'seller_balance_cents', seller_bal,
    'seller_rows_attributed', stamped_n,
    'vantaca_account_synced', new_acct IS NOT NULL,
    'vantaca_account_id', new_acct,
    'home_sale_id', sale_id,
    'transfer_exceptions', exceptions
  );
END;
$$;
REVOKE ALL ON FUNCTION approve_ownership_proposal(uuid, text, text, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_ownership_proposal(uuid, text, text, date, uuid) TO service_role;

DO $guard$
DECLARE n bigint; v bigint; w bigint; b record;
BEGIN
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'approve_ownership_proposal';
  IF n <> 1 THEN RAISE EXCEPTION 'guard: % approve_ownership_proposal functions (must be exactly one path)', n; END IF;
  SELECT * INTO b FROM _m460_before;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: GL changed';
  END IF;
  IF b.cur_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance)
  OR b.former_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || coalesce(tenure_id::text, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(vantaca_account_id, '') || '|' || balance_cents::text, ',' ORDER BY community_id, tenure_id, property_id, vantaca_account_id), '')) FROM v_former_owner_ledger_balances) THEN
    RAISE EXCEPTION 'guard: homeowner balances changed';
  END IF;
  IF b.own_h <> (SELECT md5(coalesce(string_agg(id::text || coalesce(tenure_id::text, '') || coalesce(end_date::text, '') || contact_id::text, ',' ORDER BY id), '')) FROM property_ownerships)
  OR b.ten_h <> (SELECT md5(coalesce(string_agg(id::text || coalesce(end_date::text, '') || coalesce(vantaca_account_id, ''), ',' ORDER BY id), '')) FROM ownership_tenures) THEN
    RAISE EXCEPTION 'guard: ownership / tenure rows changed';
  END IF;
  SELECT coalesce(sum(balance_cents), 0) INTO v FROM v_current_owner_balance WHERE community_id = 'a0000000-0000-4000-8000-000000000002';
  SELECT coalesce(sum(balance_cents), 0) INTO w FROM v_former_owner_ledger_balances WHERE community_id = 'a0000000-0000-4000-8000-000000000002';
  IF v <> 5881849 OR w <> -33507 THEN
    RAISE EXCEPTION 'guard: LOPF current % former % (expected 5881849 / -33507)', v, w;
  END IF;
  --@@END@@
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
