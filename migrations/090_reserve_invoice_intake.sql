-- ============================================================================
-- 090_reserve_invoice_intake.sql
-- ----------------------------------------------------------------------------
-- Staging table for vendor invoices awaiting match to a reserve component,
-- plus a stored function that "rolls forward" a component when its expenditure
-- represents a full or partial replacement.
--
-- Workflow:
--   1) Invoice arrives (manual upload OR future email pipeline) → row inserted
--      into reserve_invoice_intake with vendor + amount + description, AI
--      suggestion populated in suggested_component_id + suggested_confidence
--   2) Staff sees the row in the review queue UI, confirms or edits the match
--   3) On confirm: a reserve_expenditure row is created, and if the type is
--      'full_replacement' or 'partial_replacement', the component's installed
--      year + next replacement year roll forward.
--   4) The intake row's status flips to 'matched' or 'dismissed'.
--
-- Apply after 089. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) reserve_invoice_intake — staged invoices awaiting match decision
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_invoice_intake (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                      UUID REFERENCES communities(id) ON DELETE RESTRICT,

  -- Extracted / entered invoice fields
  vendor_name                       TEXT,
  invoice_number                    TEXT,
  invoice_date                      DATE,
  amount_cents                      BIGINT,
  description                       TEXT,
  raw_text                          TEXT,       -- full extracted text if from PDF

  -- File handle (Supabase storage path) for the source PDF
  file_storage_path                 TEXT,
  file_name                         TEXT,

  -- Match suggestion (populated by the matcher at intake)
  suggested_component_id            UUID REFERENCES reserve_components(id) ON DELETE SET NULL,
  suggested_confidence              NUMERIC(4,3),   -- 0.000 - 1.000
  suggested_reason                  TEXT,
  alternate_suggestions             JSONB,          -- top-3 alternatives [{id, name, confidence, reason}]

  -- Outcome
  status                            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'matched', 'dismissed')),
  matched_component_id              UUID REFERENCES reserve_components(id) ON DELETE SET NULL,
  matched_expenditure_id            UUID REFERENCES reserve_expenditures(id) ON DELETE SET NULL,
  matched_at                        TIMESTAMPTZ,
  matched_by                        TEXT,
  dismissed_reason                  TEXT,

  -- Source tracking
  source                            TEXT,           -- 'manual_upload', 'email', 'api'
  intake_email_message_id           TEXT,

  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserve_invoice_intake_community_status
  ON reserve_invoice_intake(community_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reserve_invoice_intake_pending
  ON reserve_invoice_intake(status, created_at DESC)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_reserve_invoice_intake_updated_at ON reserve_invoice_intake;
CREATE TRIGGER trg_reserve_invoice_intake_updated_at
  BEFORE UPDATE ON reserve_invoice_intake
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE reserve_invoice_intake IS
  'Staged vendor invoices awaiting match to a reserve component. AI suggests a component on intake; staff confirms or dismisses in the review queue. On confirm, a reserve_expenditure is created and the component rolls forward if the expenditure is a replacement.';

-- ----------------------------------------------------------------------------
-- 2) Function — roll a component forward after a replacement expenditure
-- ----------------------------------------------------------------------------
-- Given a component and the replacement year, update:
--   - installed_or_built_year = replacement year
--   - remaining_useful_life_years = useful_life_years
--   - next_scheduled_replacement_year = replacement year + useful_life_years
--   - condition = 'excellent' (fresh install)
-- Caller decides whether to invoke (i.e., only for full/partial replacements).
CREATE OR REPLACE FUNCTION apply_reserve_component_rollforward(
  p_component_id   UUID,
  p_replaced_year  INTEGER
)
RETURNS reserve_components
LANGUAGE plpgsql
AS $$
DECLARE
  v_component reserve_components;
BEGIN
  SELECT * INTO v_component FROM reserve_components WHERE id = p_component_id;
  IF v_component.id IS NULL THEN
    RAISE EXCEPTION 'reserve component % not found', p_component_id;
  END IF;

  UPDATE reserve_components SET
    installed_or_built_year         = p_replaced_year,
    remaining_useful_life_years     = COALESCE(useful_life_years, remaining_useful_life_years),
    next_scheduled_replacement_year = CASE
      WHEN useful_life_years IS NOT NULL THEN p_replaced_year + useful_life_years
      ELSE next_scheduled_replacement_year
    END,
    condition                       = 'excellent',
    updated_at                      = NOW()
  WHERE id = p_component_id
  RETURNING * INTO v_component;

  RETURN v_component;
END;
$$;

COMMENT ON FUNCTION apply_reserve_component_rollforward(UUID, INTEGER) IS
  'Rolls a reserve component forward after a replacement expenditure. Resets installed_or_built_year + next_scheduled_replacement_year + remaining_useful_life_years and sets condition to excellent. Called by the invoice-intake match endpoint when the expenditure type is full_replacement or partial_replacement.';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON reserve_invoice_intake
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION apply_reserve_component_rollforward(UUID, INTEGER)
  TO service_role, authenticated;

COMMIT;
