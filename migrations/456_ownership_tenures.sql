-- ============================================================================
-- 456_ownership_tenures.sql
-- ----------------------------------------------------------------------------
-- Ownership periods (tenures): the accounting key for "whose money is this".
--
-- WHY: the homeowner ledger treats one account as one owner tenure, but the key
-- was the Vantaca account number on the PROPERTY, which only changes because
-- Vantaca issues a new number at each sale. After a community leaves Vantaca
-- (LOPF from 8/1) nothing issues a new key, so a Trusted-recorded sale would
-- leave the buyer on the seller's account. The property keeps its stable
-- trusted_account_number (identifies the lot); the tenure identifies the owner
-- period. Co-owners in one period share a tenure. A sale ends the seller's
-- tenure and starts a new one; balances never move between tenures.
--
-- THIS MIGRATION IS ADDITIVE AND BEHAVIOR-NEUTRAL. It creates the table, adds
-- nullable tenure_id columns, and backfills them. No view, function or code
-- path reads tenure_id yet, so no balance, statement, portal or GL output can
-- change. Readers/writers switch to tenure_id in later, separately verified steps.
--
-- Backfill (committed ledger mapping proven 2026-09-24: 0 unmatched rows):
--   * one CURRENT tenure per property (end_date NULL), carrying the property's
--     current vantaca_account_id as a cross-reference only;
--   * open property_ownerships rows -> their property's current tenure (co-owners share);
--   * ended property_ownerships rows -> one HISTORICAL tenure per
--     (property, start_date, end_date) period;
--   * committed homeowner_transactions with a property -> that property's current
--     tenure (every such row's account equals the property's current account, or
--     is NULL for native trustEd-numbered communities);
--   * committed homeowner_transactions with NO property -> one LEGACY tenure per
--     (community, vantaca_account_id). Legacy tenures have no property, are never
--     current, and belong only in historical / former-owner aging;
--   * ar_charges / ar_payments (older subledger, always property-keyed) -> the
--     property's current tenure (identical to today's property-level balance);
--   * rows in REVERTED ledger batches are left NULL: no balance reads them.
--
-- Guards: any failed check raises and rolls back everything.
-- Record ownership: association_record (the HOA's owner/AR records).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ownership_tenures (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id             uuid REFERENCES properties(id) ON DELETE RESTRICT,
  kind                    text NOT NULL CHECK (kind IN ('owner', 'legacy')),
  start_date              date,                 -- settlement date for transfers; NULL = before Trusted history
  end_date                date,                 -- settlement - 1 when superseded by a sale
  vantaca_account_id      text,                 -- cross-reference only, never the key
  origin                  text NOT NULL
                            CHECK (origin IN ('backfill_current', 'backfill_historical', 'backfill_legacy', 'transfer')),
  created_by_proposal_id  uuid REFERENCES ownership_change_proposals(id) ON DELETE SET NULL,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ownership_tenures_legacy_has_no_property CHECK ((kind = 'legacy') = (property_id IS NULL)),
  CONSTRAINT ownership_tenures_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- One current owner tenure per lot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ownership_tenures_current
  ON ownership_tenures (property_id) WHERE kind = 'owner' AND end_date IS NULL;
-- A Vantaca account maps to at most one tenure per community.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ownership_tenures_vantaca
  ON ownership_tenures (community_id, vantaca_account_id) WHERE vantaca_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ownership_tenures_property ON ownership_tenures (property_id, start_date);
CREATE INDEX IF NOT EXISTS idx_ownership_tenures_community ON ownership_tenures (community_id, kind);

-- Immutable key: identity, lot, kind and start never change; end_date is set
-- once (by a transfer); tenures are never deleted.
CREATE OR REPLACE FUNCTION ownership_tenures_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ownership_tenures are permanent (tenure %)', OLD.id;
  END IF;
  IF NEW.id <> OLD.id OR NEW.community_id <> OLD.community_id
     OR NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.kind <> OLD.kind
     OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.origin <> OLD.origin THEN
    RAISE EXCEPTION 'ownership_tenures identity is immutable (tenure %)', OLD.id;
  END IF;
  IF OLD.end_date IS NOT NULL AND NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    RAISE EXCEPTION 'tenure % already ended on %', OLD.id, OLD.end_date;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_ownership_tenures_guard ON ownership_tenures;
CREATE TRIGGER trg_ownership_tenures_guard BEFORE UPDATE OR DELETE ON ownership_tenures
  FOR EACH ROW EXECUTE FUNCTION ownership_tenures_guard();

GRANT SELECT, INSERT, UPDATE ON ownership_tenures TO service_role;
GRANT SELECT ON ownership_tenures TO authenticated;

ALTER TABLE property_ownerships    ADD COLUMN IF NOT EXISTS tenure_id uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT;
ALTER TABLE homeowner_transactions ADD COLUMN IF NOT EXISTS tenure_id uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT;
ALTER TABLE ar_charges             ADD COLUMN IF NOT EXISTS tenure_id uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT;
ALTER TABLE ar_payments            ADD COLUMN IF NOT EXISTS tenure_id uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_property_ownerships_tenure    ON property_ownerships (tenure_id);
CREATE INDEX IF NOT EXISTS idx_homeowner_transactions_tenure ON homeowner_transactions (tenure_id);
CREATE INDEX IF NOT EXISTS idx_ar_charges_tenure             ON ar_charges (tenure_id);
CREATE INDEX IF NOT EXISTS idx_ar_payments_tenure            ON ar_payments (tenure_id);

DO $backfill$
DECLARE
  n bigint; v bigint; bad text;
  je_n0 bigint; je_h0 text; jel_n0 bigint; jel_h0 text;
  bal_n0 bigint; bal_s0 bigint; bal_h0 text;
  lopf_net0 bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM ownership_tenures) THEN
    RAISE EXCEPTION 'ownership_tenures already populated; backfill runs once';
  END IF;

  -- BEFORE fingerprints: GL, every current balance, LOPF net.
  SELECT count(*), md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), ''))
    INTO je_n0, je_h0 FROM journal_entries;
  SELECT count(*), md5(coalesce(string_agg(id::text || account_id::text || coalesce(fund_id::text, '') || debit_cents::text || credit_cents::text, ',' ORDER BY id), ''))
    INTO jel_n0, jel_h0 FROM journal_entry_lines;
  SELECT count(*), coalesce(sum(balance_cents), 0),
         md5(coalesce(string_agg(community_id::text || '|' || coalesce(vantaca_account_id, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(contact_id::text, '') || '|' || balance_cents::text, ',' ORDER BY community_id, vantaca_account_id, property_id, contact_id), ''))
    INTO bal_n0, bal_s0, bal_h0 FROM v_homeowner_current_balance;
  SELECT coalesce(sum(t.amount_cents), 0) INTO lopf_net0
    FROM homeowner_transactions t JOIN transaction_upload_batches b ON b.id = t.source_batch_id
   WHERE b.status = 'committed' AND t.community_id = 'a0000000-0000-4000-8000-000000000002';
  IF lopf_net0 <> 5848342 THEN RAISE EXCEPTION 'precondition: LOPF ledger net % <> 5848342', lopf_net0; END IF;

  -- Precondition: every committed ledger row with a property carries that
  -- property's current account (or none), so the mapping is exact.
  SELECT count(*) INTO n FROM homeowner_transactions t
    JOIN transaction_upload_batches b ON b.id = t.source_batch_id
    JOIN properties p ON p.id = t.property_id
   WHERE b.status = 'committed' AND t.vantaca_account_id IS NOT NULL
     AND t.vantaca_account_id IS DISTINCT FROM p.vantaca_account_id;
  IF n <> 0 THEN RAISE EXCEPTION 'precondition: % committed ledger rows are on a non-current account of their property', n; END IF;
  SELECT count(*) INTO n FROM homeowner_transactions t
    JOIN transaction_upload_batches b ON b.id = t.source_batch_id
   WHERE b.status = 'committed' AND t.property_id IS NULL AND t.vantaca_account_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'precondition: % committed ledger rows have neither property nor account', n; END IF;
  SELECT count(*) INTO n FROM (
    SELECT t.community_id, t.vantaca_account_id FROM homeowner_transactions t
      JOIN transaction_upload_batches b ON b.id = t.source_batch_id
     WHERE b.status = 'committed' AND t.property_id IS NULL
    INTERSECT
    SELECT community_id, vantaca_account_id FROM properties WHERE vantaca_account_id IS NOT NULL) x;
  IF n <> 0 THEN RAISE EXCEPTION 'precondition: % no-property ledger accounts are also a current property account', n; END IF;

  -- Stamping tenure_id is not an edit anyone made: keep updated_at untouched.
  ALTER TABLE property_ownerships DISABLE TRIGGER trg_property_ownerships_updated_at;
  ALTER TABLE ar_charges          DISABLE TRIGGER trg_ar_charges_updated_at;
  ALTER TABLE ar_payments         DISABLE TRIGGER trg_ar_payments_updated_at;

  -- 1) one current tenure per property
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, vantaca_account_id, origin, notes)
  SELECT p.community_id, p.id, 'owner',
         (SELECT min(o.start_date) FROM property_ownerships o WHERE o.property_id = p.id AND o.end_date IS NULL),
         p.vantaca_account_id, 'backfill_current',
         'Backfilled 2026-09-24 (mig 456): current owner period as recorded'
    FROM properties p;

  -- 2) open ownerships -> current tenure (co-owners share it)
  UPDATE property_ownerships o SET tenure_id = t.id
    FROM ownership_tenures t
   WHERE o.end_date IS NULL AND t.property_id = o.property_id AND t.kind = 'owner' AND t.end_date IS NULL;

  -- 3) one historical tenure per ended ownership period. A recorded start that
  --    falls after the end is an import placeholder (the 5/19 roster load), not
  --    a real start: the tenure's start is unknown (NULL = before Trusted history).
  INSERT INTO ownership_tenures (community_id, property_id, kind, start_date, end_date, origin, notes)
  SELECT DISTINCT p.community_id, o.property_id, 'owner',
         CASE WHEN o.start_date <= o.end_date THEN o.start_date END, o.end_date, 'backfill_historical',
         'Backfilled 2026-09-24 (mig 456): prior owner period as recorded'
    FROM property_ownerships o JOIN properties p ON p.id = o.property_id
   WHERE o.end_date IS NOT NULL;
  UPDATE property_ownerships o SET tenure_id = t.id
    FROM ownership_tenures t
   WHERE o.end_date IS NOT NULL AND t.origin = 'backfill_historical'
     AND t.property_id = o.property_id AND t.end_date = o.end_date
     AND t.start_date IS NOT DISTINCT FROM (CASE WHEN o.start_date <= o.end_date THEN o.start_date END);

  -- 4) one legacy tenure per no-property committed account
  INSERT INTO ownership_tenures (community_id, property_id, kind, vantaca_account_id, origin, notes)
  SELECT DISTINCT t.community_id, NULL::uuid, 'legacy', t.vantaca_account_id, 'backfill_legacy',
         'Backfilled 2026-09-24 (mig 456): former-owner / legacy account with no property; historical aging only'
    FROM homeowner_transactions t JOIN transaction_upload_batches b ON b.id = t.source_batch_id
   WHERE b.status = 'committed' AND t.property_id IS NULL;

  -- 5) stamp committed ledger rows
  UPDATE homeowner_transactions h SET tenure_id = t.id
    FROM transaction_upload_batches b, ownership_tenures t
   WHERE b.id = h.source_batch_id AND b.status = 'committed' AND h.property_id IS NOT NULL
     AND t.property_id = h.property_id AND t.kind = 'owner' AND t.end_date IS NULL;
  UPDATE homeowner_transactions h SET tenure_id = t.id
    FROM transaction_upload_batches b, ownership_tenures t
   WHERE b.id = h.source_batch_id AND b.status = 'committed' AND h.property_id IS NULL
     AND t.kind = 'legacy' AND t.community_id = h.community_id AND t.vantaca_account_id = h.vantaca_account_id;

  -- 6) older subledger -> property's current tenure
  UPDATE ar_charges c SET tenure_id = t.id FROM ownership_tenures t
   WHERE t.property_id = c.property_id AND t.kind = 'owner' AND t.end_date IS NULL;
  UPDATE ar_payments pay SET tenure_id = t.id FROM ownership_tenures t
   WHERE t.property_id = pay.property_id AND t.kind = 'owner' AND t.end_date IS NULL;

  ALTER TABLE property_ownerships ENABLE TRIGGER trg_property_ownerships_updated_at;
  ALTER TABLE ar_charges          ENABLE TRIGGER trg_ar_charges_updated_at;
  ALTER TABLE ar_payments         ENABLE TRIGGER trg_ar_payments_updated_at;

  -- ---------------------------- guards -------------------------------------
  SELECT (SELECT count(*) FROM property_ownerships WHERE updated_at >= now())
       + (SELECT count(*) FROM ar_charges WHERE updated_at >= now())
       + (SELECT count(*) FROM ar_payments WHERE updated_at >= now()) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: backfill touched updated_at on % rows', n; END IF;
  SELECT count(*) INTO n FROM properties p
   WHERE (SELECT count(*) FROM ownership_tenures t WHERE t.property_id = p.id AND t.kind = 'owner' AND t.end_date IS NULL) <> 1;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % properties without exactly one current tenure', n; END IF;
  SELECT count(*) INTO n FROM property_ownerships WHERE tenure_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % ownership rows without a tenure', n; END IF;
  SELECT count(*) INTO n FROM property_ownerships o JOIN ownership_tenures t ON t.id = o.tenure_id
   WHERE t.property_id <> o.property_id OR (o.end_date IS NULL) <> (t.end_date IS NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % ownership rows on the wrong tenure', n; END IF;
  SELECT count(*) INTO n FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id
   WHERE b.status = 'committed' AND h.tenure_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % committed ledger rows without a tenure', n; END IF;
  SELECT count(*) INTO n FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id = h.source_batch_id
   WHERE b.status <> 'committed' AND h.tenure_id IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % non-committed ledger rows were stamped', n; END IF;
  SELECT count(*) INTO n FROM ar_charges WHERE tenure_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % ar_charges without a tenure', n; END IF;
  SELECT count(*) INTO n FROM ar_payments WHERE tenure_id IS NULL AND property_id IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % ar_payments without a tenure', n; END IF;
  -- The mapping is 1:1: every balance account/property key is exactly one tenure
  -- and every tenure is exactly one key, so per-tenure balances = today's balances.
  SELECT count(*) INTO n FROM (
    SELECT h.community_id, h.vantaca_account_id, h.property_id FROM homeowner_transactions h
      JOIN transaction_upload_batches b ON b.id = h.source_batch_id WHERE b.status = 'committed'
     GROUP BY 1, 2, 3 HAVING count(DISTINCT h.tenure_id) <> 1) x;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % balance keys split across tenures', n; END IF;
  SELECT count(*) INTO n FROM (
    SELECT h.tenure_id FROM homeowner_transactions h
      JOIN transaction_upload_batches b ON b.id = h.source_batch_id WHERE b.status = 'committed'
     GROUP BY 1 HAVING count(DISTINCT (h.community_id, coalesce(h.vantaca_account_id, ''), coalesce(h.property_id::text, ''))) <> 1) x;
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % tenures merge more than one balance key', n; END IF;
  SELECT count(*) INTO n FROM ownership_tenures WHERE kind = 'legacy' AND (property_id IS NOT NULL OR end_date IS NOT NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'guard: % malformed legacy tenures', n; END IF;
  -- Nothing that anyone reads changed.
  SELECT count(*), md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), ''))
    INTO n, bad FROM journal_entries;
  IF n <> je_n0 OR bad <> je_h0 THEN RAISE EXCEPTION 'guard: journal_entries changed'; END IF;
  SELECT count(*), md5(coalesce(string_agg(id::text || account_id::text || coalesce(fund_id::text, '') || debit_cents::text || credit_cents::text, ',' ORDER BY id), ''))
    INTO n, bad FROM journal_entry_lines;
  IF n <> jel_n0 OR bad <> jel_h0 THEN RAISE EXCEPTION 'guard: journal_entry_lines changed'; END IF;
  SELECT count(*), coalesce(sum(balance_cents), 0),
         md5(coalesce(string_agg(community_id::text || '|' || coalesce(vantaca_account_id, '') || '|' || coalesce(property_id::text, '') || '|' || coalesce(contact_id::text, '') || '|' || balance_cents::text, ',' ORDER BY community_id, vantaca_account_id, property_id, contact_id), ''))
    INTO n, v, bad FROM v_homeowner_current_balance;
  IF n <> bal_n0 OR v <> bal_s0 OR bad <> bal_h0 THEN RAISE EXCEPTION 'guard: current balances changed'; END IF;
  SELECT coalesce(sum(t.amount_cents), 0) INTO v
    FROM homeowner_transactions t JOIN transaction_upload_batches b ON b.id = t.source_batch_id
   WHERE b.status = 'committed' AND t.community_id = 'a0000000-0000-4000-8000-000000000002';
  IF v <> 5848342 THEN RAISE EXCEPTION 'guard: LOPF ledger net % <> 5848342', v; END IF;
  -- Per-tenure LOPF balances sum to the same net.
  SELECT coalesce(sum(s), 0) INTO v FROM (
    SELECT sum(h.amount_cents) s FROM homeowner_transactions h
      JOIN transaction_upload_batches b ON b.id = h.source_batch_id
      JOIN ownership_tenures t ON t.id = h.tenure_id
     WHERE b.status = 'committed' AND t.community_id = 'a0000000-0000-4000-8000-000000000002' GROUP BY h.tenure_id) x;
  IF v <> 5848342 THEN RAISE EXCEPTION 'guard: LOPF per-tenure net % <> 5848342', v; END IF;

  RAISE NOTICE 'mig 456 OK: % tenures (% current, % historical, % legacy)',
    (SELECT count(*) FROM ownership_tenures),
    (SELECT count(*) FROM ownership_tenures WHERE origin = 'backfill_current'),
    (SELECT count(*) FROM ownership_tenures WHERE origin = 'backfill_historical'),
    (SELECT count(*) FROM ownership_tenures WHERE origin = 'backfill_legacy');
  --@@END@@
END
$backfill$;

COMMIT;
