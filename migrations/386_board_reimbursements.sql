-- ============================================================================
-- 386 — Board / committee member reimbursements.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-25: a board or committee member sometimes pays for something on
-- the association's behalf and needs to be reimbursed. The RECEIPT is from the
-- real store (Home Depot), the expense codes to the normal GL account, but the
-- PAYABLE is to the board member, not the store, because the store was already
-- paid at the register.
--
-- The AP model requires every payable to have a vendor_id, so the reimbursee is
-- represented as a PAYEE — a vendors row flagged kind='reimbursement'. That
-- flag keeps them out of the vendor directory, pricing intelligence, vendor
-- performance, and 1099s (reimbursing an expense is not reportable income). The
-- accounting is otherwise identical to any bill: Dr expense / Cr AP at intake,
-- Dr AP / Cr operating cash at payment. Only the payee and a source reference
-- differ, so createInvoice and the whole approval + check pipeline are reused.
--
-- CONTROL: paying a board member is a related-party transaction. It NEVER
-- auto-pays; it always routes to approval. reimbursement_board_approval_over_cents
-- lets a community require BOARD sign-off above a threshold while smaller
-- receipts clear on manager approval.
--
-- Record ownership: association_record (these are the association's payables and
-- its correspondence with its own board members).
-- ============================================================================
BEGIN;

-- A vendors row can be a real vendor or a reimbursement payee (a person).
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'vendor'
    CHECK (kind IN ('vendor', 'reimbursement')),
  -- Optional link to the board/committee member being reimbursed, when we can
  -- resolve them to a contact. Name on the check still comes from payee_name.
  ADD COLUMN IF NOT EXISTS reimbursee_contact_id UUID REFERENCES contacts(id);

COMMENT ON COLUMN vendors.kind IS
  'vendor = a real vendor; reimbursement = a payee that is a board/committee member being reimbursed for an out-of-pocket association expense. Reimbursement payees are excluded from the vendor directory, pricing intelligence, and 1099s.';

CREATE INDEX IF NOT EXISTS vendors_reimbursement_idx
  ON vendors (management_company_id) WHERE kind = 'reimbursement';

-- The actual store/vendor from the receipt, kept as a reference on the payable
-- so the audit trail shows WHAT was bought even though the payee is the person.
ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS reimbursement_source TEXT;

COMMENT ON COLUMN ap_invoices.reimbursement_source IS
  'For a reimbursement payable, the real store/vendor named on the receipt (e.g. "Home Depot"). The payable itself is to the reimbursement payee (vendors.kind=reimbursement); this preserves what was actually purchased.';

-- Above this amount, a reimbursement needs BOARD approval, not just manager
-- approval. NULL = manager approval always (the default). Set per community.
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS reimbursement_board_approval_over_cents INTEGER;

COMMENT ON COLUMN communities.reimbursement_board_approval_over_cents IS
  'Reimbursements to a board/committee member above this amount require board sign-off, not just manager approval. NULL = manager approval always.';

COMMIT;

-- New columns in tables PostgREST already caches: reload so nested selects that
-- ask for them do not silently return without them.
NOTIFY pgrst, 'reload schema';
