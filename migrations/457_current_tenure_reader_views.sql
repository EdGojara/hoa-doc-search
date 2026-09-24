-- ============================================================================
-- 457_current_tenure_reader_views.sql
-- ----------------------------------------------------------------------------
-- Reader views for the ownership-tenure switch (mig 456). VIEWS ONLY: no table,
-- row or writer changes. Record ownership: association_record.
--
-- "The current owner's money" = committed ledger rows on the lot's CURRENT
-- tenure that are still on the lot's current account:
--   * stamped rows: tenure_id = the property's current tenure AND the row's
--     Vantaca account is NULL (native) or equals the property's account;
--   * unstamped rows (writers are not switched yet, so a new row may arrive
--     without tenure_id): the row's account equals the property's account
--     (only when exactly one property carries that account).
-- Until the transfer path creates tenures, a Vantaca account change is how a
-- sale shows up in a Vantaca-fed community; the "still on the lot's current
-- account" condition keeps the buyer from inheriting the seller's rows, exactly
-- as the account-keyed readers behave today.
--
-- Everything committed that is NOT the current owner's is former-owner money:
-- legacy tenures (no property), historical tenures, and rows left on a lot's
-- prior account. Those appear only in v_former_owner_ledger_balances.
--
-- Also: v_current_property_owners gets a deterministic tiebreak (two open
-- co-owners tied on is_primary + start_date were picked arbitrarily) and the
-- current tenure_id appended as the last column (safe CREATE OR REPLACE).
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW v_current_owner_ledger AS
SELECT h.id, h.community_id, t.property_id, t.id AS tenure_id, h.vantaca_account_id, h.contact_id,
       h.transaction_date, h.description, h.txn_type, h.amount_cents, h.running_balance_cents,
       h.charge_category, h.created_at, h.source_batch_id, true AS stamped
  FROM homeowner_transactions h
  JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
  JOIN ownership_tenures t ON t.id = h.tenure_id AND t.kind = 'owner' AND t.end_date IS NULL
  JOIN properties p ON p.id = t.property_id
 WHERE h.vantaca_account_id IS NULL OR h.vantaca_account_id = p.vantaca_account_id
UNION ALL
SELECT h.id, h.community_id, t.property_id, t.id AS tenure_id, h.vantaca_account_id, h.contact_id,
       h.transaction_date, h.description, h.txn_type, h.amount_cents, h.running_balance_cents,
       h.charge_category, h.created_at, h.source_batch_id, false AS stamped
  FROM homeowner_transactions h
  JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
  JOIN properties p ON p.community_id = h.community_id AND p.vantaca_account_id = h.vantaca_account_id
  JOIN ownership_tenures t ON t.property_id = p.id AND t.kind = 'owner' AND t.end_date IS NULL
 WHERE h.tenure_id IS NULL
   AND (SELECT count(*) FROM properties p2 WHERE p2.community_id = h.community_id AND p2.vantaca_account_id = h.vantaca_account_id) = 1;

CREATE OR REPLACE VIEW v_current_owner_balance AS
SELECT community_id, property_id, tenure_id,
       sum(amount_cents)::bigint AS balance_cents,
       max(transaction_date) AS most_recent_txn_date,
       count(*) AS txn_count,
       count(*) FILTER (WHERE NOT stamped) AS unstamped_count
  FROM v_current_owner_ledger
 GROUP BY community_id, property_id, tenure_id;

CREATE OR REPLACE VIEW v_current_owner_balance_composition AS
SELECT community_id, property_id, tenure_id,
       COALESCE(charge_category, 'other') AS charge_category,
       sum(amount_cents)::bigint AS amount_cents,
       count(*) AS txn_count,
       min(transaction_date) AS earliest_txn_date,
       max(transaction_date) AS latest_txn_date
  FROM v_current_owner_ledger
 GROUP BY community_id, property_id, tenure_id, COALESCE(charge_category, 'other');

-- Former-owner money: committed rows that are not any current owner's.
CREATE OR REPLACE VIEW v_former_owner_ledger_balances AS
SELECT h.community_id,
       h.tenure_id,
       t.kind AS tenure_kind,
       COALESCE(t.property_id, h.property_id) AS property_id,
       h.vantaca_account_id,
       sum(h.amount_cents)::bigint AS balance_cents,
       count(*) AS txn_count,
       max(h.transaction_date) AS most_recent_txn_date
  FROM homeowner_transactions h
  JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
  LEFT JOIN ownership_tenures t ON t.id = h.tenure_id
 WHERE NOT EXISTS (SELECT 1 FROM v_current_owner_ledger c WHERE c.id = h.id)
 GROUP BY h.community_id, h.tenure_id, t.kind, COALESCE(t.property_id, h.property_id), h.vantaca_account_id;

GRANT SELECT ON v_current_owner_ledger, v_current_owner_balance,
                v_current_owner_balance_composition, v_former_owner_ledger_balances TO service_role;

-- Deterministic current owner + current tenure (appended last).
CREATE OR REPLACE VIEW v_current_property_owners AS
SELECT DISTINCT ON (p.id)
  p.id              AS property_id,
  p.community_id,
  p.street_address,
  p.unit,
  p.city,
  p.state,
  p.zip,
  p.property_type,
  p.lot_number,
  c.id              AS owner_contact_id,
  c.full_name       AS owner_name,
  c.primary_email   AS owner_email,
  c.primary_phone   AS owner_phone,
  c.mailing_address AS owner_mailing_address,
  o.start_date      AS owned_since,
  o.vesting,
  o.is_primary,
  p.latitude,
  p.longitude,
  p.boundary,
  p.vantaca_account_id,
  c.mailing_street  AS owner_mailing_street,
  c.mailing_city    AS owner_mailing_city,
  c.mailing_state   AS owner_mailing_state,
  c.mailing_zip     AS owner_mailing_zip,
  p.trusted_account_number,        -- mig 252 trustEd account # (stable, property-scoped)
  t.id              AS tenure_id   -- mig 457: the lot's current ownership tenure
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
LEFT JOIN ownership_tenures t  ON t.property_id = p.id AND t.kind = 'owner' AND t.end_date IS NULL
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST, o.created_at ASC NULLS LAST, o.id ASC;

-- Guards: the views partition the committed ledger exactly.
DO $guard$
DECLARE n bigint; v bigint; w bigint;
BEGIN
  SELECT count(*) - count(DISTINCT id) INTO n FROM v_current_owner_ledger;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % ledger rows counted twice as current', n; END IF;
  SELECT count(*) INTO n FROM (SELECT property_id FROM v_current_owner_balance GROUP BY property_id HAVING count(*) > 1) x;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % properties with more than one current balance', n; END IF;
  -- every community: current + former = all committed (nothing lost, nothing doubled)
  SELECT count(*) INTO n FROM (
    SELECT h.community_id, sum(h.amount_cents) AS total
      FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
     GROUP BY h.community_id) t
   WHERE t.total <> coalesce((SELECT sum(balance_cents) FROM v_current_owner_balance c WHERE c.community_id = t.community_id), 0)
                  + coalesce((SELECT sum(balance_cents) FROM v_former_owner_ledger_balances f WHERE f.community_id = t.community_id), 0);
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % communities where current + former <> committed ledger', n; END IF;
  SELECT (SELECT count(*) FROM v_current_owner_ledger) + (SELECT coalesce(sum(txn_count), 0) FROM v_former_owner_ledger_balances),
         (SELECT count(*) FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed')
    INTO v, w;
  IF v <> w THEN RAISE EXCEPTION 'guard: current + former rows % <> committed rows %', v, w; END IF;
  -- LOPF: current owners carry $58,818.49, former-owner credits -$335.07, net $58,483.42
  SELECT coalesce(sum(balance_cents), 0) INTO v FROM v_current_owner_balance WHERE community_id = 'a0000000-0000-4000-8000-000000000002';
  SELECT coalesce(sum(balance_cents), 0) INTO w FROM v_former_owner_ledger_balances WHERE community_id = 'a0000000-0000-4000-8000-000000000002';
  IF v <> 5881849 OR w <> -33507 OR v + w <> 5848342 THEN
    RAISE EXCEPTION 'guard: LOPF current % former % (expected 5881849 / -33507, net 5848342)', v, w;
  END IF;
  SELECT (SELECT count(*) FROM v_current_property_owners) - (SELECT count(*) FROM properties) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: current-owner view rows differ from properties by %', n; END IF;
  --@@END@@
END
$guard$;

COMMIT;
