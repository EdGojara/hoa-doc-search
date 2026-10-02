-- ============================================================================
-- 480_acc_finalization_record.sql  (Issue #14, Ed 2026-10-02)
-- ----------------------------------------------------------------------------
-- SENT MEANS FINAL, ARCHIVED AND IMMUTABLE.
--
-- When "Send to homeowner (as Annie)" (or "Mark done without emailing")
-- completes an ACC case, the exact record becomes permanent evidence:
--
--   acc_finalizations (append-only; no UPDATE, no DELETE, enforced by trigger
--   and by grants) — one row per finalization: the decision, the exact letter
--   text + its sha256 + its write-once archive path, the complete packet's
--   sha256 + archive path, every source document with its sha256, the exact
--   email that was sent (from, to, subject, text, html, attachment name +
--   sha256, sent time) or delivery 'none', the reviewer, the reference,
--   community / property / homeowner. A later correction is a NEW row
--   (version > 1, supersedes_id + correction_reason); the original stays.
--
--   acc_decisions.finalization_id — set in the same update that marks the case
--   decided. From then on trg_acc_decisions_finalized_guard refuses any change
--   to the decision, letter, recipient, identity, documents, reviews or file
--   paths (write-once: a field may be filled from empty, never changed) and
--   refuses deletion. The only status change allowed is decided -> archived /
--   withdrawn (retiring a duplicate), content unchanged.
--   Cases decided before this migration (finalization_id NULL) are unaffected.
--
--   status 'finalizing' — the case is claimed while the record is filed and the
--   email is sent; it becomes 'decided' only after the homeowner communication
--   succeeded, and returns to 'pending_review' if filing or sending failed, so
--   a case is never marked complete when the homeowner was not told.
--
--   letter_draft_review_at / letter_draft_saved_at — which review a saved
--   working letter was drafted from, so a draft older than the current review
--   (or older than evidence received since) is flagged and blocks the send
--   until it is redrafted or explicitly acknowledged.
--
-- Record ownership: acc_finalizations = association_record. No existing row is
-- written; no existing case changes status.
-- ============================================================================
BEGIN;

-- 1) status 'finalizing'
ALTER TABLE acc_decisions DROP CONSTRAINT IF EXISTS acc_decisions_status_check;
ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_status_check
  CHECK (status IN ('pending_review', 'awaiting_info', 'finalizing', 'decided', 'withdrawn', 'archived'));

-- 2) draft provenance + finalization link
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS letter_draft_review_at timestamptz;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS letter_draft_saved_at timestamptz;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS finalizing_started_at timestamptz;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS finalization_id uuid;

-- 3) the append-only finalization record
CREATE TABLE IF NOT EXISTS acc_finalizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acc_decision_id      uuid NOT NULL REFERENCES acc_decisions(id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  supersedes_id        uuid REFERENCES acc_finalizations(id) ON DELETE RESTRICT,
  correction_reason    text,
  community_id         uuid,
  property_id          uuid,
  reference_number     text,
  homeowner_name       text,
  homeowner_address    text,
  decision_type        text NOT NULL,
  letter_text          text NOT NULL,
  letter_sha256        text NOT NULL,
  letter_archive_path  text NOT NULL,
  packet_sha256        text,
  packet_archive_path  text,
  documents            jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery             text NOT NULL CHECK (delivery IN ('email', 'none')),
  email                jsonb,
  decided_by_user_id   uuid,
  finalized_at         timestamptz NOT NULL DEFAULT now(),
  record_ownership     text NOT NULL DEFAULT 'association_record',
  UNIQUE (acc_decision_id, version),
  CONSTRAINT acc_finalizations_version_chain CHECK (
    (version = 1 AND supersedes_id IS NULL) OR
    (version > 1 AND supersedes_id IS NOT NULL AND correction_reason IS NOT NULL)),
  CONSTRAINT acc_finalizations_email_matches_delivery CHECK (
    (delivery = 'email' AND email IS NOT NULL) OR (delivery = 'none' AND email IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_acc_finalizations_decision ON acc_finalizations (acc_decision_id);
CREATE INDEX IF NOT EXISTS idx_acc_finalizations_community ON acc_finalizations (community_id, finalized_at DESC);

CREATE OR REPLACE FUNCTION acc_finalizations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'acc_finalizations is append-only: a finalized ACC record cannot be changed or deleted (record a correction as a new version)'
    USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS trg_acc_finalizations_append_only ON acc_finalizations;
CREATE TRIGGER trg_acc_finalizations_append_only BEFORE UPDATE OR DELETE ON acc_finalizations
  FOR EACH ROW EXECUTE FUNCTION acc_finalizations_append_only();

GRANT SELECT, INSERT ON acc_finalizations TO service_role;
GRANT SELECT ON acc_finalizations TO authenticated;

-- 4) a finalized case cannot be changed or deleted
CREATE OR REPLACE FUNCTION acc_decisions_finalized_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c text; o jsonb; n jsonb;
  protected text[] := ARRAY['decision_type','letter_body','letter_pdf_storage_path','packet_pdf_storage_path',
    'decided_by_user_id','decided_at','submitter_email','homeowner_name','homeowner_address','project_summary',
    'reference_number','community_id','management_company_id','application_pdf_storage_path',
    'photo_storage_paths','supporting_docs_storage_paths','document_manifest','finalization_id',
    'ai_review_text','ai_recommendation','ai_letter_body','current_review_text','current_ai_recommendation',
    'current_letter_body','current_review_at','letter_draft_review_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finalization_id IS NOT NULL THEN
      RAISE EXCEPTION 'ACC decision % is finalized and cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.finalization_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'decided' AND NEW.status IN ('archived', 'withdrawn')) THEN
    RAISE EXCEPTION 'ACC decision % is finalized: status cannot change from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  FOREACH c IN ARRAY protected LOOP
    o := to_jsonb(OLD) -> c; n := to_jsonb(NEW) -> c;
    IF o IS NOT NULL AND o <> 'null'::jsonb AND o <> '[]'::jsonb AND n IS DISTINCT FROM o THEN
      RAISE EXCEPTION 'ACC decision % is finalized: % cannot change (record a correction instead)', OLD.id, c USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_acc_decisions_finalized_guard ON acc_decisions;
CREATE TRIGGER trg_acc_decisions_finalized_guard BEFORE UPDATE OR DELETE ON acc_decisions
  FOR EACH ROW EXECUTE FUNCTION acc_decisions_finalized_guard();

COMMIT;
