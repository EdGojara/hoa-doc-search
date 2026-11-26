-- ============================================================================
-- 580_assessment_rate_history.sql  (Ed 2026-11-26)
-- ----------------------------------------------------------------------------
-- Seeds the EXISTING per-year rate table, community_assessment_rate_history
-- (migration 465: the adopted annual assessment by fiscal year), for the
-- community configured for builder transfers, so a builder ownership period
-- spanning calendar years is charged each year at that year's rate
-- (lib/accounting/builder_ownership.js). No new table: an earlier draft of
-- this file created a second one; this replaces it before it was ever applied.
--
--   2025 $495.00  2025 budget (Regular Assessment 495.00); 2025 resale demands
--                 ("2025 Annual Assessment in the amount of $495.00")
--   2026 $495.00  the 1/1/2026 annual billing, $495.00 on each owner lot
--
-- Without a row for a year in a builder's period, the closing statement says
-- the rate is unknown and the proration is held (never guessed).
-- Record ownership: association configuration (association_record).
-- No ledger, GL, tenure, ownership or sale row changes.
-- ============================================================================
BEGIN;

INSERT INTO community_assessment_rate_history (community_id, fiscal_year, owner_class, annual_amount_cents, effective_date, source_citation, notes)
SELECT 'a0000000-0000-4000-8000-000000000006', y.fy, 'homeowner', 49500, y.eff, y.cite, 'Seeded by migration 580 for builder ownership proration'
  FROM (VALUES
    (2025, DATE '2025-01-01', '2025 budget: Regular Assessment 495.00; 2025 resale demands: 2025 Annual Assessment $495.00'),
    (2026, DATE '2026-01-01', '1/1/2026 annual billing: Annual Assessment $495.00 on each owner lot')
  ) AS y(fy, eff, cite)
 WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000006')
ON CONFLICT (community_id, fiscal_year, owner_class) DO NOTHING;

COMMIT;
