-- Multi-channel delivery evidence trail.
-- ---------------------------------------------------------------------------
-- The "I never got the letter" defense problem: a homeowner claims they
-- never received any notice, yet there's a certified §209 letter sitting on
-- their kitchen table. Without supplemental evidence Bedrock is stuck
-- arguing about mail delivery. This migration adds the structural answer:
--   - Per-contact SMS opt-in tracking (TCPA requires explicit consent)
--   - Per-contact email opt-OUT (CAN-SPAM allows transactional email
--     without opt-in, but we honor explicit opt-out)
--   - delivery_receipts table: one row per channel send for an interaction
--     (mail, email, SMS, certified, postcard). Stores vendor message id,
--     status timeline (queued → sent → delivered → opened → clicked or
--     bounced/failed), and the raw vendor webhook payload for audit.
--
-- When the Mail Queue lock-and-batch fires, the certified mail goes out
-- AND the system creates supplemental email + SMS delivery_receipts (where
-- channel preferences allow). The property-detail evidence panel renders
-- the full timeline so an operator handling a complaint can show — not
-- argue — that three channels reached the homeowner on three timestamps.

-- ----------------------------------------------------------------------------
-- contacts: SMS opt-in + email opt-out + a dedicated notification phone
-- ----------------------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS sms_opt_in           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_opt_in_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS sms_opt_in_source    TEXT NULL,            -- 'web_form', 'paper', 'manual', 'reply_keyword'
  ADD COLUMN IF NOT EXISTS sms_opt_out          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_opt_out_at       TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS email_opt_out        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_opt_out_at     TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS notification_phone   TEXT NULL;            -- preferred cell for SMS (distinct from home phone)

-- ----------------------------------------------------------------------------
-- delivery_receipts: one row per channel send for an interaction
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_receipts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id        UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  contact_id            UUID NULL REFERENCES contacts(id) ON DELETE SET NULL,
  community_id          UUID NULL REFERENCES communities(id),
  property_id           UUID NULL REFERENCES properties(id),
  violation_id          UUID NULL REFERENCES violations(id) ON DELETE SET NULL,
  channel               TEXT NOT NULL
                          CHECK (channel IN ('email','sms','first_class_mail','certified_mail','postcard','portal_notify')),
  to_address            TEXT NOT NULL,                                -- email address / phone / postal address
  status                TEXT NOT NULL DEFAULT 'sent'
                          CHECK (status IN ('queued','sent','delivered','opened','clicked','bounced','failed','undelivered','complained')),
  vendor                TEXT NULL,                                    -- 'twilio', 'resend', 'usps', 'manual'
  vendor_message_id     TEXT NULL,                                    -- Twilio SID, Resend message id, USPS tracking
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at          TIMESTAMPTZ NULL,
  opened_at             TIMESTAMPTZ NULL,
  clicked_at            TIMESTAMPTZ NULL,
  failed_at             TIMESTAMPTZ NULL,
  failure_reason        TEXT NULL,
  raw_response          JSONB NULL,                                   -- vendor webhook payload for audit
  notes                 TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_receipts_interaction
  ON delivery_receipts(interaction_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_contact
  ON delivery_receipts(contact_id, sent_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_violation
  ON delivery_receipts(violation_id, sent_at DESC)
  WHERE violation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_property
  ON delivery_receipts(property_id, sent_at DESC)
  WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_vendor_msg
  ON delivery_receipts(vendor, vendor_message_id)
  WHERE vendor_message_id IS NOT NULL;
