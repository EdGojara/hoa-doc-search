-- ============================================================================
-- 232_ar_account_collections.sql
-- ----------------------------------------------------------------------------
-- Per-account collection state + bankruptcy tracking for the AR subledger.
--
-- Record ownership: association_record. This is the HOA's collection record
-- (where each delinquent owner sits in the escalation ladder, and the
-- bankruptcy petition data). One row per AR account (property).
--
-- Why bankruptcy fields live here: once an owner files, the petition date is a
-- hard legal line. Pre-petition debt is frozen by the automatic stay
-- (11 U.S.C. 362) and resolved through the bankruptcy estate; post-petition
-- assessments are the debtor's ongoing obligation and remain collectible.
-- The petition date is stored ONCE here; the pre/post-petition ledger split is
-- DERIVED at read time (charge_date < petition_date => pre-petition), so there
-- is a single source of truth and the split can never drift from the date.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ar_account_collections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id              UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id               UUID NOT NULL REFERENCES properties(id)  ON DELETE CASCADE,

  -- Where the owner sits in the collection escalation ladder.
  collection_status         TEXT NOT NULL DEFAULT 'none'
                              CHECK (collection_status IN (
                                'none','late_notice','delinquent_reminder','certified_demand',
                                'board_review','payment_plan','with_attorney','bankruptcy',
                                'lien_filed','foreclosure','written_off'
                              )),
  status_since              DATE,

  -- Bankruptcy (populated when collection_status = 'bankruptcy').
  bankruptcy_petition_date  DATE,
  bankruptcy_chapter        TEXT CHECK (bankruptcy_chapter IS NULL OR bankruptcy_chapter IN ('7','11','12','13')),
  bankruptcy_case_number    TEXT,
  bankruptcy_discharge_date DATE,
  bankruptcy_dismissed_date DATE,

  notes                     TEXT,
  record_ownership          TEXT NOT NULL DEFAULT 'association_record',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (community_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_ar_acct_coll_community ON ar_account_collections(community_id);
CREATE INDEX IF NOT EXISTS idx_ar_acct_coll_active    ON ar_account_collections(community_id, collection_status)
  WHERE collection_status <> 'none';

DROP TRIGGER IF EXISTS trg_ar_acct_coll_updated ON ar_account_collections;
CREATE TRIGGER trg_ar_acct_coll_updated BEFORE UPDATE ON ar_account_collections
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Service role does all server-side writes; without explicit grants every
-- INSERT/UPDATE fails with "permission denied for table" (scar: migrations
-- 168/195/231). State them, never assume.
GRANT SELECT, INSERT, UPDATE, DELETE ON ar_account_collections TO service_role;
GRANT SELECT                          ON ar_account_collections TO authenticated;

COMMIT;
