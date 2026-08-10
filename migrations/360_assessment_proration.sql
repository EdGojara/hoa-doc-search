-- ============================================================================
-- 360_assessment_proration.sql
-- ----------------------------------------------------------------------------
-- Prorated assessments at a property transfer (Ed 2026-08-10). Still Creek Ranch
-- and August Meadows take on new payers mid-year through three kinds of transfer,
-- each treated differently:
--   developer_to_builder   -> new prorated charge at the BUILDER rate
--   builder_to_homeowner   -> new prorated charge at the HOMEOWNER rate (first sale)
--   owner_resale           -> NO new HOA charge (the year's assessment is already
--                             billed to the property; title prorates on the closing
--                             statement). Ownership + balance transfer only.
-- Proration is daily: annual * remaining_days_in_year / days_in_year, from the
-- transfer date to year-end. Matches the one-off August Meadows script
-- (224/365 * $400 = $245.48 from 2026-05-21).
--
-- Two tables:
--   community_assessment_rates — the annual rate per community per owner class,
--     so the tool pulls the right number instead of staff re-typing it.
--   assessment_prorations      — the audit log of every proration run (incl. the
--     posted ar_charge), which also lets the tool refuse to double-charge a lot.
--
-- Record ownership: association_record (financial obligations of the HOA).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS community_assessment_rates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  owner_class          TEXT NOT NULL CHECK (owner_class IN ('builder', 'homeowner')),
  annual_amount_cents  INTEGER NOT NULL CHECK (annual_amount_cents >= 0),
  -- Proration runs from the transfer date to this month/day of the transfer year.
  -- Default Dec 31 (calendar year); stored per rate for a non-calendar fiscal year.
  fiscal_year_end_mmdd TEXT NOT NULL DEFAULT '12-31',
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, owner_class)
);

DROP TRIGGER IF EXISTS trg_assessment_rates_updated_at ON community_assessment_rates;
CREATE TRIGGER trg_assessment_rates_updated_at
  BEFORE UPDATE ON community_assessment_rates
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON community_assessment_rates TO service_role;
GRANT SELECT                         ON community_assessment_rates TO authenticated;

CREATE TABLE IF NOT EXISTS assessment_prorations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id           UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id            UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  transfer_type          TEXT NOT NULL CHECK (transfer_type IN ('developer_to_builder', 'builder_to_homeowner', 'owner_resale')),
  owner_class            TEXT CHECK (owner_class IN ('builder', 'homeowner')),  -- NULL for resale (no charge)
  effective_date         DATE NOT NULL,
  fiscal_year_end        DATE NOT NULL,
  days_prorated          INTEGER NOT NULL,
  days_in_year           INTEGER NOT NULL,
  annual_amount_cents    INTEGER,
  prorated_amount_cents  INTEGER NOT NULL DEFAULT 0,   -- 0 for resale
  ar_charge_id           UUID,                          -- the posted charge, NULL for resale
  posted_by              TEXT,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_prorations_property ON assessment_prorations (property_id);
CREATE INDEX IF NOT EXISTS idx_assessment_prorations_community ON assessment_prorations (community_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_prorations TO service_role;
GRANT SELECT                         ON assessment_prorations TO authenticated;

COMMIT;
