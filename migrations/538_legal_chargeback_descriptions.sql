-- ============================================================================
-- 538_legal_chargeback_descriptions.sql  (Ed 2026-10-20)
-- ----------------------------------------------------------------------------
-- Descriptive-metadata correction for the five homeowner legal chargebacks
-- posted by Approve Treatment on 2026-10-11/12 (the only rows with
-- raw_row_jsonb.source = 'legal_invoice_review'). They read
--   "Legal Fees - Collections / 283101"
-- with no service description and no "invoice" label, and carry no tenure_id
-- (they reach the owner ledger only through the Vantaca-account fallback).
--
-- Each row gets the wording lib/legal/review_suggest.js ownerDescription now
-- produces for new postings: category, a fixed catalogue service phrase (never
-- the attorney's line text, which names owners and case detail), and the
-- attorney's actual invoice reference. Values were computed by that function
-- from each posting's own invoice item and are listed literally below.
--
-- Changes ONLY three columns of these five homeowner_transactions rows:
-- description, raw_row_jsonb (keys added, none removed) and tenure_id (filled
-- where NULL with the owner the charge was approved against).
--
-- Owner link: tenure_id is set to the posting's tenure only when the approved
-- allocation, the posting and the property's one current owner tenure are the
-- same tenure for the same property, at the approved review revision and the
-- same amount. Any mismatch leaves the row completely untouched, and the verify
-- step (all five, or nothing) then refuses and rolls the migration back, so a
-- mismatch is never half-applied. Each update is also guarded on the exact old
-- description and amount, so a re-run changes nothing.
--
-- Never touches: amount_cents, running_balance_cents, transaction_date,
-- charge_category, txn_type, contact_id, the upload batch (its internal
-- period_label keeps the old wording; no reader shows it to owners), any
-- journal entry, posting, allocation, review or ownership tenure.
-- No row is inserted or deleted.
--
-- Record ownership: association_record (owner ledger); unchanged by this.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE _m538 (
  ht_id uuid PRIMARY KEY, posting_id uuid NOT NULL, amount_cents bigint NOT NULL,
  old_description text NOT NULL, new_description text NOT NULL,
  invoice_ref text NOT NULL, service_phrase text NOT NULL
) ON COMMIT DROP;

INSERT INTO _m538 VALUES
  ('14286fec-5e96-4644-8f40-8c625403ae0b', 'd8fee4ab-99c5-42b7-bc53-f278c475ee42', 100800,
   'Legal Fees - Collections / 283101', 'Legal Fees - Collections: Court filings and documents (Attorney Inv. 283101)', '283101', 'Court filings and documents'),
  ('513cfe4b-0538-499f-bdf1-6b4e69ad8ee2', 'ca76081f-fcc7-417a-8ab6-ca9ea5be7367', 3200,
   'Legal Fees - Collections / 283101', 'Legal Fees - Collections: Payment processing (Attorney Inv. 283101)', '283101', 'Payment processing'),
  ('e4c92b73-f31c-422a-9804-35edba863dbc', 'f14551ab-fd11-438c-b85c-9962081a7ba9', 3200,
   'Legal Fees - Collections / 283101', 'Legal Fees - Collections: Payment processing (Attorney Inv. 283101)', '283101', 'Payment processing'),
  ('e9195994-6fb8-41c5-b6d6-97f15e413516', '06648940-dc76-4f79-a76e-8e6f50f63331', 6800,
   'Legal Fees - Collections / 283101', 'Legal Fees - Collections: Payment plan administration and payment processing (Attorney Inv. 283101)', '283101', 'Payment plan administration and payment processing'),
  ('5fce468b-9bc0-4109-8cf8-158ae5be7733', 'e8a7c83c-2c1b-4075-a929-ebecae812036', 55735,
   'Legal Fees - DRV Enforcement / PS-INV350881', 'Legal Fees - DRV Enforcement: Attorney services and court costs (Attorney Inv. PS-INV350881)', 'PS-INV350881', 'Attorney services and court costs');

UPDATE homeowner_transactions h
   SET description = m.new_description,
       tenure_id = p.tenure_id,
       raw_row_jsonb = COALESCE(h.raw_row_jsonb, '{}'::jsonb) || jsonb_build_object(
         'legal_invoice_item_id', p.item_id,
         'legal_allocation_id', p.allocation_id,
         'attorney_invoice_number', m.invoice_ref,
         'attorney_reference_missing', false,
         'service_phrase', m.service_phrase,
         'description_version', 2,
         'description_corrected_by', '538_legal_chargeback_descriptions',
         'previous_description', m.old_description)
  FROM _m538 m
  JOIN legal_invoice_postings p    ON p.id = m.posting_id
  JOIN legal_invoice_allocations a ON a.id = p.allocation_id
  JOIN legal_invoice_reviews r     ON r.id = p.review_id
  JOIN ownership_tenures t         ON t.id = p.tenure_id
 WHERE h.id = m.ht_id
   AND h.raw_row_jsonb->>'source' = 'legal_invoice_review'
   AND h.description = m.old_description
   AND h.amount_cents = m.amount_cents
   -- the posting that created this charge, as approved
   AND p.homeowner_transaction_id = h.id AND p.status = 'posted'
   AND p.property_id = h.property_id AND p.amount_cents = h.amount_cents
   AND r.status = 'approved' AND p.review_revision = r.approved_revision
   AND a.is_active AND a.revision = r.approved_revision
   AND a.classification = 'homeowner_recoverable'
   AND a.property_id = h.property_id AND a.amount_cents = h.amount_cents
   -- the owner approved is the owner posted, and still the current owner
   AND a.tenure_id = p.tenure_id
   AND t.property_id = h.property_id AND t.kind = 'owner' AND t.end_date IS NULL
   AND (h.tenure_id IS NULL OR h.tenure_id = p.tenure_id);

COMMIT;
