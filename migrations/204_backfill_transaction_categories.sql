-- ============================================================================
-- 204_backfill_transaction_categories.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Backfill charge_category for existing homeowner_transactions
-- rows (966 Quail Ridge ledger lines as of this writing) using description
-- pattern matching. Mirrors lib/ar/categorize.js patterns in SQL so the
-- backfill stays in-database (no Node round-trips for ~1000 rows).
--
-- Idempotent: only updates rows where charge_category IS NULL. Re-runnable.
-- Operator overrides (manually set categories) are preserved.
-- ============================================================================

BEGIN;

-- Order matters — most specific patterns first. Same order as
-- lib/ar/categorize.js CATEGORY_PATTERNS.

-- Prior balance
UPDATE homeowner_transactions SET charge_category = 'prior_balance'
WHERE charge_category IS NULL
  AND description ~* '\m(prior\s+balance|opening\s+balance|brought\s+forward|carry\s+over)\M';

-- Assessments (catches all variants because the broader pattern is last)
UPDATE homeowner_transactions SET charge_category = 'assessment'
WHERE charge_category IS NULL
  AND (description ~* '\massessment\M' OR description ~* '\mdues\M');

-- Late fees
UPDATE homeowner_transactions SET charge_category = 'late_fee'
WHERE charge_category IS NULL
  AND (description ~* '\mlate\s+fee' OR description ~* '\mlf\s*charge');

-- Interest (after late_fee so "late interest" doesn't get caught as late_fee)
UPDATE homeowner_transactions SET charge_category = 'interest'
WHERE charge_category IS NULL
  AND description ~* '\minterest\M';

-- Attorney / legal fees
UPDATE homeowner_transactions SET charge_category = 'attorney_fee'
WHERE charge_category IS NULL
  AND (description ~* '\mattorney\s+fee'
       OR description ~* '\mlegal\s+fee'
       OR description ~* '\mcollection\s+fee');

-- Admin / processing fees
UPDATE homeowner_transactions SET charge_category = 'admin_fee'
WHERE charge_category IS NULL
  AND (description ~* '\mcertified\s+letter'
       OR description ~* '\mcertified\s+mail'
       OR description ~* '\mtransfer\s+fee'
       OR description ~* '\mresale\s+certificate'
       OR description ~* '\mrecords?\s+request'
       OR description ~* '\mestoppel\M'
       OR description ~* '\mnsf\M'
       OR description ~* '\mreturned\s+check');

-- Fines (violation-related)
UPDATE homeowner_transactions SET charge_category = 'fine'
WHERE charge_category IS NULL
  AND (description ~* '\mfine\M'
       OR description ~* '\mviolation\s+fee'
       OR description ~* '\mccr\s+violation'
       OR description ~* '\mdrv\M');

-- Payments
UPDATE homeowner_transactions SET charge_category = 'payment'
WHERE charge_category IS NULL
  AND (description ~* '\m(chk|check)\s*#?\s*\d+'
       OR description ~* '\mach\s+payment'
       OR description ~* '\monline\s+payment'
       OR description ~* '\mpayment\M'
       OR description ~* '\mach\M');

-- Credits + refunds
UPDATE homeowner_transactions SET charge_category = 'refund'
WHERE charge_category IS NULL
  AND description ~* '\mrefund\M';

UPDATE homeowner_transactions SET charge_category = 'credit'
WHERE charge_category IS NULL
  AND (description ~* '\mcredit\M' OR description ~* '\mwrite[\-\s]*off');

-- Adjustments
UPDATE homeowner_transactions SET charge_category = 'adjustment'
WHERE charge_category IS NULL
  AND (description ~* '\madjustment\M' OR description ~* '\madj\M');

-- Final fallback by type/sign
UPDATE homeowner_transactions SET charge_category = 'payment'
WHERE charge_category IS NULL
  AND (txn_type = 'payment' OR amount_cents < 0);

UPDATE homeowner_transactions SET charge_category = 'credit'
WHERE charge_category IS NULL
  AND txn_type = 'credit';

UPDATE homeowner_transactions SET charge_category = 'other'
WHERE charge_category IS NULL;

COMMIT;
