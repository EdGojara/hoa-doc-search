-- ============================================================================
-- 580_assessment_rate_history.sql  (Ed 2026-11-26)
-- ----------------------------------------------------------------------------
-- The annual assessment for EACH assessment year, so a builder's ownership
-- period that spans calendar years is charged each year at that year's rate
-- (lib/accounting/builder_ownership.js). community_assessment_rates stays the
-- one current rate; this table records what each year's rate WAS, with its
-- evidence. One row per (community, owner class, fiscal year).
--
-- Without a row for a year in a builder's period, the closing statement says
-- "assessment rate unknown" and the proration is held (never guessed).
--
-- Seeds the community configured for builder transfers (migration 500):
--   2025 $495.00  evidence: 2025 budget (Regular Assessment 495.00) and the
--                 2025 resale demands ("2025 Annual Assessment in the amount of
--                 $495.00")
--   2026 $495.00  evidence: the 1/1/2026 annual billing, 321 lots at $495.00
--
-- Record ownership: association configuration (association_record).
-- No ledger, GL, tenure, ownership or sale row changes.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS community_assessment_rate_history (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  owner_class          text NOT NULL DEFAULT 'homeowner' CHECK (owner_class IN ('homeowner')),
  fiscal_year          int  NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  annual_amount_cents  bigint NOT NULL CHECK (annual_amount_cents >= 0),
  evidence             text NOT NULL,
  created_by           text NOT NULL DEFAULT 'migration',
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_assessment_rate_history_one_per_year UNIQUE (community_id, owner_class, fiscal_year)
);
GRANT SELECT, INSERT, UPDATE ON community_assessment_rate_history TO service_role;
GRANT SELECT ON community_assessment_rate_history TO authenticated;

INSERT INTO community_assessment_rate_history (community_id, owner_class, fiscal_year, annual_amount_cents, evidence)
SELECT 'a0000000-0000-4000-8000-000000000006', 'homeowner', y.fy, 49500, y.ev
  FROM (VALUES
    (2025, '2025 budget: Regular Assessment 495.00; 2025 resale demands: 2025 Annual Assessment $495.00'),
    (2026, '1/1/2026 annual billing: Annual Assessment $495.00 on each owner lot')
  ) AS y(fy, ev)
 WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000006')
ON CONFLICT ON CONSTRAINT community_assessment_rate_history_one_per_year DO NOTHING;

COMMIT;
