-- ============================================================================
-- 504_opening_ap_payment_clearances.sql  (Ed 2026-10-09)
-- ----------------------------------------------------------------------------
-- CONVERSION OPENING AP IS A LIABILITY CARRIED THROUGH THE CUTOFF, NOT A
-- PAYMENT INSTRUCTION.
--
-- The Canyon Gate conversion (CONV-CGACR-20260731) wrote the 12 invoices open on
-- Vantaca's 7/31 AP aging as 'approved'; all 12 ($7,992.75) appeared in Bills
-- ready to pay, and 9 ($2,134.19) had already been paid by ACH in March-May.
-- The application guard (lib/accounting/opening_ap_guard.js) holds every
-- opening AP invoice from payment until a person clears it. This migration
-- gives that clearance a durable home and makes future conversions safe:
--
-- 1. opening_ap_payment_clearances: append-only decisions, one row per decision,
--    latest per invoice wins. 'cleared_for_payment' records that the item was
--    really outstanding at the cutoff, has not been settled since, and HOW it is
--    paid (check / ach), with a basis and who decided. 'revoked' withdraws a
--    clearance. Nothing is ever updated or deleted.
--    Record ownership: association_record (part of the association's books:
--    the approval behind a disbursement).
-- 2. ap_invoices.status gains 'conversion_review': the review state an opening
--    item is written in (never 'approved'). The existing values are unchanged.
-- 3. trg_ap_invoices_opening_ap_defaults (BEFORE INSERT only): an invoice born
--    posted by a conversion opening entry (journal_entries.source_module =
--    'opening_entry') carries its vendor's auto-pay flag, and is written as
--    'conversion_review' if it arrived as 'approved' / 'awaiting_approval'. The
--    conversion plan already writes this; the trigger is the backstop, because
--    the execute function inserts a fixed column list without is_ach_autopay.
--
-- NO EXISTING ROW CHANGES. The 15 open opening invoices at Canyon Gate, Lakes of
-- Pine Forest and Quail Ridge keep their status, amounts and flags exactly; the
-- application guard holds them by provenance. No clearance row is written here.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------- 1. clearances
CREATE TABLE IF NOT EXISTS opening_ap_payment_clearances (
  id              UUID NOT NULL DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL,
  community_id    UUID NOT NULL,
  decision        TEXT NOT NULL,
  payment_method  TEXT,
  basis           TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT opening_ap_payment_clearances_pkey PRIMARY KEY (id),
  CONSTRAINT opening_ap_payment_clearances_invoice_fk FOREIGN KEY (invoice_id) REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT opening_ap_payment_clearances_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT opening_ap_payment_clearances_decision_check CHECK (decision IN ('cleared_for_payment', 'revoked')),
  -- a clearance says how the item is paid; a revocation names no method
  CONSTRAINT opening_ap_payment_clearances_method_check CHECK (
    (decision = 'cleared_for_payment' AND payment_method IN ('check', 'ach'))
    OR (decision = 'revoked' AND payment_method IS NULL)),
  CONSTRAINT opening_ap_payment_clearances_basis_check CHECK (length(btrim(basis)) >= 10 AND length(btrim(decided_by)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_opening_ap_payment_clearances_invoice ON opening_ap_payment_clearances (invoice_id, created_at);

-- Append-only, and a decision must belong to the invoice's own community.
CREATE OR REPLACE FUNCTION opening_ap_payment_clearances_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv_comm UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'opening_ap_payment_clearances is append-only: record a new decision (e.g. revoked) instead of changing one' USING ERRCODE = 'check_violation';
  END IF;
  SELECT community_id INTO inv_comm FROM ap_invoices WHERE id = NEW.invoice_id;
  IF inv_comm IS DISTINCT FROM NEW.community_id THEN
    RAISE EXCEPTION 'opening AP clearance: invoice % belongs to another community', NEW.invoice_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_opening_ap_payment_clearances_guard ON opening_ap_payment_clearances;
CREATE TRIGGER trg_opening_ap_payment_clearances_guard BEFORE INSERT OR UPDATE OR DELETE ON opening_ap_payment_clearances
  FOR EACH ROW EXECUTE FUNCTION opening_ap_payment_clearances_guard();

ALTER TABLE opening_ap_payment_clearances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opening_ap_payment_clearances FROM anon, authenticated;
GRANT SELECT, INSERT ON opening_ap_payment_clearances TO service_role;

-- ------------------------------------------------- 2. the conversion review state
ALTER TABLE ap_invoices DROP CONSTRAINT IF EXISTS ap_invoices_status_check;
ALTER TABLE ap_invoices ADD CONSTRAINT ap_invoices_status_check CHECK (status IN (
  'awaiting_approval', 'approved', 'partially_paid', 'paid', 'voided', 'disputed', 'on_hold',
  'conversion_review'
));

-- ------------------------------------------- 3. future opening AP: backstop on insert
CREATE OR REPLACE FUNCTION ap_invoices_opening_ap_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_opening BOOLEAN; vendor_autopay BOOLEAN;
BEGIN
  IF NEW.posting_journal_entry_id IS NULL THEN RETURN NEW; END IF;
  SELECT (source_module = 'opening_entry') INTO is_opening FROM journal_entries WHERE id = NEW.posting_journal_entry_id;
  IF NOT coalesce(is_opening, FALSE) THEN RETURN NEW; END IF;
  SELECT auto_pay_ach INTO vendor_autopay FROM vendors WHERE id = NEW.vendor_id;
  NEW.is_ach_autopay := coalesce(NEW.is_ach_autopay, FALSE) OR coalesce(vendor_autopay, FALSE);
  IF NEW.status IN ('approved', 'awaiting_approval') THEN NEW.status := 'conversion_review'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ap_invoices_opening_ap_defaults ON ap_invoices;
CREATE TRIGGER trg_ap_invoices_opening_ap_defaults BEFORE INSERT ON ap_invoices
  FOR EACH ROW EXECUTE FUNCTION ap_invoices_opening_ap_defaults();

COMMIT;
