-- ===========================================================================
-- 343_ap_intake_exceptions.sql
-- ---------------------------------------------------------------------------
-- A holding pen for emailed bills Emma captured but COULDN'T auto-file, so they
-- leave her email inbox and land in ONE place in Payables to be cleared — the
-- operator assigns the missing piece (usually the community) and it promotes to
-- a real ap_invoice. Goal: Emma's inbox holds only things needing a human reply,
-- not a pile of un-filed accounting work. (Ed 2026-08-01: "I want Emma's inbox
-- to be empty.")
--
-- Why a separate table: ap_invoices requires community_id, vendor_id, a positive
-- total and a date (all NOT NULL). A bill whose community we can't resolve from
-- the PDF's bill-to CANNOT live in ap_invoices without polluting the books with a
-- sentinel community. So it waits here, with its extracted data + the archived
-- PDF, until a human supplies what's missing; then commitInvoice promotes it.
--
-- Record ownership: WORKPAPER (Bedrock's AP intake processing state). It carries
-- no posted financial value — on resolve it promotes to an ap_invoices row
-- (association_record) and is marked resolved. community_id is intentionally
-- NULLABLE (an unresolved community is the whole point) and set when known.
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ap_intake_exceptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id     UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  intake_source_ref    TEXT,                                  -- 'email:<graphId>' (idempotency)
  reason               TEXT NOT NULL,                         -- no_community | no_vendor | vendor_ambiguous | no_total | no_date | other
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'resolved', 'dismissed')),
  -- what we DID read off the bill (for display + promotion)
  vendor_name          TEXT,
  community_hint       TEXT,
  invoice_number       TEXT,
  account_number       TEXT,
  total_cents          BIGINT,
  invoice_date         DATE,
  -- best guesses (may be null): a community/vendor we partially matched
  community_id         UUID REFERENCES communities(id) ON DELETE SET NULL,
  suggested_vendor_id  UUID REFERENCES vendors(id) ON DELETE SET NULL,
  -- the archived bill + the full extraction, so promotion needs no re-fetch
  storage_path         TEXT,                                  -- PDF in the 'documents' bucket
  file_sha256          TEXT,
  extracted            JSONB,
  -- resolution
  resolved_invoice_id  UUID REFERENCES ap_invoices(id) ON DELETE SET NULL,
  resolved_by          TEXT,
  resolved_at          TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One exception per (source email, PDF) — a re-pull of the same email + bill is a
-- structural no-op, never a duplicate exception. Partial so multiple bills from
-- one email (distinct sha) each get their own row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ap_intake_exceptions_src
  ON ap_intake_exceptions (intake_source_ref, file_sha256)
  WHERE intake_source_ref IS NOT NULL AND file_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ap_intake_exceptions_pending
  ON ap_intake_exceptions (created_at) WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_ap_intake_exceptions_updated_at ON ap_intake_exceptions;
CREATE TRIGGER trg_ap_intake_exceptions_updated_at
  BEFORE UPDATE ON ap_intake_exceptions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ap_intake_exceptions TO service_role;
GRANT SELECT                          ON ap_intake_exceptions TO authenticated;

COMMIT;
