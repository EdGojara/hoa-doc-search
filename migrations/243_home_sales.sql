-- ============================================================================
-- 243_home_sales.sql
-- ----------------------------------------------------------------------------
-- Home Sales — the resale lifecycle for a property, tracked as ONE row that
-- moves through two real-world events:
--
--   PART 1  Resale request (pre-closing). HomeWise (or title/agent) emails to
--           order the resale package. Bedrock responds with the DRV/violation
--           status, a fresh inspection, and the current balance (+ disclosures).
--           NO ownership change — the sale hasn't happened.
--
--   PART 2  Closing (post-closing). The title company's physical mail + transfer-
--           fee check arrives; we scan it. NOW ownership transitions (seller ->
--           buyer on the closing date via approve_ownership_proposal), we verify
--           the seller's final balance cleared to zero, and record the fees to
--           deposit.
--
-- Ownership history itself lives in property_ownerships (start/end dates); this
-- table is the sale's case file and links to the ownership_change_proposal that
-- actually moves the record at closing.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS home_sales (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                uuid NOT NULL REFERENCES communities(id),
  property_id                 uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  status                      text NOT NULL DEFAULT 'requested'
                                CHECK (status IN ('requested', 'disclosed', 'closed', 'cancelled')),

  -- PART 1 — resale disclosure request -------------------------------------
  request_received_at         date,
  request_source              text CHECK (request_source IN ('homewise', 'title_company', 'agent', 'other')),
  requested_by                text,                 -- ordering party (company / person)
  seller_contact_id           uuid REFERENCES contacts(id) ON DELETE SET NULL,
  seller_name                 text,                 -- snapshot of the owner of record at request

  -- disclosure response (read from existing modules at request time)
  drv_clean                   boolean,              -- true = no open violations
  open_violations_count       integer,
  worst_open_stage            text,
  inspection_id               uuid,                 -- link to a fresh inspection (nullable)
  inspection_status           text,                 -- 'pending' | 'complete' | 'n/a'
  balance_cents               bigint,               -- balance disclosed to title
  balance_as_of_date          date,                 -- the AR snapshot / GL date
  disclosures_sent_at         date,
  disclosures_sent_to         text,

  -- PART 2 — closing -------------------------------------------------------
  closing_notice_received_at  date,
  closing_date                date,
  buyer_name                  text,
  buyer_email                 text,
  buyer_mailing_address       text,
  buyer_contact_id            uuid REFERENCES contacts(id) ON DELETE SET NULL,
  transfer_fee_cents          bigint,               -- capital contribution to the association (the check to deposit)
  management_transfer_fee_cents bigint,             -- Bedrock's transfer fee
  seller_final_balance_cents  bigint,               -- captured at closing — must be 0 (proves it cleared)
  source_document_id          uuid,                 -- scanned closing packet (library_documents)
  raw_extraction              jsonb,                -- the AI parse of the scanned mail
  ownership_proposal_id       uuid REFERENCES ownership_change_proposals(id) ON DELETE SET NULL,
  ownership_updated_at        timestamptz,

  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_home_sales_community ON home_sales (community_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_home_sales_property ON home_sales (property_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_home_sales_updated_at ON home_sales;
CREATE TRIGGER trg_home_sales_updated_at
  BEFORE UPDATE ON home_sales
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON home_sales TO service_role;

COMMIT;
