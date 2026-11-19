-- ============================================================================
-- 569_acc_routine_annie.sql  (Ed 2026-11-18)
-- ----------------------------------------------------------------------------
-- ROUTINE ACC WITHOUT THE OWNER BOTTLENECK. Ed: "Annie should process and
-- finalize routine ACC applications without sending them to me." Only two kinds
-- need Ed's approval: new concrete (or an extension/expansion of a concrete
-- surface) and a driveway modification (size, shape, footprint, layout,
-- configuration). A like-for-like driveway replacement does not.
--
-- What the governing documents require is unchanged: Bedrock (Ed or Annie)
-- decides only under a written delegation on file; otherwise the Architectural
-- Committee or Board decides and staff record it.
--
--   * communities.acc_delegation jsonb: the written instrument under which the
--     managing agent decides ACC applications for that community (library
--     document, provision, scope, appeal route). Set here for Waterview Estates
--     only: Architectural Guidelines (2016) §1.4.4.1-1.4.4.2 ("The Committee
--     delegates to the Managing Agent the initial review of each application
--     and authorizes the Managing Agent to make decisions on its behalf";
--     clearly compliant -> approved, all others disapproved; a denial may be
--     appealed to the Committee within 30 days, §1.4.5.1). No delegation was
--     found in the library for Lakes of Pine Forest, Quail Ridge, Still Creek
--     Ranch, Canyon Gate or August Meadows; those stay with their committee or
--     Board until an instrument is filed.
--   * Trigger function acc_decisions_decision_authority_guard() replaced:
--       - a denial no longer needs Ed's review;
--       - approval_gate 'required' (the app's stamp for Ed's two exceptions)
--         needs Ed's review/decision for any outcome;
--       - Annie/Amanda may approve OR deny a routine case (approval_gate
--         'not_required') under a written delegation (routine_delegated) on a
--         recorded review (decision_record.review_at or compliance_evaluation);
--         never a paving expansion, deviation or Ed exception.
--     Every other check (authorized decider, recorder, outcome match, no
--     inferred authority, committee/Board documentation, driveway/paving and
--     deviation approvals needing the committee/Board record) is unchanged.
--   * Rows already decided are untouched (the trigger fires only on the move
--     into finalizing/decided).
--
-- Record ownership: association_record (communities config; acc_decisions).
-- ============================================================================
BEGIN;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS acc_delegation jsonb;
COMMENT ON COLUMN communities.acc_delegation IS 'Written instrument under which the managing agent (Bedrock: Ed or Annie) decides ACC applications: {library_document_id, library_document_title, reference, scope, appeal, verified_at, source}. NULL = no delegation on file; the committee or Board decides.';

UPDATE communities SET acc_delegation = jsonb_build_object(
    'library_document_id', '6eeb8060-9b0a-4e88-b714-45f775a0442a',
    'library_document_title', 'Waterview Estates Architectural Guidelines (2016)',
    'reference', 'Architectural Guidelines (2016) §1.4.4.1-1.4.4.2: the Committee delegates to the Managing Agent the initial review of each application and authorizes it to make decisions on the Committee''s behalf',
    'scope', 'approve applications that clearly meet all requirements; all others disapproved (§1.4.4.2)',
    'appeal', 'a Managing Agent denial may be appealed to the Architectural Control Committee within 30 days (§1.4.5.1); a Committee denial to the Board within 30 days (§1.4.5.6-1.4.5.7)',
    'verified_at', '2026-11-18',
    'source', 'library_documents 6eeb8060-9b0a-4e88-b714-45f775a0442a, read 2026-11-18')
  WHERE id = 'a0000000-0000-4000-8000-000000000001' AND name = 'Waterview Estates' AND acc_delegation IS NULL
    AND EXISTS (SELECT 1 FROM library_documents d WHERE d.id = '6eeb8060-9b0a-4e88-b714-45f775a0442a' AND d.community_id = 'a0000000-0000-4000-8000-000000000001');

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
  -- (2026-11-18) Denials no longer need Ed's review; only Ed's two exceptions
  -- (approval_gate 'required') do, below.
  IF NEW.approval_gate = 'required' AND NOT ed_reviewed THEN
    RAISE EXCEPTION 'owner_review_required: a concrete addition or driveway modification needs Ed''s approval recorded before it is issued (acc_decisions %)', NEW.id
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
    paving := (NEW.approval_gate = 'required' AND COALESCE(NEW.approval_gate_reason, '') NOT LIKE 'New concrete%')
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
       AND COALESCE(rec#>>'{authority_basis,covers_discretion}', 'false') <> 'true'
       AND NOT (decider IN ('annie', 'amanda') AND COALESCE(rec#>>'{authority_basis,routine_delegated}', 'false') = 'true')
       AND NOT cb_ok THEN
      RAISE EXCEPTION 'delegation_scope: an approval under a written delegation must be a routine, clearly compliant application, or carry the committee/Board approval (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Annie / Amanda (Ed 2026-11-18): a routine approval or denial under the
  -- community's written delegation, resting on a recorded review; never one of
  -- Ed's exceptions (approval_gate 'required'), a paving expansion, a deviation
  -- or a committee/Board matter.
  IF decider IN ('annie', 'amanda') THEN
    IF NEW.compliance_evaluation IS NULL AND COALESCE(rec->>'review_at', '') = '' THEN
      RAISE EXCEPTION 'evaluation_required: Annie or Amanda may decide only on a recorded review (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF rec#>>'{authority_basis,kind}' <> 'written_delegation'
       OR COALESCE(rec#>>'{authority_basis,routine_delegated}', 'false') <> 'true'
       OR COALESCE(rec#>>'{authority_basis,library_document_id}', '') = '' THEN
      RAISE EXCEPTION 'decision_authority_missing: Annie or Amanda decide only under the community''s written delegation (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(NEW.approval_gate, '') <> 'not_required' OR paving OR deviation THEN
      RAISE EXCEPTION 'owner_review_required: a concrete addition, driveway modification or deviation is not Annie''s or Amanda''s to decide (acc_decisions %)', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
