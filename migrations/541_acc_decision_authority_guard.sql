-- ============================================================================
-- 541_acc_decision_authority_guard.sql  (Ed 2026-10-20)
-- ----------------------------------------------------------------------------
-- STEP 2 of 2 for ACC decision authority. Apply ONLY AFTER the decision-
-- authority code (lib/acc/decision_authority.js, PR #239) is deployed and
-- verified. The previous code inserts letter renders relying on the 'decided'
-- default and finalizes without a decision record, so applying this earlier
-- would turn every Generate Letter into a draft and refuse every approval or
-- denial until the code arrived. Requires 540 (the columns).
--
-- WHO MAY APPROVE OR DENY AN ACC APPLICATION: database backstop so no path
-- (another screen, an API call, a script, a background job) can record a final
-- ACC decision without an authorized decision record.
--
-- Found 2026-10-20: rendering a decision letter (POST /acc-review/letter)
-- inserted acc_decisions rows that took the column DEFAULT status 'decided', so
-- a PDF render recorded an approval with no check of authority.
--
--   * acc_decisions.status DEFAULT 'decided' -> 'pending_review'.
--   * Trigger trg_acc_decisions_decision_authority (BEFORE INSERT OR UPDATE):
--     a row created as, or moving into, 'finalizing' / 'decided' with an
--     approval or denial decision_type is refused unless decision_record
--       - names an authorized decider (ed | annie | amanda);
--       - has an outcome matching decision_type (approval vs denial);
--       - cites an authority basis (governing_document | written_delegation)
--         that is not a system setting; a written delegation names the
--         instrument (library_document_id);
--       - for an approval of a driveway / paving expansion (approval_gate
--         'required', or driveway/walkway/front-yard paving words with
--         widening/extension/replacement words, unless the app classified it
--         'not_required') or of a deviation: carries the committee/Board
--         approval with date, approvers and evidence reference;
--       - for any other approval under a written delegation: is attested as a
--         routine, clearly compliant application (clearly_compliant) or carries
--         the committee/Board approval;
--       - when decided by annie or amanda: has a compliance evaluation, and on
--         an escalated case Ed's owner_review at or before decided_at.
--     Incomplete notices and requests for more information are not affected.
--   * Rows already decided are untouched: the trigger fires only on the
--     transition INTO finalizing/decided (or an insert in that state).
--
-- Record ownership: association_record (columns on acc_decisions).
-- ============================================================================
BEGIN;

ALTER TABLE acc_decisions ALTER COLUMN status SET DEFAULT 'pending_review';

CREATE OR REPLACE FUNCTION acc_decisions_decision_authority_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entering boolean;
  dt text := COALESCE(NEW.decision_type, '');
  is_approval boolean;
  is_denial boolean;
  rec jsonb := NEW.decision_record;
  cb jsonb;
  cb_ok boolean;
  scope_text text;
  paving boolean;
  deviation boolean;
BEGIN
  entering := NEW.status IN ('finalizing', 'decided')
    AND (TG_OP = 'INSERT' OR (OLD.status IS DISTINCT FROM NEW.status AND OLD.status NOT IN ('finalizing', 'decided')));
  IF NOT entering THEN RETURN NEW; END IF;

  is_denial := dt ~* '(den(y|ied|ial)|disapprov|declin)';
  is_approval := NOT is_denial AND dt ~* 'approv';
  IF NOT (is_approval OR is_denial) THEN RETURN NEW; END IF;

  IF rec IS NULL OR COALESCE(rec->>'decided_by', '') NOT IN ('ed', 'annie', 'amanda') THEN
    RAISE EXCEPTION 'decision_not_authorized: only Ed, Amanda or Annie may approve or deny an ACC application; no authorized decision_record (acc_decisions %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(rec->>'outcome', '') NOT IN ('approved', 'approved_with_conditions', 'denied')
     OR (is_approval AND rec->>'outcome' = 'denied')
     OR (is_denial AND rec->>'outcome' <> 'denied') THEN
    RAISE EXCEPTION 'decision_outcome_mismatch: decision_record outcome does not match decision_type (acc_decisions %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(rec#>>'{authority_basis,kind}', '') NOT IN ('governing_document', 'written_delegation')
     OR length(COALESCE(rec#>>'{authority_basis,reference}', '')) < 10
     OR COALESCE(rec#>>'{authority_basis,reference}', '') ~* '(bedrock_only|arc_approval_workflow|system setting)'
     OR (rec#>>'{authority_basis,kind}' = 'written_delegation' AND COALESCE(rec#>>'{authority_basis,library_document_id}', '') = '') THEN
    RAISE EXCEPTION 'decision_authority_missing: decision_record must cite the governing-document provision or the written delegation instrument (acc_decisions %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF is_approval THEN
    scope_text := COALESCE(NEW.project_summary, '') || ' ' || COALESCE(NEW.letter_body, '');
    paving := NEW.approval_gate = 'required'
      OR (COALESCE(NEW.approval_gate, '') <> 'not_required'
          AND ((scope_text ~* '(drive[ -]?way|apron|parking (pad|slab|area))'
                AND scope_text ~* '(widen|wider|extend|extension|expan|enlarg|additional (concrete|parking|width)|replac|pour|install|construct|new drive|[0-9] ?(ft|feet|foot|'') ?(wide|width))')
            OR (scope_text ~* '(walk[ -]?way|front walk|front (yard|lawn))'
                AND scope_text ~* '(widen|wider|extend|extension|expan|enlarg|additional (concrete|pavers|paving|width))')));
    cb := rec->'committee_or_board';
    deviation := COALESCE(cb->>'deviation_granted', 'false') = 'true'
      OR COALESCE(NEW.compliance_evaluation->>'deviation_requested', 'false') = 'true';
    cb_ok := cb IS NOT NULL
      AND COALESCE(cb->>'body', '') IN ('committee', 'board')
      AND COALESCE(cb->>'decision', '') IN ('approved', 'approved_with_conditions')
      AND COALESCE(cb->>'decided_on', '') <> ''
      AND length(COALESCE(cb->>'approvers', '')) >= 3
      AND length(COALESCE(cb->>'evidence_reference', '')) >= 5
      AND NOT (COALESCE(cb->>'deviation_granted', 'false') = 'true' AND length(COALESCE(cb->>'deviation_statement', '')) < 10);
    IF (paving OR deviation) AND NOT cb_ok THEN
      RAISE EXCEPTION 'committee_authorization_required: a driveway/paving expansion or deviation approval needs the committee or Board approval documented (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF rec#>>'{authority_basis,kind}' = 'written_delegation'
       AND COALESCE(rec#>>'{authority_basis,clearly_compliant}', 'false') <> 'true' AND NOT cb_ok THEN
      RAISE EXCEPTION 'delegation_scope: an approval under a written delegation must be a routine, clearly compliant application, or carry the committee/Board approval (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF rec->>'decided_by' IN ('annie', 'amanda') THEN
    IF NEW.compliance_evaluation IS NULL THEN
      RAISE EXCEPTION 'evaluation_required: Annie or Amanda may decide only with a complete compliance evaluation (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.approval_gate = 'required' OR COALESCE(NEW.compliance_evaluation->>'deviation_requested', 'false') = 'true'
        OR jsonb_array_length(COALESCE(NEW.compliance_evaluation->'conflicts', '[]'::jsonb)) > 0)
       AND (NEW.owner_review IS NULL OR COALESCE(NEW.owner_review->>'reviewed_at', '') = ''
            OR (NEW.owner_review->>'reviewed_at')::timestamptz > (rec->>'decided_at')::timestamptz) THEN
      RAISE EXCEPTION 'owner_review_required: an escalated case needs Ed''s review before Annie or Amanda decides (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acc_decisions_decision_authority ON acc_decisions;
CREATE TRIGGER trg_acc_decisions_decision_authority
  BEFORE INSERT OR UPDATE ON acc_decisions
  FOR EACH ROW EXECUTE FUNCTION acc_decisions_decision_authority_guard();

COMMIT;
