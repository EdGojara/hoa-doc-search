-- ============================================================================
-- 042_prospects_crm.sql
-- ----------------------------------------------------------------------------
-- Bedrock "New Business" CRM-lite. A prospect is a community Bedrock is
-- pitching but hasn't onboarded yet. The module lives under Bedrock Office
-- and serves two purposes:
--
--   1) Sales document generator — enter prospect data once, generate the
--      Bedrock-branded proposal PDF + management-agreement PDF together,
--      ready to send in under 15 minutes.
--   2) Pipeline tracking — leads, board contacts, activity history,
--      lost reasons. Lightweight CRM so we can see what's in flight and
--      learn from what we don't win.
--
-- On signing, a prospect promotes to a live community: a row is created in
-- the existing `communities` table, the management agreement becomes the
-- active contract, the community shows up in Client Billing the next day.
-- No re-keying.
--
-- Apply AFTER 041. Idempotent.
-- ============================================================================

BEGIN;

-- 1) prospects — the lead/opportunity record.
CREATE TABLE IF NOT EXISTS prospects (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id        UUID NOT NULL,
  -- Identity
  community_name               TEXT NOT NULL,
  community_address            TEXT NULL,
  community_legal_entity_name  TEXT NULL,
  -- Sizing
  lot_count_estimated          INTEGER NULL CHECK (lot_count_estimated IS NULL OR lot_count_estimated >= 0),
  -- Who we're displacing (if any)
  current_manager              TEXT NULL,
  current_manager_end_date     DATE NULL,
  target_start_date            DATE NULL,
  -- Pricing snapshot — copies in from bedrock_contract_defaults at create
  -- time, can be edited per prospect without touching the defaults.
  per_lot_monthly_fee          NUMERIC(10,4) NULL,
  monthly_fee_override         NUMERIC(12,2) NULL,
  term_months                  INTEGER NULL DEFAULT 12,
  -- Pipeline
  status                       TEXT NOT NULL DEFAULT 'inquiry'
                                 CHECK (status IN ('inquiry','qualifying','proposal_sent','contract_sent','won','lost','on_hold')),
  source                       TEXT NULL,
  -- Loss tracking — only meaningful when status='lost'. The reason text
  -- is free-form so we capture nuance; the category gives us aggregate
  -- analytics (price, incumbent loyalty, timing, fit, other).
  lost_category                TEXT NULL
                                 CHECK (lost_category IN ('price','incumbent_loyalty','timing','fit','no_response','other') OR lost_category IS NULL),
  lost_reason                  TEXT NULL,
  -- Generated artifacts
  proposal_pdf_path            TEXT NULL,
  management_agreement_pdf_path TEXT NULL,
  proposal_generated_at        TIMESTAMPTZ NULL,
  agreement_generated_at       TIMESTAMPTZ NULL,
  -- Won → live community link
  promoted_to_community_id     UUID NULL REFERENCES communities(id),
  promoted_to_contract_id      UUID NULL REFERENCES contracts(id),
  promoted_at                  TIMESTAMPTZ NULL,
  -- Lifecycle timestamps
  proposal_sent_at             TIMESTAMPTZ NULL,
  contract_sent_at             TIMESTAMPTZ NULL,
  won_at                       TIMESTAMPTZ NULL,
  lost_at                      TIMESTAMPTZ NULL,
  next_action                  TEXT NULL,
  next_action_date             DATE NULL,
  notes                        TEXT NULL,
  assigned_to                  TEXT NULL,
  created_by                   TEXT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospects_status
  ON prospects (management_company_id, status, next_action_date NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_prospects_created
  ON prospects (management_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_won
  ON prospects (management_company_id, won_at DESC)
  WHERE status = 'won';
CREATE INDEX IF NOT EXISTS idx_prospects_lost
  ON prospects (management_company_id, lost_at DESC, lost_category)
  WHERE status = 'lost';

-- 2) prospect_contacts — the board members and decision-makers at the
--    prospect community. Pitches go nowhere without knowing who to call.
CREATE TABLE IF NOT EXISTS prospect_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT NULL
                    CHECK (role IN ('President','Vice President','Treasurer','Secretary','Director','Committee Chair','Property Manager','Developer','Resident','Other') OR role IS NULL),
  email           TEXT NULL,
  phone           TEXT NULL,
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospect_contacts_prospect
  ON prospect_contacts (prospect_id, is_primary DESC, name);

-- 3) prospect_activities — the activity feed. Every call, email, meeting,
--    status change, or doc generation lands here so we have a complete
--    trail of what happened with each lead.
CREATE TABLE IF NOT EXISTS prospect_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL
                    CHECK (kind IN (
                      'note',
                      'call',
                      'email_sent',
                      'email_received',
                      'meeting',
                      'proposal_generated',
                      'proposal_sent',
                      'contract_generated',
                      'contract_sent',
                      'status_change',
                      'promoted'
                    )),
  subject         TEXT NULL,
  body            TEXT NULL,
  payload         JSONB NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospect_activities_prospect
  ON prospect_activities (prospect_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospect_activities_kind
  ON prospect_activities (kind, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON prospects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON prospect_contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON prospect_activities TO service_role;

COMMIT;

-- Verify:
--   SELECT id, community_name, status, lot_count_estimated, per_lot_monthly_fee
--     FROM prospects ORDER BY created_at DESC LIMIT 5;
--   SELECT prospect_id, name, role, is_primary FROM prospect_contacts LIMIT 10;
--   SELECT kind, subject, occurred_at FROM prospect_activities ORDER BY occurred_at DESC LIMIT 10;
