-- ============================================================================
-- 185_email_campaigns.sql
-- ----------------------------------------------------------------------------
-- Community email blasts — one input from operator, N branded outputs to
-- residents. Each recipient gets their own community's letterhead and
-- sign-off even when the campaign is portfolio-wide.
--
-- WHY THIS EXISTS:
-- The use case Ed surfaced 2026-06-08: "office closed Memorial Day" type
-- notices need to reach every Bedrock-managed homeowner AND resident
-- (renters per the same conversation). Sending N separate emails is slow
-- and creates inconsistency. Sending one generic "Bedrock-managed
-- communities" email loses the per-community personalization that the
-- brand-the-output and bespoke-touch rules require. The platform's job:
-- type once, render N variants, send all.
--
-- TWO CAMPAIGN SCOPES:
--   - single_community: targets ONE community. Picker selects which.
--   - all_communities:  targets every active community in the portfolio.
--                       Same body, rendered with each community's
--                       letterhead / contact info / sign-off.
--
-- RECIPIENT MODEL:
-- Recipients are computed at SEND time from:
--   • Current property owners (property_ownerships where end_date IS NULL)
--   • Current residents (property_residencies where end_date IS NULL)
-- with their contact rows joined to get email + name. We dedupe by email
-- address within the campaign — one person who is BOTH owner and
-- owner-occupant gets ONE email, branded by their property's community.
--
-- For a person who has presence at multiple communities (rare — investor
-- with multiple Bedrock-managed properties, or board member who is a
-- homeowner elsewhere), an all_communities blast sends ONE email,
-- branded by their most recent residency/ownership community. Avoids
-- sending the same person multiple variants of the same message.
--
-- TEMPLATE VARIABLES (substituted at render time):
--   {{community_name}}          — display name
--   {{community_legal_name}}    — legal name for formal contexts
--   {{recipient_first_name}}    — caller's preferred or first name
--   {{recipient_full_name}}     — full name
--   {{bedrock_phone}}           — (832) 588-2485 — global
--   {{bedrock_email}}           — info@bedrocktx.com — global
--   {{today_date}}              — formatted current date
--
-- SAFETY:
--   - Recipient counts visible BEFORE send confirmation
--   - Status field gates the lifecycle so a draft can't be accidentally
--     re-sent
--   - Per-recipient row preserves audit trail (who, when, vendor
--     message id, delivery status)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- email_campaigns — one row per blast (whether single or all communities)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaigns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),

  -- 'single_community' = targets the community in target_community_id
  -- 'all_communities'  = targets every active community in the portfolio
  scope                    TEXT NOT NULL DEFAULT 'single_community'
                           CHECK (scope IN ('single_community', 'all_communities')),
  target_community_id      UUID REFERENCES communities(id) ON DELETE RESTRICT,

  -- Content — supports {{variable}} substitution at render time
  subject_template         TEXT NOT NULL,
  body_html_template       TEXT NOT NULL,
  body_text_template       TEXT,                 -- optional plaintext alt

  -- Audience filter — which recipients in scope receive the email
  -- 'owners_and_residents' = everyone (owners + current residents)
  -- 'owners_only'          = property owners only (legal-effect notices)
  -- 'residents_only'       = current residents only (rare; pool closure to renters)
  audience                 TEXT NOT NULL DEFAULT 'owners_and_residents'
                           CHECK (audience IN ('owners_and_residents','owners_only','residents_only')),

  -- Lifecycle
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','sending','sent','partial_failure','failed','cancelled')),
  created_by               TEXT,                 -- staff email or name (until full auth wiring)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Send-time stats (filled when send is invoked)
  sent_at                  TIMESTAMPTZ,
  total_recipients         INTEGER NOT NULL DEFAULT 0,
  delivered_count          INTEGER NOT NULL DEFAULT 0,
  failed_count             INTEGER NOT NULL DEFAULT 0,

  notes                    TEXT,

  -- Single-community campaigns MUST have a target community
  CHECK (scope <> 'single_community' OR target_community_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_mgmt_created
  ON email_campaigns(management_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status
  ON email_campaigns(status, created_at DESC)
  WHERE status IN ('draft','sending','partial_failure');

DROP TRIGGER IF EXISTS trg_email_campaigns_updated_at ON email_campaigns;
CREATE TRIGGER trg_email_campaigns_updated_at
  BEFORE UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- email_campaign_recipients — one row per (campaign, recipient) pair
-- The fan-out target table. Preserves per-recipient audit trail and is
-- the unit at which delivery status is tracked.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              UUID NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,

  -- Who's being emailed
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,
  email                    TEXT NOT NULL,        -- captured at queue time (immutable)
  recipient_full_name      TEXT,
  recipient_first_name     TEXT,

  -- Community context for THIS recipient — drives the per-recipient render
  community_id             UUID REFERENCES communities(id) ON DELETE RESTRICT,
  community_name           TEXT,                 -- denormalized for audit
  community_legal_name     TEXT,

  -- Recipient role context (also drives optional per-role copy variations
  -- in future template iterations; v1 just records it)
  recipient_role           TEXT
                           CHECK (recipient_role IS NULL OR recipient_role IN
                                  ('owner','resident_owner_occupied','resident_renter','resident_family','resident_other')),

  -- Delivery state
  status                   TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','sent','failed','bounced','skipped')),
  rendered_subject         TEXT,                 -- captured at send time
  resend_message_id        TEXT,                 -- Resend vendor message id
  sent_at                  TIMESTAMPTZ,
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One recipient row per (campaign, email) pair. Dedupes naturally
  -- when a person is owner AND resident of the same property.
  UNIQUE (campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_eml_recip_campaign_status
  ON email_campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_eml_recip_community
  ON email_campaign_recipients(community_id);

COMMIT;
