-- 180: Letter mail tracking + Lob integration substrate
--
-- Tracks every certified letter (and eventually first-class letters)
-- from PDF approval → USPS pickup → delivery → signature capture.
-- Provider-agnostic — works with Lob, Pitney, or manual data entry.
--
-- Record ownership: mixed. The tracking events + signature images are
-- delivered to the Association (association_record); the internal mail-
-- run metadata + provider request/response payloads are Bedrock workpaper.
--
-- The interaction record stays the parent for the letter content (PDF,
-- bundle id, stage, recipient). letter_mail_pieces is the LOGISTICS shell
-- — what happened to that letter after it went into the mail stream.

BEGIN;

CREATE TABLE IF NOT EXISTS letter_mail_pieces (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id              UUID NOT NULL REFERENCES interactions(id) ON DELETE RESTRICT,
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id                 UUID REFERENCES properties(id) ON DELETE SET NULL,
  violation_id                UUID REFERENCES violations(id) ON DELETE SET NULL,
  bundle_id                   UUID,

  -- Stage at send time + the letter PDF path
  stage_at_send               TEXT NOT NULL
                                CHECK (stage_at_send IN (
                                  'courtesy_1', 'courtesy_2', 'certified_209',
                                  'fine_assessed', 'hearing_notice', 'force_mow'
                                )),
  letter_pdf_storage_path     TEXT,
  recipient_name              TEXT,
  recipient_address_line1     TEXT,
  recipient_address_line2     TEXT,
  recipient_city              TEXT,
  recipient_state             TEXT,
  recipient_zip               TEXT,

  -- Mail method
  delivery_method             TEXT NOT NULL DEFAULT 'first_class'
                                CHECK (delivery_method IN (
                                  'first_class', 'certified_mail', 'certified_return_receipt',
                                  'priority_mail', 'hand_delivery', 'email_only'
                                )),
  return_receipt_requested    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Provider — 'manual' for legacy / pasted tracking numbers; 'lob' for API
  provider                    TEXT NOT NULL DEFAULT 'manual'
                                CHECK (provider IN ('manual', 'lob', 'pitney', 'usps_direct')),
  provider_letter_id          TEXT,  -- Lob letter id / Pitney shipment id / etc.
  provider_test_mode          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Tracking + timeline
  tracking_number             TEXT,
  status                      TEXT NOT NULL DEFAULT 'queued'
                                CHECK (status IN (
                                  'queued',        -- waiting to be sent
                                  'submitted',     -- provider accepted
                                  'in_transit',    -- USPS picked up
                                  'out_for_delivery',
                                  'delivered',
                                  'refused',
                                  'undeliverable',
                                  'returned_to_sender',
                                  'cancelled',
                                  'failed_to_send'
                                )),
  submitted_at                TIMESTAMPTZ,
  mailed_at                   TIMESTAMPTZ,        -- first USPS scan
  in_transit_at               TIMESTAMPTZ,
  out_for_delivery_at         TIMESTAMPTZ,
  delivered_at                TIMESTAMPTZ,
  returned_at                 TIMESTAMPTZ,
  refused_at                  TIMESTAMPTZ,

  -- Signature capture (electronic return receipt)
  signed_by_name              TEXT,
  signature_image_url         TEXT,
  signature_image_storage_path TEXT,

  -- Cost tracking
  postage_cents               INTEGER,
  service_fee_cents           INTEGER,
  total_cost_cents            INTEGER,

  -- Errors + diagnostics
  error_message               TEXT,
  provider_request_payload    JSONB,
  provider_response_payload   JSONB,
  events                      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- timeline of all status events

  -- Notes
  staff_notes                 TEXT,
  created_by_user_id          UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (interaction_id)  -- one mail piece per interaction
);

CREATE INDEX IF NOT EXISTS idx_letter_mail_pieces_interaction
  ON letter_mail_pieces (interaction_id);
CREATE INDEX IF NOT EXISTS idx_letter_mail_pieces_status
  ON letter_mail_pieces (status, created_at DESC)
  WHERE status NOT IN ('delivered', 'returned_to_sender', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_letter_mail_pieces_community
  ON letter_mail_pieces (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_letter_mail_pieces_tracking
  ON letter_mail_pieces (tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_letter_mail_pieces_provider_letter
  ON letter_mail_pieces (provider, provider_letter_id)
  WHERE provider_letter_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_letter_mail_pieces_updated_at ON letter_mail_pieces;
CREATE TRIGGER trg_letter_mail_pieces_updated_at
  BEFORE UPDATE ON letter_mail_pieces
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT ON letter_mail_pieces TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON letter_mail_pieces TO service_role;

COMMIT;
