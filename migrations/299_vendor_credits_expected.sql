-- ============================================================================
-- 299_vendor_credits_expected.sql  (Ed 2026-07-15)
-- ----------------------------------------------------------------------------
-- A credit a vendor OWES us, captured the moment it's promised — so it can't be
-- forgotten at the moment we pay them.
--
-- The case that forced it: Waterview's pool and splash pad were closed 6/26/2026
-- after an inspector found chlorine below threshold — Swim Houston's
-- responsibility. A board member wrote "that's three days of guards we shouldn't
-- be paying for," and Ed got Matt to agree to credit the HOA for the lifeguard
-- time. That agreement lived in ONE email thread. Meanwhile two Swim Houston
-- invoices ($11,064.87 and $8,334.00) sat in the approval queue with nothing
-- connecting them to the promise. Release them and the credit evaporates — we
-- pay full price for three days of lifeguards we never got, and nobody ever
-- knows. That is the silent-failure class: the money is lost quietly and the
-- books look fine.
--
-- Ed's ask: "forward this to Emma and say please make sure we get credit for
-- this on the Swim Houston bill." This is what makes that instruction real —
-- the promise becomes a CONTROL on the vendor's next invoice, not a memory.
--
-- Record ownership: association_record. A credit owed to the HOA is the HOA's,
-- and it must survive a management change (see CLAUDE.md record-ownership).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vendor_credits_expected (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  vendor_id            UUID,                          -- may be unresolved at capture time
  vendor_name          TEXT,                          -- what we know to call them
  reason               TEXT NOT NULL,                 -- "3 days lifeguard time, pool closed 6/26-6/29"
  expected_cents       BIGINT,                        -- NULL when the amount isn't known yet
  service_period_start DATE,
  service_period_end   DATE,

  -- Provenance: WHERE the promise came from. An expected credit with no source
  -- is a rumor; a vendor will ask "who said that."
  source_email_id      UUID,                          -- email_messages.id
  source_ref           TEXT,                          -- e.g. 'email:<graph_id>'
  source_quote         TEXT,                          -- the sentence that promised it
  requested_by         TEXT,                          -- who flagged it

  status               TEXT NOT NULL DEFAULT 'expected'
                         CHECK (status IN ('expected', 'applied', 'waived', 'disputed')),
  applied_invoice_id   UUID REFERENCES ap_invoices(id) ON DELETE SET NULL,
  applied_cents        BIGINT,
  applied_at           TIMESTAMPTZ,
  applied_by           TEXT,
  resolution_notes     TEXT,

  record_ownership     TEXT NOT NULL DEFAULT 'association_record'
                         CHECK (record_ownership IN ('association_record', 'workpaper', 'mixed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot path: "does this vendor owe this community anything?" asked on every
-- invoice review.
CREATE INDEX IF NOT EXISTS idx_vendor_credits_open
  ON vendor_credits_expected (community_id, vendor_id)
  WHERE status = 'expected';
CREATE INDEX IF NOT EXISTS idx_vendor_credits_vendor_name
  ON vendor_credits_expected (community_id, lower(vendor_name))
  WHERE status = 'expected';

DROP TRIGGER IF EXISTS trg_vendor_credits_updated_at ON vendor_credits_expected;
CREATE TRIGGER trg_vendor_credits_updated_at
  BEFORE UPDATE ON vendor_credits_expected
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_credits_expected TO service_role;
GRANT SELECT                          ON vendor_credits_expected TO authenticated;

COMMIT;
