-- ============================================================================
-- 195_homeowner_transactions.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Mirror per-homeowner transaction history from Vantaca
-- into trustEd so the homeowner portal can show the same "Recent
-- Transactions + Running Balance" experience the Vantaca portal shows.
--
-- ARCHITECTURE:
-- - Vantaca remains the source of truth (per project_owner_receivables.md).
-- - Staff uploads a monthly transaction export per community.
-- - trustEd records the upload BATCH with an "as of" date.
-- - Each row in the export becomes a homeowner_transactions row tied to
--   the community + a vantaca_account_id (which we already store on
--   properties + contacts for the existing AR snapshot ingest).
-- - Homeowner portal displays transactions with a prominent "Financial
--   activity current as of [date]" disclosure — so a payment made after
--   the upload date doesn't surprise the homeowner when it's not visible.
-- - When the next month's batch is uploaded, the "as of" date moves
--   forward and the new transactions append.
--
-- TWO TABLES:
--   transaction_upload_batches — one row per upload (community × period)
--     - period_label (e.g. "May 2026")
--     - as_of_date (the freshness marker shown to homeowners)
--     - row count + account count + status (draft/committed/reverted)
--     - source filename + storage path for audit
--
--   homeowner_transactions — one row per ledger line
--     - vantaca_account_id (canonical key)
--     - property_id + contact_id (best-effort match for joins)
--     - transaction_date, description, type, amount_cents, running_balance_cents
--     - source_batch_id (FK to the upload it came from)
--     - Idempotent within a batch — UNIQUE (batch_id, source_row_index)
--
-- This is interim infrastructure. When trustEd has its own GL, the
-- transactions table becomes the ledger and uploads stop being the
-- ingestion path. The portal display layer stays unchanged.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) transaction_upload_batches — audit trail of every monthly upload
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_upload_batches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id),

  -- Period this batch covers (e.g., "May 2026" or "2026-05")
  period_label             TEXT NOT NULL,

  -- The "financial activity current as of" date shown to homeowners.
  -- Conservatively this is the date the source report was generated.
  -- Default to NOW() when not provided; staff can override.
  as_of_date               DATE NOT NULL,

  -- Source attribution
  source_filename          TEXT,
  source_storage_path      TEXT,
  source_format            TEXT NOT NULL DEFAULT 'csv'
                             CHECK (source_format IN ('csv', 'pdf', 'manual')),

  -- Stats (filled on commit)
  row_count                INTEGER NOT NULL DEFAULT 0,
  account_count            INTEGER NOT NULL DEFAULT 0,
  total_charges_cents      BIGINT,
  total_payments_cents     BIGINT,

  -- Lifecycle
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'committed', 'reverted')),
  uploaded_by              TEXT,                  -- staff email/name (until full auth wired)
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at             TIMESTAMPTZ,
  reverted_at              TIMESTAMPTZ,
  reverted_reason          TEXT,
  notes                    TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_batches_community_period
  ON transaction_upload_batches(community_id, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_batches_status
  ON transaction_upload_batches(status, community_id);

DROP TRIGGER IF EXISTS trg_txn_batches_updated_at ON transaction_upload_batches;
CREATE TRIGGER trg_txn_batches_updated_at
  BEFORE UPDATE ON transaction_upload_batches
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2) homeowner_transactions — one row per ledger line per upload
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS homeowner_transactions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_batch_id          UUID NOT NULL REFERENCES transaction_upload_batches(id) ON DELETE CASCADE,
  source_row_index         INTEGER NOT NULL,      -- original row position in the upload

  community_id             UUID NOT NULL REFERENCES communities(id),

  -- Identity — best-effort match. vantaca_account_id is the canonical key
  -- from Vantaca. property_id + contact_id are resolved at upload time
  -- via the vantaca_account_id lookup on existing tables.
  vantaca_account_id       TEXT NOT NULL,
  property_id              UUID REFERENCES properties(id) ON DELETE SET NULL,
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- The ledger line itself
  transaction_date         DATE NOT NULL,
  description              TEXT NOT NULL,
  txn_type                 TEXT NOT NULL DEFAULT 'charge'
                             CHECK (txn_type IN (
                               'charge',                   -- adds to balance
                               'payment',                  -- reduces balance
                               'credit',                   -- reduces balance (non-payment, e.g., adjustment in homeowner's favor)
                               'adjustment',               -- generic, signed amount
                               'balance_brought_forward'   -- opening balance carry
                             )),
  -- Signed cents. Positive = adds to balance. Negative = reduces.
  amount_cents             BIGINT NOT NULL,
  -- Running balance after this line, as reported on the source. Stored as
  -- captured so we can display exactly what Vantaca shows; verification
  -- queries can recompute.
  running_balance_cents    BIGINT,

  -- Audit
  raw_row_jsonb            JSONB,                 -- the original parsed row for forensics
  notes                    TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: re-uploading the same batch row gives the same row id
  UNIQUE (source_batch_id, source_row_index)
);

CREATE INDEX IF NOT EXISTS idx_txn_community_account_date
  ON homeowner_transactions(community_id, vantaca_account_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_property_date
  ON homeowner_transactions(property_id, transaction_date DESC)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_txn_contact_date
  ON homeowner_transactions(contact_id, transaction_date DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_txn_batch
  ON homeowner_transactions(source_batch_id);

-- ----------------------------------------------------------------------------
-- 3) View: v_homeowner_current_balance — sum of all committed transactions
--    per (community, vantaca_account_id). Used by the portal balance tile.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_homeowner_current_balance CASCADE;
CREATE VIEW v_homeowner_current_balance AS
SELECT
  t.community_id,
  t.vantaca_account_id,
  t.property_id,
  t.contact_id,
  SUM(t.amount_cents) AS balance_cents,
  MAX(t.transaction_date) AS most_recent_txn_date,
  COUNT(*) AS txn_count
FROM homeowner_transactions t
INNER JOIN transaction_upload_batches b ON b.id = t.source_batch_id
WHERE b.status = 'committed'
GROUP BY t.community_id, t.vantaca_account_id, t.property_id, t.contact_id;

GRANT SELECT ON v_homeowner_current_balance TO service_role;

-- ----------------------------------------------------------------------------
-- 4) View: v_community_freshness — latest committed batch per community.
--    Drives the "Financial activity current as of [date]" disclosure.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_community_transaction_freshness CASCADE;
CREATE VIEW v_community_transaction_freshness AS
SELECT DISTINCT ON (community_id)
  community_id,
  id AS batch_id,
  period_label,
  as_of_date,
  committed_at,
  row_count,
  account_count
FROM transaction_upload_batches
WHERE status = 'committed'
ORDER BY community_id, as_of_date DESC, committed_at DESC;

GRANT SELECT ON v_community_transaction_freshness TO service_role;

COMMIT;
