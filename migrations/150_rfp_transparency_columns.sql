-- ============================================================================
-- 150_rfp_transparency_columns.sql
-- ----------------------------------------------------------------------------
-- RFP / bid transparency engine — schema additions for the workflow Ed
-- described 2026-06-02:
--
--   "I want to make sure we have transparency around all those bids
--    and reasons we dropped them from top 3."
--
-- Translates to a structural answer rather than a tribal one: every bid
-- received against an RFP is captured with extracted structured data;
-- every elimination from the finalist set is timestamped, signed, and
-- given a reason; the board memo PDF renders the full "bids considered
-- and not recommended" trail as the last page so transparency is shipped
-- with the recommendation, not promised verbally.
--
-- Existing schema (migrations 009 + 015) gave us vendor_proposals (with
-- outcome + outcome_notes) and bid_requests + vendor_service_categories.
-- This adds the columns specifically needed for:
--
--   1. Per-bid AI-extracted structured data (scope items, insurance,
--      pricing breakdown) — extracted_data JSONB on vendor_proposals
--   2. Explicit elimination tracking — is_finalist BOOLEAN +
--      eliminated_at / eliminated_by / eliminated_reason
--   3. RFP-level scoping — community_id + title + status on bid_requests
--      so the same physical PDF can be tied to a specific community RFP
--   4. Audit table — rfp_decision_log captures every state change so
--      operator can't rewrite history. One row per action (mark finalist,
--      eliminate, reset). Includes a before/after snapshot.
--
-- Idempotent. Apply after 149.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) vendor_proposals: per-bid AI extraction + finalist/elimination state
-- ----------------------------------------------------------------------------
ALTER TABLE vendor_proposals
  ADD COLUMN IF NOT EXISTS bid_request_id        UUID REFERENCES bid_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS community_id          UUID REFERENCES communities(id),
  ADD COLUMN IF NOT EXISTS proposer_company_name TEXT,           -- denorm for sort + display
  ADD COLUMN IF NOT EXISTS extracted_data        JSONB,          -- full AI extraction: scope, pricing, insurance, certs, references
  ADD COLUMN IF NOT EXISTS total_annual_amount   NUMERIC(12, 2), -- denorm for sort/comparison
  ADD COLUMN IF NOT EXISTS term_months           INTEGER,
  ADD COLUMN IF NOT EXISTS is_finalist           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS eliminated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eliminated_by         TEXT,
  ADD COLUMN IF NOT EXISTS eliminated_reason     TEXT;

COMMENT ON COLUMN vendor_proposals.is_finalist        IS 'TRUE when this bid is in the recommended-to-board set (max 3 per RFP).';
COMMENT ON COLUMN vendor_proposals.eliminated_at      IS 'When the operator removed this bid from consideration. NULL = still under consideration.';
COMMENT ON COLUMN vendor_proposals.eliminated_reason  IS 'Operator-signed reason for removing this bid (e.g., "No GL insurance certificate", "References negative"). Required when eliminating — see api/vendors.js PATCH endpoint.';
COMMENT ON COLUMN vendor_proposals.extracted_data     IS 'AI-extracted structured bid data. Shape: { scope_items: [{name, included, frequency, notes}], insurance_policies: [{type, limit, expires_at}], license_numbers: [...], references: [...], pricing_breakdown: {...} }';

CREATE INDEX IF NOT EXISTS idx_vp_bid_request_status
  ON vendor_proposals(bid_request_id, is_finalist, eliminated_at);

CREATE INDEX IF NOT EXISTS idx_vp_community_category
  ON vendor_proposals(community_id, service_category);

-- ----------------------------------------------------------------------------
-- 2) bid_requests: community scoping + title/status for the RFP envelope
-- ----------------------------------------------------------------------------
ALTER TABLE bid_requests
  ADD COLUMN IF NOT EXISTS community_id     UUID REFERENCES communities(id),
  ADD COLUMN IF NOT EXISTS service_category TEXT REFERENCES vendor_service_categories(category),
  ADD COLUMN IF NOT EXISTS title            TEXT,
  ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'collecting', 'evaluating', 'recommended', 'awarded', 'cancelled'));

COMMENT ON COLUMN bid_requests.status IS 'draft = not yet sent / accepting bids; collecting = bids coming in; evaluating = finalist selection in progress; recommended = board memo drafted; awarded = winning bid converted to contract; cancelled = RFP withdrawn.';

CREATE INDEX IF NOT EXISTS idx_br_community_status
  ON bid_requests(community_id, status);

-- ----------------------------------------------------------------------------
-- 3) rfp_decision_log: immutable audit trail of every elimination/finalist
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (delivered to the board as part of
-- the memo audit appendix; the board owns the RFP decision record after
-- the meeting). Discussed in CLAUDE.md record-ownership table.
CREATE TABLE IF NOT EXISTS rfp_decision_log (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bid_request_id      UUID NOT NULL REFERENCES bid_requests(id) ON DELETE CASCADE,
  proposal_id         UUID NOT NULL REFERENCES vendor_proposals(id) ON DELETE CASCADE,
  action              TEXT NOT NULL CHECK (action IN ('mark_finalist', 'eliminate', 'reset', 'reorder')),
  reason              TEXT,
  operator            TEXT,                          -- staff identifier (email / name)
  before_state        JSONB,                         -- snapshot of relevant fields before change
  after_state         JSONB,                         -- snapshot after
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE rfp_decision_log IS 'Immutable audit trail of every finalist/elimination decision per RFP. Written by the PATCH /api/vendors/proposals/:id endpoint. Powers the "Bids Considered and Not Recommended" page on the board memo PDF — every row here renders to a line on that page, with the operator + reason visible to the board.';

CREATE INDEX IF NOT EXISTS idx_rfp_log_bid_request
  ON rfp_decision_log(bid_request_id, created_at);

GRANT SELECT, INSERT ON rfp_decision_log TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name='vendor_proposals'
--   AND column_name IN ('is_finalist','eliminated_at','eliminated_reason','extracted_data');
--
-- SELECT * FROM rfp_decision_log LIMIT 5;
