-- ============================================================================
-- 576_acc_revised_decisions.sql  (Ed 2026-11-24)
-- ----------------------------------------------------------------------------
-- RECONSIDERATION AND REVISED DECISIONS on a finalized ACC application.
-- A finalized case stays exactly as it was (migration 480: letter, decision,
-- documents, dates, reviews and status are locked). What happens AFTER the
-- decision lives beside it, on the same application number:
--
--   acc_case_supplements (append-only)  correspondence, documents and photos
--     received after the decision. One row per email or upload; each file with
--     its storage path and sha256. association_record.
--   acc_reconsiderations  one row per reconsideration of a case: why it was
--     opened, Annie's review and recommendation on the supplemental evidence,
--     the working letter, the owner's approval, and the decision version it
--     produced. At most one is active per case. Drafts and reviews are
--     workpaper; the issued decision is the acc_finalizations version.
--   acc_finalizations.reconsideration_id + trigger  a REVISED decision is a new
--     version (2, 3, ...) of the same case. The database accepts it only when it
--     supersedes the latest version of that same case AND comes from a
--     reconsideration of that case that is being issued with the owner's
--     approval recorded. Version 1 is unaffected. A case decided before sealed
--     records existed (no version 1 on file) can be revised too: its original stays
--     on acc_decisions, a snapshot is kept on the reconsideration, and its revised
--     decision is version 2 with nothing to supersede in this table.
--   acc_decisions.duplicate_of_id  a withdrawn duplicate names the application
--     it duplicates. The record and its documents are kept.
--
-- The latest acc_finalizations version is the effective decision; nothing copies
-- it onto acc_decisions, so it cannot drift. No decision, date, fee or billing
-- field changes: a reconsideration creates no application, so no second fee.
--
-- Rows changed: 2 (the two applications withdrawn 2026-11-24 as duplicates get
-- duplicate_of_id). Rollback: revert the code; the columns and tables are unused
-- by older code. acc_case_supplements is history and is never dropped.
-- ============================================================================
BEGIN;

-- 1) duplicates name their original
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS duplicate_of_id uuid REFERENCES acc_decisions(id) ON DELETE RESTRICT;
ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_duplicate_not_self CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id);
CREATE INDEX IF NOT EXISTS idx_acc_decisions_duplicate_of ON acc_decisions (duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;
UPDATE acc_decisions SET duplicate_of_id = 'b7ab635e-4ed9-4c62-ba83-0ec794e14a06'
 WHERE id IN ('7988422a-b406-4b83-b8e7-1c5f63ee9390', '72bdea21-a787-4312-8053-1cb0bb8bcea4')
   AND status = 'withdrawn' AND duplicate_of_id IS NULL
   AND EXISTS (SELECT 1 FROM acc_decisions o WHERE o.id = 'b7ab635e-4ed9-4c62-ba83-0ec794e14a06');

-- 2) supplemental evidence (append-only)
CREATE TABLE IF NOT EXISTS acc_case_supplements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acc_decision_id   uuid NOT NULL REFERENCES acc_decisions(id) ON DELETE RESTRICT,
  community_id      uuid,
  kind              text NOT NULL CHECK (kind IN ('email', 'upload')),
  source_ref        text,
  email_message_id  uuid,
  from_email        text,
  from_name         text,
  subject           text,
  body_text         text,
  note              text,
  documents         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(documents) = 'array'),
  received_at       timestamptz NOT NULL DEFAULT now(),
  matched_by        text[] NOT NULL DEFAULT ARRAY[]::text[],
  possible_new_request boolean NOT NULL DEFAULT false,
  added_by_user_id  uuid,
  added_by          text NOT NULL CHECK (length(btrim(added_by)) > 0),
  record_ownership  text NOT NULL DEFAULT 'association_record',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acc_case_supplements_source ON acc_case_supplements (acc_decision_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acc_case_supplements_case ON acc_case_supplements (acc_decision_id, received_at);
CREATE OR REPLACE FUNCTION acc_case_supplements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'acc_case_supplements is append-only: evidence received on a case cannot be changed or deleted' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS trg_acc_case_supplements_append_only ON acc_case_supplements;
CREATE TRIGGER trg_acc_case_supplements_append_only BEFORE UPDATE OR DELETE ON acc_case_supplements
  FOR EACH ROW EXECUTE FUNCTION acc_case_supplements_append_only();

-- 3) reconsiderations
CREATE TABLE IF NOT EXISTS acc_reconsiderations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acc_decision_id   uuid NOT NULL REFERENCES acc_decisions(id) ON DELETE RESTRICT,
  community_id      uuid,
  prior_finalization_id uuid REFERENCES acc_finalizations(id) ON DELETE RESTRICT,
  prior_snapshot    jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ready', 'issuing', 'issued', 'closed')),
  opened_reason     text NOT NULL CHECK (length(btrim(opened_reason)) > 0),
  opened_by_user_id uuid,
  opened_by         text NOT NULL,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  review_text       text,
  recommendation    text,
  reviewed_letter_body text,
  review_at         timestamptz,
  review_basis      jsonb,
  letter_body       text,
  outcome           text,
  reason            text,
  letter_saved_at   timestamptz,
  letter_saved_by   uuid,
  decision_record   jsonb,
  owner_approval    jsonb,
  issued_at         timestamptz,
  finalization_id   uuid REFERENCES acc_finalizations(id) ON DELETE RESTRICT,
  closed_at         timestamptz,
  closed_by_user_id uuid,
  closed_reason     text,
  record_ownership  text NOT NULL DEFAULT 'workpaper',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acc_reconsiderations_issued_complete CHECK (status <> 'issued' OR (finalization_id IS NOT NULL AND owner_approval IS NOT NULL AND decision_record IS NOT NULL AND issued_at IS NOT NULL)),
  CONSTRAINT acc_reconsiderations_issuing_approved CHECK (status <> 'issuing' OR (owner_approval IS NOT NULL AND decision_record IS NOT NULL)),
  CONSTRAINT acc_reconsiderations_closed_reason_given CHECK (status <> 'closed' OR length(btrim(coalesce(closed_reason, ''))) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acc_reconsiderations_active ON acc_reconsiderations (acc_decision_id) WHERE status IN ('open', 'ready', 'issuing');
CREATE INDEX IF NOT EXISTS idx_acc_reconsiderations_case ON acc_reconsiderations (acc_decision_id, opened_at);
-- An issued or closed reconsideration is history.
CREATE OR REPLACE FUNCTION acc_reconsiderations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ACC reconsideration % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('issued', 'closed') THEN
    RAISE EXCEPTION 'ACC reconsideration % is % and cannot change (open a new one)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.acc_decision_id IS DISTINCT FROM OLD.acc_decision_id OR NEW.prior_finalization_id IS DISTINCT FROM OLD.prior_finalization_id
     OR NEW.prior_snapshot IS DISTINCT FROM OLD.prior_snapshot THEN
    RAISE EXCEPTION 'ACC reconsideration % cannot move to another case or decision', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_acc_reconsiderations_guard ON acc_reconsiderations;
CREATE TRIGGER trg_acc_reconsiderations_guard BEFORE UPDATE OR DELETE ON acc_reconsiderations
  FOR EACH ROW EXECUTE FUNCTION acc_reconsiderations_guard();
DROP TRIGGER IF EXISTS trg_acc_reconsiderations_updated_at ON acc_reconsiderations;
CREATE TRIGGER trg_acc_reconsiderations_updated_at BEFORE UPDATE ON acc_reconsiderations
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- 4) a revised decision is a new version, from an owner-approved reconsideration
ALTER TABLE acc_finalizations ADD COLUMN IF NOT EXISTS reconsideration_id uuid REFERENCES acc_reconsiderations(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_acc_finalizations_reconsideration ON acc_finalizations (reconsideration_id) WHERE reconsideration_id IS NOT NULL;
ALTER TABLE acc_finalizations DROP CONSTRAINT IF EXISTS acc_finalizations_version_chain;
ALTER TABLE acc_finalizations ADD CONSTRAINT acc_finalizations_version_chain CHECK (
  (version = 1 AND supersedes_id IS NULL) OR
  (version > 1 AND correction_reason IS NOT NULL AND (supersedes_id IS NOT NULL OR reconsideration_id IS NOT NULL)));
CREATE OR REPLACE FUNCTION acc_finalizations_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_row acc_finalizations%ROWTYPE;
  rec acc_reconsiderations%ROWTYPE;
  dec_status text;
  dec_fin uuid;
BEGIN
  IF NEW.version = 1 THEN
    IF NEW.reconsideration_id IS NOT NULL THEN
      RAISE EXCEPTION 'an original decision (version 1) does not come from a reconsideration' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status, finalization_id INTO dec_status, dec_fin FROM acc_decisions WHERE id = NEW.acc_decision_id FOR UPDATE;
  IF dec_status IS DISTINCT FROM 'decided' THEN
    RAISE EXCEPTION 'only a decided ACC application can have a revised decision' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO last_row FROM acc_finalizations WHERE acc_decision_id = NEW.acc_decision_id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    -- decided before sealed records: the original is on acc_decisions (version 1 in history)
    IF dec_fin IS NOT NULL OR NEW.version <> 2 OR NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'a revised ACC decision must supersede the latest decision of the same case' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.supersedes_id IS DISTINCT FROM last_row.id OR NEW.version <> last_row.version + 1 THEN
    RAISE EXCEPTION 'a revised ACC decision must supersede the latest decision of the same case' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO rec FROM acc_reconsiderations WHERE id = NEW.reconsideration_id;
  IF NOT FOUND OR rec.acc_decision_id <> NEW.acc_decision_id OR rec.prior_finalization_id IS DISTINCT FROM NEW.supersedes_id OR rec.status <> 'issuing'
     OR rec.owner_approval IS NULL OR coalesce(rec.owner_approval->>'user_id', '') = '' OR coalesce(rec.owner_approval->>'email', '') = '' THEN
    RAISE EXCEPTION 'a revised ACC decision needs a reconsideration of the same decision, approved by the owner' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decision_type IS DISTINCT FROM rec.outcome OR NEW.letter_sha256 IS DISTINCT FROM (rec.owner_approval->>'letter_sha256') THEN
    RAISE EXCEPTION 'the revised ACC decision must be the outcome and letter the owner approved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_acc_finalizations_revision_guard ON acc_finalizations;
CREATE TRIGGER trg_acc_finalizations_revision_guard BEFORE INSERT ON acc_finalizations
  FOR EACH ROW EXECUTE FUNCTION acc_finalizations_revision_guard();

-- 5) access: server only (staff screens go through the API)
ALTER TABLE acc_case_supplements ENABLE ROW LEVEL SECURITY;
ALTER TABLE acc_reconsiderations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON acc_case_supplements, acc_reconsiderations FROM anon, authenticated;
REVOKE ALL ON acc_case_supplements, acc_reconsiderations FROM service_role;
GRANT SELECT, INSERT ON acc_case_supplements TO service_role;
GRANT SELECT, INSERT, UPDATE ON acc_reconsiderations TO service_role;

COMMIT;
