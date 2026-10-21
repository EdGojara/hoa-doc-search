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
--       - names an authorized decider: ed, the committee or board (its
--         documented decision, same body, matching outcome), or annie/amanda;
--         staff are never the decider (Ed 2026-10-20);
--       - names who recorded it (recorded_by.user_id) for a human-entered
--         decision (ed, committee, board);
--       - for a denial, or a committee/Board approval of a paving expansion or
--         deviation, decided by someone other than Ed: carries Ed's review
--         (owner_review by the owner account);
--       - has an outcome matching decision_type (approval vs denial);
--       - cites a written delegation on file (library_document_id), or carries
--         the documented committee/Board decision (a governing-document citation
--         alone is not authority for Bedrock); never a system setting;
--       - for an approval of a driveway / paving expansion (approval_gate
--         'required', or driveway/walkway/front-yard paving words with
--         widening/extension/replacement/construction words, unless the app
--         classified it 'not_required') or of a deviation: carries the
--         committee/Board approval with date, approvers and evidence reference;
--       - for any other approval under a written delegation: is attested as a
--         routine, clearly compliant application (or as covered by a delegation
--         of discretion), or carries the committee/Board approval;
--       - when decided by annie or amanda: is an APPROVAL (never a denial), under
--         a written delegation attested clearly compliant, with a compliance
--         evaluation, and not a paving expansion, deviation or conflict.
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
  cb_valid boolean;
  scope_text text;
  paving boolean := false;
  deviation boolean := false;
  decider text;
  ed_reviewed boolean;
BEGIN
  entering := NEW.status IN ('finalizing', 'decided')
    AND (TG_OP = 'INSERT' OR (OLD.status IS DISTINCT FROM NEW.status AND OLD.status NOT IN ('finalizing', 'decided')));
  IF NOT entering THEN RETURN NEW; END IF;

  is_denial := dt ~* '(den(y|ied|ial)|disapprov|declin)';
  is_approval := NOT is_denial AND dt ~* 'approv';
  IF NOT (is_approval OR is_denial) THEN RETURN NEW; END IF;

  decider := COALESCE(rec->>'decided_by', '');
  IF rec IS NULL OR decider NOT IN ('ed', 'committee', 'board', 'annie', 'amanda') THEN
    RAISE EXCEPTION 'decision_not_authorized: an ACC approval or denial must be decided by Ed, the Architectural Committee or Board, or Annie/Amanda within delegated authority (staff never decide); no authorized decision_record (acc_decisions %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF decider IN ('ed', 'committee', 'board') AND COALESCE(rec#>>'{recorded_by,user_id}', '') = '' THEN
    RAISE EXCEPTION 'recorder_missing: the decision_record must name the signed-in user who recorded it (acc_decisions %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Ed's review: Ed decided, or the owner account reviewed the case.
  ed_reviewed := decider = 'ed'
    OR (NEW.owner_review IS NOT NULL AND COALESCE(NEW.owner_review->>'reviewed_at', '') <> ''
        AND lower(COALESCE(NEW.owner_review->>'reviewed_by_email', '')) = 'egojara@bedrocktx.com');
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

  -- The committee/Board record, if any (both outcomes).
  cb := rec->'committee_or_board';
  cb_valid := cb IS NOT NULL
    AND COALESCE(cb->>'body', '') IN ('committee', 'board')
    AND COALESCE(cb->>'decision', '') IN ('approved', 'approved_with_conditions', 'denied')
    AND COALESCE(cb->>'decided_on', '') <> ''
    AND length(COALESCE(cb->>'approvers', '')) >= 3
    AND length(COALESCE(cb->>'evidence_reference', '')) >= 5
    AND NOT (COALESCE(cb->>'deviation_granted', 'false') = 'true' AND length(COALESCE(cb->>'deviation_statement', '')) < 10);
  cb_ok := cb_valid AND ((is_approval AND cb->>'decision' IN ('approved', 'approved_with_conditions')) OR (is_denial AND cb->>'decision' = 'denied'));

  -- A committee or Board decision carries that body's documented decision.
  IF decider IN ('committee', 'board') AND NOT (cb_ok AND cb->>'body' = decider) THEN
    RAISE EXCEPTION 'committee_decision_undocumented: a % decision needs its documented decision (same body, matching outcome, date, who decided, evidence) (acc_decisions %)', decider, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Every denial goes to Ed.
  IF is_denial AND NOT ed_reviewed AND decider NOT IN ('annie', 'amanda') THEN  -- agents: refused below (never deny)
    RAISE EXCEPTION 'owner_review_required: a denial needs Ed''s review recorded before it is issued (acc_decisions %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- No inferred authority: a governing-document citation alone does not let
  -- Bedrock decide; it needs the documented committee/Board decision.
  IF rec#>>'{authority_basis,kind}' = 'governing_document' AND NOT cb_ok THEN
    RAISE EXCEPTION 'decision_authority_missing: without a written delegation on file, the committee or Board decision must be documented (acc_decisions %)', NEW.id
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
    deviation := COALESCE(cb->>'deviation_granted', 'false') = 'true'
      OR COALESCE(NEW.compliance_evaluation->>'deviation_requested', 'false') = 'true';
    IF (paving OR deviation) AND NOT cb_ok THEN
      RAISE EXCEPTION 'committee_authorization_required: a driveway/paving expansion or deviation approval needs the committee or Board approval documented (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (paving OR deviation) AND decider IN ('committee', 'board') AND NOT ed_reviewed THEN
      RAISE EXCEPTION 'owner_review_required: a % approval of a paving expansion or deviation needs Ed''s review recorded before it is issued (acc_decisions %)', decider, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF rec#>>'{authority_basis,kind}' = 'written_delegation'
       AND COALESCE(rec#>>'{authority_basis,clearly_compliant}', 'false') <> 'true'
       AND COALESCE(rec#>>'{authority_basis,covers_discretion}', 'false') <> 'true' AND NOT cb_ok THEN
      RAISE EXCEPTION 'delegation_scope: an approval under a written delegation must be a routine, clearly compliant application, or carry the committee/Board approval (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Annie / Amanda: only a routine approval of a clearly compliant application,
  -- under a written delegation, with an evaluation, never escalated, never a denial.
  IF rec->>'decided_by' IN ('annie', 'amanda') THEN
    IF is_denial THEN
      RAISE EXCEPTION 'agent_denial_refused: Annie and Amanda never deny; a noncompliant application goes to Ed (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.compliance_evaluation IS NULL THEN
      RAISE EXCEPTION 'evaluation_required: Annie or Amanda may decide only with a complete compliance evaluation (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF rec#>>'{authority_basis,kind}' <> 'written_delegation' OR COALESCE(rec#>>'{authority_basis,clearly_compliant}', 'false') <> 'true'
       OR NEW.approval_gate = 'required' OR paving OR deviation
       OR jsonb_array_length(COALESCE(NEW.compliance_evaluation->'conflicts', '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'owner_review_required: an escalated or non-routine case is Ed''s to decide, not Annie''s or Amanda''s (acc_decisions %)', NEW.id
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
