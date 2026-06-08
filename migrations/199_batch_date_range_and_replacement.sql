-- ============================================================================
-- 199_batch_date_range_and_replacement.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Auto-overlap detection for transaction upload batches.
--
-- USE CASE:
-- Operator uploads a monthly Vantaca export in June covering Jan-Jun. Then
-- uploads July's YTD export covering Jan-Jul. Both contain Jan-Jun data,
-- which would double-count on the portal balance.
--
-- FIX (this migration + extractor change):
-- Track each batch's transaction date range. When a new batch commits,
-- auto-revert any prior committed batches whose date ranges overlap
-- — they've been "replaced" by the new one. Views already filter
-- reverted batches out, so the portal shows the new truth automatically.
--
-- NEW COLUMNS:
--   min_transaction_date  — earliest transaction date in this batch
--   max_transaction_date  — latest transaction date in this batch
--   replaced_by_batch_id  — when reverted by overlap, points to the
--                           successor. Lets the operator trace what
--                           replaced this batch.
-- ============================================================================

BEGIN;

ALTER TABLE transaction_upload_batches
  ADD COLUMN IF NOT EXISTS min_transaction_date DATE,
  ADD COLUMN IF NOT EXISTS max_transaction_date DATE,
  ADD COLUMN IF NOT EXISTS replaced_by_batch_id UUID
    REFERENCES transaction_upload_batches(id) ON DELETE SET NULL;

COMMENT ON COLUMN transaction_upload_batches.min_transaction_date IS
  'Earliest transaction_date in this batch. Used for overlap detection on new uploads.';
COMMENT ON COLUMN transaction_upload_batches.max_transaction_date IS
  'Latest transaction_date in this batch. Used for overlap detection on new uploads.';
COMMENT ON COLUMN transaction_upload_batches.replaced_by_batch_id IS
  'When status=reverted because a newer overlapping batch arrived, points to the successor.';

-- Backfill existing batches from their child rows.
UPDATE transaction_upload_batches b
SET min_transaction_date = sub.min_date,
    max_transaction_date = sub.max_date
FROM (
  SELECT source_batch_id,
         MIN(transaction_date) AS min_date,
         MAX(transaction_date) AS max_date
  FROM homeowner_transactions
  GROUP BY source_batch_id
) sub
WHERE b.id = sub.source_batch_id
  AND (b.min_transaction_date IS NULL OR b.max_transaction_date IS NULL);

-- Partial index for fast overlap lookups by community + active state.
CREATE INDEX IF NOT EXISTS idx_txn_batches_overlap_lookup
  ON transaction_upload_batches(community_id, min_transaction_date, max_transaction_date)
  WHERE status = 'committed';

COMMIT;
