-- ============================================================================
-- 459_ownership_transfer_single_path.sql
-- ----------------------------------------------------------------------------
-- Record ownership: property_ownerships, ownership_tenures and
-- ownership_change_proposals are `association_record` (the roster is the HOA's).
-- No new tables.
--
-- WHY: approve_ownership_proposal (mig 087/316) predates ownership tenures (mig
-- 456). It ended the seller ON the closing date (not the day before), defaulted
-- a missing date to "today" (the processing date, not the settlement date), and
-- never touched the tenures. After an approval the lot's current tenure was still
-- the seller's, so the homeowner ledger (mig 457 reads by tenure) would show the
-- seller's balance to the buyer. Claim Transfer and the Vantaca contacts upload
-- also wrote ownership / the source account directly, outside review.
--
-- This migration makes approve_ownership_proposal the ONE transfer path:
--   * settlement date required (proposal's, or supplied by the reviewer);
--     processed date = reviewed_at, kept separate;
--   * seller ownership(s) AND seller tenure end settlement - 1;
--   * buyer gets a NEW tenure and ownership starting on the settlement date;
--   * the seller's not-yet-stamped current ledger rows are stamped to the
--     SELLER's tenure first, so nothing he owes can surface as the buyer's;
--     balances never move; rows dated on/after settlement that sit on the
--     seller are listed in transfer_exceptions for review, never moved;
--   * trusted_account_number never changes; the Vantaca account xref changes
--     only when the proposal carries a well-formed, unused new account;
--   * refuses non-pending / duplicate approvals, a stale seller, a buyer who
--     already owns the lot, and a settlement date that is in the future or
--     not after the current owner's start;
--   * links the Home Sales row (home_sale_id) in the same transaction;
--   * all or nothing; post-checks inside the function raise (roll back) if the
--     seller's rows moved or the buyer starts with any balance.
-- Direct writers are refused by triggers unless the transfer function is running
-- (transaction-local setting trusted.ownership_transfer = on):
--   * creating or ending an ownership tenure;
--   * ending or deleting a current ownership;
--   * changing a lot's Vantaca account away from its current tenure's xref;
--   * an open ownership on anything but the lot's current tenure (new co-owners
--     are stamped to the current tenure automatically).
-- No existing row is changed by this migration.
-- ============================================================================

BEGIN;

-- Before-fingerprints (compared at the end; nothing may change).
CREATE TEMP TABLE _m459_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT md5(coalesce(string_agg(id::text || account_id::text || coalesce(fund_id::text, '') || debit_cents::text || credit_cents::text, ',' ORDER BY id), '')) FROM journal_entry_lines) AS jel_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance) AS cur_h,
  (SELECT md5(coalesce(string_agg(community_id::text || '|' || coalesce(tenure_id::text, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(vantaca_account_id, '') || '|' || balance_cents::text, ',' ORDER BY community_id, tenure_id, property_id, vantaca_account_id), '')) FROM v_former_owner_ledger_balances) AS former_h,
  (SELECT md5(coalesce(string_agg(id::text || coalesce(tenure_id::text, '') || coalesce(end_date::text, '') || contact_id::text, ',' ORDER BY id), '')) FROM property_ownerships) AS own_h,
  (SELECT md5(coalesce(string_agg(id::text || coalesce(end_date::text, '') || coalesce(vantaca_account_id, ''), ',' ORDER BY id), '')) FROM ownership_tenures) AS ten_h,
  (SELECT md5(coalesce(string_agg(id::text || coalesce(vantaca_account_id, '') || coalesce(trusted_account_number, ''), ',' ORDER BY id), '')) FROM properties) AS prop_h,
  (SELECT md5(coalesce(string_agg(id::text || coalesce(tenure_id::text, ''), ',' ORDER BY id), '')) FROM homeowner_transactions) AS ht_h;

-- ---------------------------------------------------------------------------
-- 1) Proposal: link to the home sale, the two tenures, and the review list.
-- ---------------------------------------------------------------------------
ALTER TABLE ownership_change_proposals
  ADD COLUMN IF NOT EXISTS home_sale_id        uuid REFERENCES home_sales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS seller_tenure_id    uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS buyer_tenure_id     uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS transfer_exceptions jsonb;
COMMENT ON COLUMN ownership_change_proposals.effective_start_date IS 'Settlement date: buyer ownership + tenure start. Required at approval.';
COMMENT ON COLUMN ownership_change_proposals.effective_end_date_prior IS 'Settlement - 1: seller ownership + tenure end. Set by approval.';
COMMENT ON COLUMN ownership_change_proposals.reviewed_at IS 'Processed date/time (separate from the settlement date).';
COMMENT ON COLUMN ownership_change_proposals.transfer_exceptions IS 'Ledger rows dated on/after settlement that remain on the seller tenure. Listed for review; never moved automatically.';

-- ---------------------------------------------------------------------------
-- 2) The transfer-path flag and the direct-writer guards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ownership_transfer_in_progress() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('trusted.ownership_transfer', true), '') = 'on'
$fn$;
-- Left executable: the guard triggers call it as whichever role is writing.

CREATE OR REPLACE FUNCTION ownership_tenures_transfer_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF ownership_transfer_in_progress() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'ownership tenures are created only by an approved ownership transfer (Ownership Review / Home Sales)';
  END IF;
  IF NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    RAISE EXCEPTION 'a tenure ends only through an approved ownership transfer (tenure %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_ownership_tenures_transfer_only ON ownership_tenures;
CREATE TRIGGER trg_ownership_tenures_transfer_only BEFORE INSERT OR UPDATE ON ownership_tenures
  FOR EACH ROW EXECUTE FUNCTION ownership_tenures_transfer_only();

CREATE OR REPLACE FUNCTION property_ownerships_transfer_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE cur uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.end_date IS NULL AND NOT ownership_transfer_in_progress() THEN
      RAISE EXCEPTION 'a current ownership cannot be deleted; ownership changes go through Ownership Review (ownership %)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT ownership_transfer_in_progress() THEN
    IF OLD.end_date IS NULL AND NEW.end_date IS NOT NULL THEN
      RAISE EXCEPTION 'ending a current ownership is a transfer; use Ownership Review (ownership %)', OLD.id;
    END IF;
    IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
      RAISE EXCEPTION 'an ownership cannot be moved to another lot (ownership %)', OLD.id;
    END IF;
  END IF;
  -- An open ownership belongs to the lot's current tenure (co-owners share it).
  IF NEW.end_date IS NULL THEN
    SELECT id INTO cur FROM ownership_tenures
     WHERE property_id = NEW.property_id AND kind = 'owner' AND end_date IS NULL;
    IF cur IS NOT NULL THEN
      IF NEW.tenure_id IS NULL THEN
        NEW.tenure_id := cur;
      ELSIF NEW.tenure_id <> cur THEN
        RAISE EXCEPTION 'an open ownership must be on the lot''s current tenure (ownership %, tenure %)', NEW.id, NEW.tenure_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_property_ownerships_transfer_guard ON property_ownerships;
CREATE TRIGGER trg_property_ownerships_transfer_guard BEFORE INSERT OR UPDATE OR DELETE ON property_ownerships
  FOR EACH ROW EXECUTE FUNCTION property_ownerships_transfer_guard();

CREATE OR REPLACE FUNCTION properties_account_xref_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE t_found boolean := false; t_xref text;
BEGIN
  IF NEW.vantaca_account_id IS NOT DISTINCT FROM OLD.vantaca_account_id OR ownership_transfer_in_progress() THEN
    RETURN NEW;
  END IF;
  SELECT true, vantaca_account_id INTO t_found, t_xref FROM ownership_tenures
   WHERE property_id = NEW.id AND kind = 'owner' AND end_date IS NULL;
  IF t_found AND t_xref IS DISTINCT FROM NEW.vantaca_account_id THEN
    RAISE EXCEPTION 'a lot''s source account changes only with an approved ownership transfer (property %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_properties_account_xref_guard ON properties;
CREATE TRIGGER trg_properties_account_xref_guard BEFORE UPDATE OF vantaca_account_id ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_account_xref_guard();

-- ---------------------------------------------------------------------------
-- 3) The single transfer path.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS approve_ownership_proposal(uuid, text, text);
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
  seller_end := settle - 1;

  SELECT * INTO prop FROM properties WHERE id = pr.property_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'property % not found', pr.property_id; END IF;
  IF prop.community_id <> pr.community_id THEN RAISE EXCEPTION 'proposal community does not match the property'; END IF;

  SELECT * INTO seller_t FROM ownership_tenures
   WHERE property_id = prop.id AND kind = 'owner' AND end_date IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'property % has no current ownership tenure', prop.id; END IF;
  IF seller_t.start_date IS NOT NULL AND settle <= seller_t.start_date THEN
    RAISE EXCEPTION 'settlement date % must be after the current owner''s start date %', settle, seller_t.start_date;
  END IF;

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

-- ---------------------------------------------------------------------------
-- 4) Review queue: settlement date, seller id, links and exceptions (appended).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ownership_proposals_queue AS
SELECT
  p.id,
  p.community_id,
  (SELECT name FROM communities WHERE id = p.community_id) AS community_name,
  p.property_id,
  prop.street_address,
  prop.unit,
  p.current_owner_name,
  p.current_owner_email,
  p.proposed_owner_name,
  p.proposed_owner_email,
  p.proposed_mailing_address,
  p.source,
  p.source_filename,
  p.vantaca_account_id,
  p.status,
  p.created_at,
  p.reviewed_at,
  p.reviewed_by,
  p.decision_notes,
  EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400.0 AS age_days,
  p.current_contact_id,
  p.effective_start_date,
  p.effective_end_date_prior,
  p.home_sale_id,
  p.seller_tenure_id,
  p.buyer_tenure_id,
  p.transfer_exceptions
FROM ownership_change_proposals p
LEFT JOIN properties prop ON prop.id = p.property_id;
GRANT SELECT ON v_ownership_proposals_queue TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- 5) Guards: existing data already satisfies the new rules, and nothing moved.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE n bigint; v bigint; w bigint; b record;
BEGIN
  SELECT count(*) INTO n FROM property_ownerships po
    JOIN ownership_tenures t ON t.property_id = po.property_id AND t.kind = 'owner' AND t.end_date IS NULL
   WHERE po.end_date IS NULL AND po.tenure_id IS DISTINCT FROM t.id;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % open ownerships are not on their lot''s current tenure', n; END IF;
  SELECT count(*) INTO n FROM properties p
    JOIN ownership_tenures t ON t.property_id = p.id AND t.kind = 'owner' AND t.end_date IS NULL
   WHERE t.vantaca_account_id IS DISTINCT FROM p.vantaca_account_id;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % lots whose account differs from the current tenure xref', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'approve_ownership_proposal';
  IF n <> 1 THEN RAISE EXCEPTION 'guard: % approve_ownership_proposal functions (must be exactly one path)', n; END IF;

  SELECT * INTO b FROM _m459_before;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries)
  OR b.jel_h <> (SELECT md5(coalesce(string_agg(id::text || account_id::text || coalesce(fund_id::text, '') || debit_cents::text || credit_cents::text, ',' ORDER BY id), '')) FROM journal_entry_lines) THEN
    RAISE EXCEPTION 'guard: GL changed';
  END IF;
  IF b.cur_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || property_id::text || '|' || tenure_id::text || '|' || balance_cents::text, ',' ORDER BY community_id, property_id, tenure_id), '')) FROM v_current_owner_balance)
  OR b.former_h <> (SELECT md5(coalesce(string_agg(community_id::text || '|' || coalesce(tenure_id::text, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(vantaca_account_id, '') || '|' || balance_cents::text, ',' ORDER BY community_id, tenure_id, property_id, vantaca_account_id), '')) FROM v_former_owner_ledger_balances) THEN
    RAISE EXCEPTION 'guard: homeowner balances changed';
  END IF;
  IF b.own_h <> (SELECT md5(coalesce(string_agg(id::text || coalesce(tenure_id::text, '') || coalesce(end_date::text, '') || contact_id::text, ',' ORDER BY id), '')) FROM property_ownerships)
  OR b.ten_h <> (SELECT md5(coalesce(string_agg(id::text || coalesce(end_date::text, '') || coalesce(vantaca_account_id, ''), ',' ORDER BY id), '')) FROM ownership_tenures)
  OR b.prop_h <> (SELECT md5(coalesce(string_agg(id::text || coalesce(vantaca_account_id, '') || coalesce(trusted_account_number, ''), ',' ORDER BY id), '')) FROM properties)
  OR b.ht_h <> (SELECT md5(coalesce(string_agg(id::text || coalesce(tenure_id::text, ''), ',' ORDER BY id), '')) FROM homeowner_transactions) THEN
    RAISE EXCEPTION 'guard: ownership / tenure / property / ledger rows changed';
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
