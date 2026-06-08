-- ============================================================================
-- 203_transaction_charge_categories.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Account balance composition tracking. Without this,
-- amenity access decisions are based on raw balance, which is the legal
-- failure mode — associations have been sued for wrongly denying pool /
-- clubhouse access based on a balance that was actually all fines (not
-- delinquent assessments).
--
-- LEGAL RULES (Texas + general HOA case law):
--   - Assessment past-due + no payment plan → may deny amenity access
--   - Fines / late fees / attorney fees ALONE → cannot deny access
--   - Past-due assessment + active payment plan (current on plan) → cannot deny
--   - In bankruptcy → don't deny (stay protection + sensitivity)
--
-- THIS TABLE STORES the CATEGORY of each ledger line so we can compute
-- 'amount past-due in assessments' separately from 'amount past-due in fines.'
--
-- CATEGORIES:
--   assessment      — annual/monthly/special assessment (drives amenity denial)
--   late_fee        — late fees on assessments (rolls into assessment bucket)
--   interest        — interest on past-due assessment
--   fine            — covenant violation fine (does NOT drive amenity denial)
--   attorney_fee    — attorney/legal fee (does NOT drive amenity denial)
--   admin_fee       — certified letter, processing, transfer fee (does not)
--   payment         — payment in (signed negative)
--   credit          — credit memo / refund (signed negative)
--   refund          — refund (signed negative)
--   adjustment      — generic write-off / adjustment
--   prior_balance   — opening balance carry forward (categorize at backfill)
--   other           — unknown / not yet categorized
-- ============================================================================

BEGIN;

ALTER TABLE homeowner_transactions
  ADD COLUMN IF NOT EXISTS charge_category TEXT
    CHECK (charge_category IS NULL OR charge_category IN (
      'assessment', 'late_fee', 'interest',
      'fine', 'attorney_fee', 'admin_fee',
      'payment', 'credit', 'refund',
      'adjustment', 'prior_balance', 'other'
    ));

CREATE INDEX IF NOT EXISTS idx_txn_charge_category
  ON homeowner_transactions(community_id, vantaca_account_id, charge_category)
  WHERE charge_category IS NOT NULL;

COMMENT ON COLUMN homeowner_transactions.charge_category IS
  'Legal-grade categorization of the ledger line. Drives amenity access decisions (assessments-only trigger denial; fines do not). Populated at import time via lib/ar/categorize.js OR backfilled from description matching. Operator can override via the AR ledger UI.';

-- ----------------------------------------------------------------------------
-- View: v_homeowner_balance_composition — current balance broken out
-- by charge category per (community, vantaca_account_id). Powers the
-- amenity-access decision and the operator UI breakdown display.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_homeowner_balance_composition CASCADE;
CREATE VIEW v_homeowner_balance_composition AS
SELECT
  t.community_id,
  t.vantaca_account_id,
  t.property_id,
  t.contact_id,
  COALESCE(t.charge_category, 'other') AS charge_category,
  SUM(t.amount_cents) AS amount_cents,
  COUNT(*) AS txn_count,
  MIN(t.transaction_date) AS earliest_txn_date,
  MAX(t.transaction_date) AS latest_txn_date
FROM homeowner_transactions t
INNER JOIN transaction_upload_batches b ON b.id = t.source_batch_id
WHERE b.status = 'committed'
GROUP BY t.community_id, t.vantaca_account_id, t.property_id, t.contact_id, COALESCE(t.charge_category, 'other');

GRANT SELECT ON v_homeowner_balance_composition TO service_role, authenticated;

COMMIT;
