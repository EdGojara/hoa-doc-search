-- ============================================================================
-- 429_vendor_ach_requests.sql  (Ed 2026-09-16)
-- ----------------------------------------------------------------------------
-- Secure vendor ACH enrollment via a one-time link, so a vendor's banking
-- details are entered into an HTTPS form instead of sent in plain email (the
-- #1 AP fraud vector: business email compromise / vendor ACH change fraud).
--
-- Flow:  sent -> submitted -> verified   (payments only after verified)
--   sent      : link generated + emailed to a known vendor contact
--   submitted : vendor filled the form (bank details captured)
--   verified  : a human confirmed the details by CALL-BACK to a known number
--   cancelled : link revoked before use
--   expired   : past expires_at (enforced in the API, this is just a label)
--
-- SECURITY:
--   * Only a SHA-256 HASH of the token is stored; the raw token lives only in
--     the emailed link. A DB leak does not expose a usable link.
--   * The full account number (account_number_full) is owner-reveal-gated in
--     the API and NEVER returned to any list/admin view; everything else shows
--     account_number_last4 only.
--   * GRANTED TO service_role ONLY. This table is NEVER exposed to the
--     `authenticated` (browser/PostgREST) role. All access is server-side via
--     the service role, gated by requireAdmin / requireOwner in api/ach.js.
--
-- Record ownership: association_record (the association's vendor payment setup).
-- Community-scoped (community_id) for termination export; nullable for a
-- management-company-level vendor.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vendor_ach_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  uuid NOT NULL,
  community_id           uuid REFERENCES communities(id) ON DELETE SET NULL,
  vendor_id              uuid REFERENCES vendors(id) ON DELETE SET NULL,

  -- Who we are collecting from + who we sent the link to
  vendor_name            text NOT NULL,
  contact_name           text,
  contact_email          text,

  -- Secure link
  token_hash             text NOT NULL UNIQUE,       -- sha256(raw token)
  status                 text NOT NULL DEFAULT 'sent'
                           CHECK (status IN ('sent','submitted','verified','cancelled','expired')),
  expires_at             timestamptz NOT NULL,

  -- Submission (all null until the vendor submits)
  account_holder_name    text,
  bank_name              text,
  account_type           text CHECK (account_type IN ('checking','savings')),
  routing_number         text,                       -- 9-digit ABA (validated in API)
  account_number_full    text,                       -- SENSITIVE — owner-reveal only
  account_number_last4   text,                       -- safe for admin display
  submitted_at           timestamptz,
  submitter_ip           text,

  -- Verification (human call-back confirmation before any payment)
  verified_by            text,
  verified_at            timestamptz,
  verification_notes     text,

  record_ownership       text NOT NULL DEFAULT 'association_record',
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_ach_token ON vendor_ach_requests (token_hash);
CREATE INDEX IF NOT EXISTS idx_vendor_ach_community ON vendor_ach_requests (community_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_ach_status ON vendor_ach_requests (status);

DROP TRIGGER IF EXISTS trg_vendor_ach_updated ON vendor_ach_requests;
CREATE TRIGGER trg_vendor_ach_updated BEFORE UPDATE ON vendor_ach_requests
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- service_role ONLY. Bank details never reach the browser/PostgREST role.
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_ach_requests TO service_role;

COMMIT;
