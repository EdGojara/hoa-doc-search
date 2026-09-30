-- ============================================================================
-- 475_historical_letter_recovery.sql  (Issue #11)
-- ----------------------------------------------------------------------------
-- Restores Trusted's record of a certified notice that was physically mailed on
-- a past date but whose record was lost. In July 2026 these notices were mailed
-- from drafts outside the Mail Queue and stayed 'draft' in Trusted. Later voids
-- and regenerates then rejected them or deleted them, along with their PDFs.
--
-- One row here per recovered mailing (per violation the letter covered). The
-- mailed notice itself is an ordinary interactions row (status 'sent', the real
-- mailing time in sent_at, created_at left as the true write time), plus a
-- sealed copy in sent-letters-archive / sent_letter_archive. This table records
-- HOW it was recovered: which bytes (original or reconstructed), their hash,
-- the receipt evidence, and why. It never edits the July rows: rejected
-- drafts stay rejected, and voided or superseded violations stay as they are.
--
-- Record ownership: MIXED. The notice (interaction + sealed PDF) is an
-- association_record. This provenance row (method, hashes, reconstruction
-- inputs) is a Bedrock workpaper.
--
-- Sealing: once a recovery row names an interaction, that interaction cannot be
-- deleted, and the fields that make it "this notice, mailed then" (status,
-- sent_at, content, type, delivery method, violation / property link,
-- created_at) cannot change. No cleanup, regenerate or void path can remove it.
-- The recovery table itself is append-only for the service role, and browser
-- roles have no access.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS letter_recovery_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- '<property_id>:<mailed_on>:<violation_id>'. A re-run of the recovery finds
  -- this key and stops, so the operation is idempotent.
  recovery_key          TEXT NOT NULL UNIQUE,
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id           UUID NOT NULL REFERENCES properties(id)  ON DELETE RESTRICT,
  violation_id          UUID NOT NULL REFERENCES violations(id)  ON DELETE RESTRICT,
  -- The mailed-notice record (a reused July draft, or a new 'sent' row).
  interaction_id        UUID NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE RESTRICT,
  -- The July draft / rejected row this mailing came from, when one exists.
  prior_interaction_id  UUID REFERENCES interactions(id) ON DELETE RESTRICT,
  mailed_on             DATE NOT NULL,          -- the certified receipt date
  mailed_at             TIMESTAMPTZ,            -- USPS acceptance time, when the receipt shows it
  delivery_method       TEXT NOT NULL CHECK (delivery_method = 'certified_mail'),
  provenance            TEXT NOT NULL CHECK (provenance IN ('recovered_original', 'reconstructed')),
  source_path           TEXT,                   -- where the bytes came from (bucket path or reconstruction file)
  sha256                TEXT NOT NULL,
  bytes                 INTEGER NOT NULL CHECK (bytes > 0),
  archive_path          TEXT NOT NULL,          -- sealed copy in sent-letters-archive
  reconstruction        JSONB,                  -- renderer commit, method, as-of inputs, known variances
  receipt_evidence      JSONB NOT NULL,         -- receipt date, tracking number, acceptance time, evidence file
  reason                TEXT NOT NULL,
  recovered_by          TEXT NOT NULL,
  recovered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT letter_recovery_sha256_format   CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT letter_recovery_reason_present  CHECK (length(btrim(reason)) > 0),
  -- A reconstructed notice must say how it was reconstructed; an original must not claim one.
  CONSTRAINT letter_recovery_reconstruction_detail CHECK ((provenance = 'reconstructed') = (reconstruction IS NOT NULL)),
  -- The acceptance time, when known, must fall on the receipt date (Central).
  CONSTRAINT letter_recovery_mailed_at_on_date CHECK (mailed_at IS NULL OR (mailed_at AT TIME ZONE 'America/Chicago')::date = mailed_on)
);

CREATE INDEX IF NOT EXISTS idx_letter_recovery_violation ON letter_recovery_records (violation_id);
CREATE INDEX IF NOT EXISTS idx_letter_recovery_property  ON letter_recovery_records (property_id, mailed_on);

ALTER TABLE letter_recovery_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON letter_recovery_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON letter_recovery_records TO service_role;

-- Seal the recovered notice's interaction row.
CREATE OR REPLACE FUNCTION letter_recovery_seal_interaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM letter_recovery_records r WHERE r.interaction_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'letter_recovery_sealed: interaction % is a recovered mailed notice and cannot be deleted', OLD.id;
    END IF;
    IF NEW.status          IS DISTINCT FROM OLD.status
    OR NEW.sent_at         IS DISTINCT FROM OLD.sent_at
    OR NEW.content         IS DISTINCT FROM OLD.content
    OR NEW.type            IS DISTINCT FROM OLD.type
    OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
    OR NEW.violation_id    IS DISTINCT FROM OLD.violation_id
    OR NEW.property_id     IS DISTINCT FROM OLD.property_id
    OR NEW.created_at      IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'letter_recovery_sealed: interaction % is a recovered mailed notice; its mailing record cannot be changed', OLD.id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_letter_recovery_seal ON interactions;
CREATE TRIGGER trg_letter_recovery_seal
  BEFORE UPDATE OR DELETE ON interactions
  FOR EACH ROW EXECUTE FUNCTION letter_recovery_seal_interaction();

COMMIT;
