-- ============================================================================
-- 202_property_enforcement_states.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Operator-managed enforcement state per property.
--
-- WHY THIS EXISTS:
-- These states carry SERIOUS regulatory risk if missed:
--   - in_bankruptcy → 11 USC §362 automatic stay. ANY collection
--     communication after the petition date is a sanctionable federal
--     violation. No letters, no calls, no fine assessment, no lien.
--   - at_legal / with_attorney → FDCPA scoping. Bedrock can't
--     negotiate or discuss the matter. Direct contact is an FDCPA
--     violation.
--   - in_collections → formal collections process notification rules.
--   - on_payment_plan → operational damage if a fine fires on someone
--     current on their plan.
--
-- Today these signals only exist on owner_ar_snapshots which is a
-- Vantaca-import mirror — Bedrock can't update it directly, there's
-- no audit trail, and bankruptcy isn't tracked at all. This table
-- fixes that.
--
-- DESIGN:
-- - One ACTIVE row per property (ended_at IS NULL).
-- - When state changes (e.g., bankruptcy lifted → returned to
--   collections), end-date the prior row, insert a new one. Full
--   history preserved for regulatory defense.
-- - Audit log captures every operator action with who/when/why.
-- - View v_current_enforcement_state surfaces the active row per
--   property for all consumers (Claire, letters, board portal, etc).
--
-- THIS TABLE IS CATASTROPHIC-OUTPUT CLASS per CLAUDE.md. Wrong data
-- here means regulatory violation. Operator UI MUST require
-- explicit confirmation + reason on every state change.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS property_enforcement_states (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                       UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  community_id                      UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  contact_id                        UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- The state itself
  state                             TEXT NOT NULL
                                      CHECK (state IN (
                                        'current',                -- baseline; explicit "no enforcement"
                                        'on_payment_plan',        -- active payment arrangement
                                        'in_collections',         -- formal collections process
                                        'at_legal',               -- account with collections counsel
                                        'in_bankruptcy',          -- 11 USC §362 automatic stay active
                                        'lien_filed',             -- HOA lien recorded
                                        'judgment'                -- judgment obtained
                                      )),
  effective_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expected_through                  DATE,                                  -- payment plan end date, etc.

  -- Common attorney fields (used by at_legal, in_collections, lien_filed,
  -- judgment). All NULL when not applicable.
  attorney_name                     TEXT,
  attorney_firm                     TEXT,
  attorney_email                    TEXT,
  attorney_phone                    TEXT,

  -- Bankruptcy-specific fields (only used when state='in_bankruptcy')
  bankruptcy_chapter                TEXT
                                      CHECK (bankruptcy_chapter IS NULL OR bankruptcy_chapter IN ('7','11','12','13')),
  bankruptcy_case_number            TEXT,
  bankruptcy_court                  TEXT,
  bankruptcy_filing_date            DATE,
  bankruptcy_attorney_name          TEXT,
  bankruptcy_attorney_email         TEXT,
  bankruptcy_attorney_phone         TEXT,

  -- Payment plan specifics (only used when state='on_payment_plan')
  payment_plan_terms_text           TEXT,                                  -- "$200/mo through Oct 2026"
  payment_plan_monthly_cents        BIGINT,
  payment_plan_remaining_cents      BIGINT,

  -- General
  notes                             TEXT,

  -- Lifecycle
  ended_at                          TIMESTAMPTZ,
  ended_by                          TEXT,
  ended_reason                      TEXT,

  -- Audit
  created_by                        TEXT NOT NULL,        -- operator email / 'system'
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One ACTIVE state per property — enforced via partial unique index on
-- ended_at IS NULL. Prevents accidentally having two active "in_bankruptcy"
-- rows for the same property.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_enforcement_per_property
  ON property_enforcement_states(property_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_enforcement_active_by_community
  ON property_enforcement_states(community_id, state)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_enforcement_history
  ON property_enforcement_states(property_id, effective_at DESC);

DROP TRIGGER IF EXISTS trg_enforcement_states_updated_at ON property_enforcement_states;
CREATE TRIGGER trg_enforcement_states_updated_at
  BEFORE UPDATE ON property_enforcement_states
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- Audit log — every operator action on enforcement state writes a row.
-- This is the regulatory defense record. If a homeowner ever challenges
-- "Bedrock contacted me after my bankruptcy," we point at this log.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_enforcement_state_audit (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                       UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  state_row_id                      UUID REFERENCES property_enforcement_states(id) ON DELETE SET NULL,
  action                            TEXT NOT NULL
                                      CHECK (action IN ('created', 'updated', 'ended', 'reopened')),
  state_before                      TEXT,
  state_after                       TEXT,
  changed_fields                    JSONB,                                 -- {field: {before, after}}
  performed_by                      TEXT NOT NULL,                         -- operator email
  performed_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address                        TEXT,
  reason                            TEXT
);

CREATE INDEX IF NOT EXISTS idx_enforcement_audit_property
  ON property_enforcement_state_audit(property_id, performed_at DESC);

-- ----------------------------------------------------------------------------
-- View: v_current_enforcement_state — the single source of truth for
-- "what state is this property in RIGHT NOW." Filters to active rows
-- (ended_at IS NULL). All consumers (Claire, letter renderer, board
-- portal, AR resolver) join this view.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_current_enforcement_state CASCADE;
CREATE VIEW v_current_enforcement_state AS
SELECT
  property_id,
  community_id,
  state,
  effective_at,
  expected_through,
  attorney_name,
  attorney_firm,
  attorney_email,
  attorney_phone,
  bankruptcy_chapter,
  bankruptcy_case_number,
  bankruptcy_court,
  bankruptcy_filing_date,
  bankruptcy_attorney_name,
  bankruptcy_attorney_email,
  payment_plan_terms_text,
  payment_plan_monthly_cents,
  payment_plan_remaining_cents,
  notes,
  created_by,
  created_at
FROM property_enforcement_states
WHERE ended_at IS NULL;

COMMENT ON VIEW v_current_enforcement_state IS
  'CANONICAL source for "what enforcement state is this property in?" — used by Claire (HARD RULE handoffs), letter renderer (block letters on in_bankruptcy / at_legal), board portal AR rollup, AI draft pipeline. Always-on consumers MUST consult this view before any communication touches the homeowner.';

-- ----------------------------------------------------------------------------
-- Grants (CLAUDE.md rule from earlier today — never forget)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON property_enforcement_states       TO service_role;
GRANT SELECT, INSERT                  ON property_enforcement_state_audit TO service_role;
GRANT SELECT                          ON property_enforcement_states       TO authenticated;
GRANT SELECT                          ON property_enforcement_state_audit TO authenticated;
GRANT SELECT                          ON v_current_enforcement_state       TO service_role, authenticated;

COMMIT;
