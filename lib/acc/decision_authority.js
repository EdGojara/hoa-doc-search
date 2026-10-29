// ============================================================================
// lib/acc/decision_authority.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// WHO MAY APPROVE OR DENY AN ACC APPLICATION, and what must be on the record.
//
// Found 2026-10-20: generating an approval letter recorded a "decided" approval
// with no check of who had authority (19814 Moss Bark, 19919 Pemetic: staff
// approvals of driveway widenings, no committee/Board record, no deviation).
//
// Ed's decision model (2026-10-20), every community, every application. Four
// roles, recorded separately on every decision:
//   EVALUATED BY  Annie (primary ACC agent) or Amanda: the structured
//                 compliance evaluation (compliance_evaluation.evaluated_by).
//   DECIDED BY    ed        the owner (signed-in account, role admin, OWNER_EMAIL)
//                 committee } the authorized Architectural Committee or Board,
//                 board     } where a community has one; its decision is
//                             documented (who, when, vote/minutes/email)
//                 annie     } straightforward, clearly compliant approvals only,
//                 amanda    } under a written delegation, server-side only, and
//                             only once AI decisions are enabled (off today)
//                 Staff are NEVER the decider.
//   RECORDED BY   the signed-in user who entered the decision (server-filled,
//                 never browser-supplied). Staff may record a committee or
//                 Board decision; only Ed records his own.
//   ISSUED BY     the signed-in user who sent the letter / marked it done:
//                 any active staff member, once a valid decision is recorded
//                 and the letter matches it.
//
//   AUTHORITY. Every decision names the governing provision or written
//   delegation it rests on; a setting like arc_approval_workflow = 'bedrock_only'
//   is never authority. Bedrock (Ed, Annie, Amanda) decides only under a
//   written delegation on file or with the committee/Board decision documented:
//   Ed's review never substitutes for Board authority.
//
//   ESCALATION TO ED. Subjective judgment, aesthetics, new colors or materials,
//   driveway expansions, paving changes, variances/exceptions, conflicting
//   provisions, disputes, uncertainty and incomplete evidence. Every denial
//   goes to Ed. Annie and Amanda never decide an escalated case or a denial;
//   a committee/Board decision on an escalated case or a denial needs Ed's
//   review recorded before it is issued.
//
// Pure module (no DB, no network): every path shares one decision.
//   checkFinalDecision(row, opts)  the gate every approval/denial/letter/send
//                                  path calls
//   checkOutboundText(text)        transport check in lib/email/graph_send
// Backstop: migration 541's trigger refuses the same transition in the DB.
// ============================================================================

const DRIVE = /\b(?:drive[\s-]?ways?|driveway\s+apron|aprons?|parking\s+(?:pad|slab|area)s?|curb\s+cuts?)\b/i;
// Other front-yard paved area: an expansion of these is gated too; their
// replacement is not (only driveway replacements are escalated as ambiguous).
const WALK = /\b(?:walk[\s-]?ways?|front\s+walks?|approach\s+walk)\b/i;
const FRONT_PAVING = /\bfront\s+(?:yard|lawn)\b[^.]*\b(?:concrete|pavers?|paving|paved|slab|flagstone|gravel|asphalt)\b|\b(?:concrete|pavers?|paving|paved|slab|flagstone|gravel|asphalt)\b[^.]*\bfront\s+(?:yard|lawn)\b/i;
const NEW_PAVING = /\b(?:install(?:s|ed|ing)?|add(?:s|ed|ing)?|pour(?:s|ed|ing)?|new|lay(?:ing)?)\b/i;
// Words that mean the paved area gets bigger.
const EXPAND = /\b(?:widen(?:s|ed|ing)?|wider|width\s+(?:increase|extension)|extend(?:s|ed|ing)?|extensions?|expand(?:s|ed|ing)?|expansions?|enlarg(?:e|es|ed|ing|ement)|add(?:s|ed|ing)?\s+(?:on\s+)?(?:a\s+|an\s+)?(?:more\s+|new\s+)?(?:concrete\s+)?(?:concrete|pavement|paving|pavers?|slab|width|parking)|(?:new|install(?:s|ed|ing)?|pour(?:s|ed|ing)?)\s+(?:a\s+)?(?:concrete\s+)?parking\s+(?:pad|slab|area)|additional\s+(?:concrete|pavement|paving|parking|width|slab)|increas(?:e|es|ed|ing)\s+(?:the\s+)?(?:width|size|footprint)|side\s+(?:pad|slab)|ribbon\s+drive|circular\s+drive)\b/i;
// A full replacement (new pour). Repairs, sealing and staining are not.
const REPLACE = /\b(?:replac(?:e|es|ed|ing|ement)|re-?pour(?:s|ed|ing)?|tear\s+out|remove\s+and\s+replace|new\s+(?:concrete\s+)?drive[\s-]?way|re-?do)\b/i;
// New driveway construction, or a stated driveway width: the screener cannot
// know the community's standard (the evaluation engine compares it), so a
// driveway being built or sized is escalated unless the scope says the
// footprint is unchanged. "Pour a 30-foot wide driveway" must never pass as
// routine against an 18-foot prescribed width.
const CONSTRUCT = /\b(?:install(?:s|ed|ing)?|pour(?:s|ed|ing)?|construct(?:s|ed|ing)?|build(?:s|ing)?|create|new)\b/i;
const WIDTH_STATED = /\b\d+(?:\.\d+)?\s*[½¼¾]?\s*(?:'|’|-?\s*f(?:oo|ee)?t\b)[^.]{0,20}\b(?:wide|width)\b|\bwidth\s+(?:of\s+)?\d/i;
// The scope says, in words, that the footprint does not change.
const SAME_FOOTPRINT = /\b(?:same\s+(?:footprint|size|dimensions?|layout|location|width|shape)|existing\s+(?:footprint|dimensions?|layout|size|width)\s+(?:only|unchanged|will\s+(?:not\s+change|remain|stay))|no\s+change\s+(?:to|in)\s+(?:the\s+)?(?:size|footprint|width|dimensions?|layout)|in[\s-]kind|like[\s-]for[\s-]like|exactly\s+as\s+existing|within\s+the\s+existing\s+footprint)\b/i;

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
function toFeet(numText) {
  const m = String(numText).match(/(\d+(?:\.\d+)?)\s*([½¼¾])?/);
  if (!m) return null;
  return parseFloat(m[1]) + (m[2] ? FRACTIONS[m[2]] : 0);
}

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// "replace existing driveway (16½ ft) with new (19½ ft) driveway": two widths
// in one driveway sentence, the later one larger, means an enlargement even when
// no expansion word is used.
function widthsIncrease(sentence) {
  const nums = [];
  const re = /(\d+(?:\.\d+)?\s*[½¼¾]?)\s*(?:'|’|ft\b|feet\b|foot\b)/gi;
  let m;
  while ((m = re.exec(sentence))) { const v = toFeet(m[1]); if (v != null) nums.push(v); }
  if (nums.length < 2) return false;
  return nums[nums.length - 1] > nums[0];
}

// texts: string | string[]. Returns { required, category, reason, evidence }.
//   category: 'expansion' | 'ambiguous_replacement' | 'same_footprint_replacement' | 'none'
function classifyDrivewayScope(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => t && String(t).trim());
  const evidence = [];
  let expansion = false; let replacement = false; let sameFootprint = false;
  for (const t of list) {
    for (const s of sentences(t)) {
      if (!DRIVE.test(s)) {
        // Walkways and other front-yard paving: gated only when they grow.
        const front = FRONT_PAVING.test(s);
        if ((WALK.test(s) || front) && (EXPAND.test(s) || widthsIncrease(s) || (front && NEW_PAVING.test(s)))) {
          expansion = true; evidence.push(s.slice(0, 240));
        }
        continue;
      }
      if (EXPAND.test(s) || widthsIncrease(s)) { expansion = true; evidence.push(s.slice(0, 240)); continue; }
      if (REPLACE.test(s) || CONSTRUCT.test(s) || WIDTH_STATED.test(s)) { replacement = true; evidence.push(s.slice(0, 240)); }
      if (SAME_FOOTPRINT.test(s)) sameFootprint = true;
    }
    // A footprint statement elsewhere in the same text (e.g. a second sentence).
    if (SAME_FOOTPRINT.test(String(t))) sameFootprint = sameFootprint || replacement;
  }
  if (expansion) {
    return { required: true, category: 'expansion', reason: 'The project widens, extends or expands a driveway, parking pad or other front-yard paved area.', evidence };
  }
  if (replacement && !sameFootprint) {
    return { required: true, category: 'ambiguous_replacement', reason: 'Driveway construction, replacement or a stated driveway width without a stated same-footprint scope. Escalated rather than assumed to stay within the existing footprint or the prescribed width.', evidence };
  }
  if (replacement && sameFootprint) {
    return { required: false, category: 'same_footprint_replacement', reason: 'Driveway replacement stated to stay within the existing footprint.', evidence };
  }
  return { required: false, category: 'none', reason: null, evidence: [] };
}

// Decision types that grant an approval (acc_decisions + portal vocabularies).
function isApprovalDecision(decisionType) {
  const t = String(decisionType || '').toLowerCase();
  if (!t) return false;
  if (/disapprov|not[\s_-]*approv|no[\s_-]*approval|denied|deny/.test(t)) return false;
  return /approv/.test(t);
}

// Does this text GRANT an approval? Negations ("has not been approved",
// "cannot approve") and conditional futures ("once approved") do not count.
const GRANT = [
  /\b(?:is|are|has\s+been|have\s+been|was|were|hereby|been)\s+(?:reviewed\s+and\s+)?approved\b/i,
  // Issued letters on file say "has been reviewed and approved by the
  // Architectural Control Committee" and "Your approval is subject to the
  // following conditions" (Ed 2026-10-29, found by replaying real letters).
  /\byour\s+approval\s+is\s+subject\s+to\b/i,
  /\b(?:pleased|happy|glad)\s+to\s+(?:approve|confirm\s+(?:the\s+|your\s+)?approval|inform\s+you\s+that\s+your\s+\w+(?:\s+\w+)?\s+(?:is|has\s+been)\s+approved)\b/i,
  // The deciding body is often named by its abbreviation ("The ACC has
  // approved"); those passed the transport guard unchecked (Ed 2026-10-29).
  /\b(?:committee|board|association|we|acc|arc|drb)\s+(?:has\s+|have\s+)?(?:approved|approves|grants?\s+approval|granted\s+approval)\b/i,
  /\bapproval\s+(?:letter\s+)?(?:is\s+)?attached\b/i,
  /\battached\s+(?:is\s+)?(?:your\s+|the\s+)?approv(?:al|ed)\b/i,
  /\byou\s+(?:may|can)\s+(?:now\s+)?(?:proceed|begin|start)\b/i,
  /\bapproved\s+(?:with|subject\s+to)\s+(?:the\s+following\s+)?conditions\b/i,
];
const NEGATION = /\b(?:not|never|cannot|can't|unable|no\s+longer|isn't|hasn't|wasn't|won't|until|once|if|before|pending|after)\b[^.]{0,40}$/i;
function grantsApproval(text) {
  const t = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  for (const re of GRANT) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 60), m.index);
      const sentStart = before.lastIndexOf('.');
      const lead = sentStart >= 0 ? before.slice(sentStart + 1) : before;
      if (!NEGATION.test(lead)) return true;
    }
  }
  return false;
}

// Does this text DENY the application?
const DENY = [
  /\b(?:is|are|has\s+been|have\s+been|was|were|hereby)\s+(?:reviewed\s+and\s+)?(?:denied|declined|disapproved)\b/i,
  /\bnot\s+approved\s+as\s+submitted\b/i,
  /\bregret\s+to\s+inform\s+you\b/i,
  /\b(?:committee|board|association|we|acc|arc|drb)\s+(?:has\s+|have\s+)?(?:denied|declined|disapproved|must\s+deny)\b/i,
  /\bnot\s+(?:been\s+)?approved\s+by\s+the\s+(?:acc|arc|drb|architectural|committee|board|association)\b/i,
  /\bdenial\s+(?:letter\s+)?(?:is\s+)?attached\b/i,
];
const DENY_NEGATION = /\b(?:not|never|if|unless|before)\b[^.]{0,30}$/i;
function statesDenial(text) {
  const t = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  for (const re of DENY) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 50), m.index);
      const lead = before.slice(before.lastIndexOf('.') + 1);
      if (!DENY_NEGATION.test(lead)) return true;
    }
  }
  return false;
}

function isDenialDecision(decisionType) {
  return /den(?:y|ied|ial)|disapprov|declin/i.test(String(decisionType || ''));
}
// Final = approval or denial. Incomplete notices and requests for more
// information are processing, open to staff.
function isFinalDecision(decisionType) { return isApprovalDecision(decisionType) || isDenialDecision(decisionType); }

// ---- identities ---------------------------------------------------------------
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'egojara@bedrocktx.com').toLowerCase();
const DECIDERS = { ed: 'owner', annie: 'agent', amanda: 'agent', committee: 'body', board: 'body' };
const DECIDER_LABEL = { ed: 'Ed', annie: 'Annie', amanda: 'Amanda', committee: 'the Architectural Committee', board: 'the Board' };
// Same test as api/_require_admin requireOwner, on a getActingUser profile.
function isOwnerActor(actor) {
  return !!(actor && actor.is_active !== false && actor.role === 'admin'
    && String(actor.email || '').toLowerCase() === OWNER_EMAIL);
}

// A signed-in, active person (the recorder or sender of a decision).
function isHumanActor(actor) { return !!(actor && actor.id && actor.is_active !== false && actor.email); }
function actorStamp(actor) {
  return { user_id: actor.id, email: String(actor.email || '').toLowerCase(), name: actor.full_name || null, at: new Date().toISOString() };
}

const AUTHORITY_KINDS = ['governing_document', 'written_delegation'];
const AUTHORITY_BODIES = ['committee', 'board'];
const EVIDENCE_TYPES = ['vote', 'minutes', 'email', 'resolution', 'written_consent'];
const OUTCOMES = ['approved', 'approved_with_conditions', 'denied'];

// The committee/Board authorization (required for an approval of a paving
// expansion or of a deviation).
function validateCommitteeOrBoard(cb) {
  const errors = [];
  if (!cb || typeof cb !== 'object') return ['the committee or Board authorization is not documented'];
  if (!AUTHORITY_BODIES.includes(String(cb.body || '').toLowerCase())) errors.push('committee/Board: body must be committee or board');
  if (!OUTCOMES.includes(String(cb.decision || '').toLowerCase())) errors.push('committee/Board: decision must be approved, approved_with_conditions or denied');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cb.decided_on || ''))) errors.push('committee/Board: decided_on (YYYY-MM-DD) is required');
  if (String(cb.approvers || '').trim().length < 3) errors.push('committee/Board: who decided (names) is required');
  if (!EVIDENCE_TYPES.includes(String(cb.evidence_type || '').toLowerCase())) errors.push(`committee/Board: evidence_type must be one of ${EVIDENCE_TYPES.join(', ')}`);
  if (String(cb.evidence_reference || '').trim().length < 5) errors.push('committee/Board: evidence_reference (where the decision is recorded) is required');
  if ((cb.deviation_granted === true || cb.deviation_granted === 'true') && String(cb.deviation_statement || '').trim().length < 10) errors.push('committee/Board: the written deviation authorization is required when a deviation is granted');
  return errors;
}

// The structured compliance evaluation Annie / Amanda must complete before they
// may decide. (The current engine writes free text; until it produces this
// object, agent decisions stay blocked: fail closed.)
const MODALITIES = ['required', 'minimum', 'maximum', 'prohibited', 'discretionary'];
// judgment_required: a person must assess it (harmony, appearance, subjective
// color/material/finish). insufficient_evidence: the proof is not in the file.
const FINDINGS = ['complies', 'does_not_comply', 'needs_fact', 'not_applicable', 'judgment_required', 'insufficient_evidence'];

// AI decisions (Annie / Amanda) stay OFF until the evaluation engine is
// validated and Ed turns them on (Ed 2026-10-20). Off unless explicitly 'true'.
function aiDecisionsEnabled() { return String(process.env.ACC_AI_DECISIONS_ENABLED || '').toLowerCase() === 'true'; }
function validateEvaluation(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object') return ['no structured compliance evaluation is on the case'];
  for (const k of ['applicant_verified', 'community_verified', 'property_verified']) if (ev[k] !== true) errors.push(`${k} must be true`);
  if (!ev.completeness || ev.completeness.complete !== true) errors.push('the application is not complete under the community\'s own form requirements');
  if (!Array.isArray(ev.documents_reviewed) || !ev.documents_reviewed.length) errors.push('documents_reviewed is empty');
  if (!Array.isArray(ev.governing_documents) || !ev.governing_documents.length) errors.push('no governing documents were retrieved');
  else if (ev.governing_documents.some((d) => d.current !== true)) errors.push('a governing document is not confirmed as the current version');
  if (!Array.isArray(ev.requirements) || !ev.requirements.length) errors.push('no requirements were evaluated');
  else ev.requirements.forEach((r, i) => {
    if (!MODALITIES.includes(r.modality)) errors.push(`requirement ${i + 1}: modality must be one of ${MODALITIES.join(', ')}`);
    if (!FINDINGS.includes(r.finding)) errors.push(`requirement ${i + 1}: finding must be one of ${FINDINGS.join(', ')}`);
    const c = r.citation || {};
    if (!c.document || !c.section || !c.page) errors.push(`requirement ${i + 1}: citation needs document, section and page`);
  });
  for (const k of ['missing_evidence', 'conflicts', 'nonconformities']) if (!Array.isArray(ev[k])) errors.push(`${k} must be listed (empty if none)`);
  if (!ev.authority || !AUTHORITY_KINDS.includes(ev.authority.kind) || String(ev.authority.reference || '').trim().length < 10) errors.push('the evaluation does not identify the provision or delegation authorizing this decision');
  if (!['approved', 'approved_with_conditions', 'denied', 'request_more_info'].includes(ev.recommendation)) errors.push('recommendation is missing');
  if (!['annie', 'amanda'].includes(String(ev.evaluated_by || '').toLowerCase()) || !ev.evaluated_at) errors.push('the evaluation must name who evaluated it (Annie or Amanda) and when');
  // Never inferred from silence: the evaluation states whether the exterior
  // color or material changes and whether paving changes.
  for (const k of ['changes_color_or_material', 'changes_paving']) if (typeof ev[k] !== 'boolean') errors.push(`${k} must be stated (true or false)`);
  return errors;
}

// Words in the application itself that send it to Ed whatever the evaluation
// says (fail toward review: a false positive costs a look, a miss costs an
// unauthorized decision).
const VARIANCE_WORDS = /\b(?:variances?|waivers?|exceptions?\s+to|deviations?|exempt(?:ion)?\s+from)\b/i;
const DISPUTE_WORDS = /\b(?:appeal(?:s|ed|ing)?|dispute[sd]?|reconsider(?:ation)?|contest(?:s|ed|ing)?)\b/i;
const PAVING_SUBJECT = /\b(?:patios?|slabs?|pads?|pavers?|flatwork|hardscap(?:e|ing)|concrete|decking|stepping\s+stones?|gravel|flagstone)\b/i;
const PAVING_CHANGE = /\b(?:install(?:s|ed|ing)?|add(?:s|ed|ing)?|pour(?:s|ed|ing)?|new|extend(?:s|ed|ing)?|extensions?|expand(?:s|ed|ing)?|enlarg\w*|construct(?:s|ed|ing)?|build(?:s|ing)?)\b/i;
function pavingChange(texts) {
  for (const t of texts) for (const s of sentences(t)) if (PAVING_SUBJECT.test(s) && PAVING_CHANGE.test(s) && !SAME_FOOTPRINT.test(s)) return true;
  return false;
}

// Mandatory escalation to Ed.
function escalationTriggers(row = {}, gate) {
  const ex = row.extracted && typeof row.extracted === 'object' ? row.extracted : {};
  const scope = [row.project_summary, ex.project_summary, ex.project_description].filter(Boolean);
  const g = gate || classifyDrivewayScope(rowTexts(row));
  const t = [];
  if (g.required || row.approval_gate === 'required') t.push(g.category === 'ambiguous_replacement' ? 'ambiguous_driveway_replacement' : 'driveway_or_paving_expansion');
  else if (pavingChange(scope)) t.push('paving_change');
  if (scope.some((x) => VARIANCE_WORDS.test(x))) t.push('deviation_or_variance');
  if (scope.some((x) => DISPUTE_WORDS.test(x))) t.push('disputed');
  const ev = row.compliance_evaluation && typeof row.compliance_evaluation === 'object' ? row.compliance_evaluation : null;
  if (ev) {
    if (ev.deviation_requested === true) t.push('deviation_or_variance');
    if (ev.changes_color_or_material === true) t.push('new_color_or_material');
    if (ev.changes_paving === true && !t.some((x) => /driveway/.test(x))) t.push('paving_change');
    if (ev.disputed === true) t.push('disputed');
    if (Array.isArray(ev.conflicts) && ev.conflicts.length) t.push('conflicting_documents');
    if ((Array.isArray(ev.missing_evidence) && ev.missing_evidence.some((m) => !m || m.affects_compliance !== false))
      || (Array.isArray(ev.requirements) && ev.requirements.some((r) => r.finding === 'needs_fact'))) t.push('incomplete_evidence');
    if ((Array.isArray(ev.uncertainties) && ev.uncertainties.length) || (ev.confidence && ev.confidence !== 'high')) t.push('material_uncertainty');
    const reqs = Array.isArray(ev.requirements) ? ev.requirements.filter((r) => r.finding !== 'not_applicable') : [];
    if (reqs.some((r) => r.modality === 'discretionary' || r.finding === 'judgment_required')) {
      t.push(reqs.some((r) => r.category === 'aesthetic') ? 'aesthetic_judgment' : 'discretionary_decision');
      if (reqs.some((r) => ['color', 'material', 'finish'].includes(r.category) && (r.finding === 'judgment_required' || r.modality === 'discretionary'))) t.push('subjective_color_material_finish');
    }
    if (reqs.some((r) => r.finding === 'insufficient_evidence')) t.push('incomplete_evidence');
    if (ev.precedent_inconsistent === true) t.push('inconsistent_prior_decisions');
  }
  const rec = row.decision_record;
  if (rec && rec.committee_or_board && (rec.committee_or_board.deviation_granted === true)) t.push('deviation_or_variance');
  return [...new Set(t)];
}

// The texts that describe what was asked for / what would be decided.
function rowTexts(row = {}, extra = []) {
  const ex = row.extracted && typeof row.extracted === 'object' ? row.extracted : {};
  return [row.project_summary, ex.project_summary, ex.project_description, row.letter_body, row.ai_letter_body, ...(extra || [])].filter(Boolean);
}

const OPEN = ['pending_review', 'awaiting_info', 'finalizing'];

// What each escalation asks Ed to judge, in plain words (shown with "Owner Review Required").
const JUDGMENT = {
  driveway_or_paving_expansion: 'a driveway widening, extension, parking pad or front-yard paving increase: whether it fits the prescribed dimensions and front-yard standards, and whether a committee or Board deviation is needed',
  ambiguous_driveway_replacement: 'a driveway replacement whose footprint is not stated: whether it stays within the existing footprint and the prescribed width',
  deviation_or_variance: 'a requested deviation or exception: only the authorized committee or Board can grant it, in writing',
  conflicting_documents: 'governing provisions that conflict or are ambiguous: which one controls',
  incomplete_evidence: 'evidence needed to judge compliance is missing: request it before any decision',
  material_uncertainty: 'material uncertainty about compliance',
  aesthetic_judgment: 'architectural harmony or appearance on this particular home',
  discretionary_decision: 'a discretionary standard the documents leave to judgment',
  subjective_color_material_finish: 'a color, material or finish choice that needs a visual judgment against the home',
  inconsistent_prior_decisions: 'prior decisions on similar requests point different ways',
  new_color_or_material: 'a new exterior color or material: whether it fits this home and the community',
  paving_change: 'new or changed paving (patio, slab, pad, pavers, flatwork): location, size and drainage',
  disputed: 'an appeal or dispute of a prior decision',
};
// Escalations the governing documents reserve to the committee or Board (an
// approval needs its documented decision whoever records it).
const COMMITTEE_ONLY = ['driveway_or_paving_expansion', 'ambiguous_driveway_replacement', 'deviation_or_variance', 'conflicting_documents'];

// THE autonomy policy (Ed 2026-10-20), from a structured evaluation:
//   no_approval_required      the documents need no approval (e.g. a same-color repaint)
//   request_more_info         the application is incomplete
//   owner_review_required     any discretion, deviation, conflict, uncertainty, paving expansion
//   owner_review_noncompliance a mandatory requirement is not met: Ed reviews before any denial
//   eligible_for_ai_approval  complete, objective, every mandatory requirement complies
//   evaluation_required       no valid evaluation yet
function routeEvaluation(row = {}) {
  const ev = row.compliance_evaluation && typeof row.compliance_evaluation === 'object' ? row.compliance_evaluation : null;
  const triggers = escalationTriggers(row);
  const judgments = triggers.map((t) => JUDGMENT[t] || t);
  if (!ev) return { route: 'evaluation_required', triggers, judgments, detail: 'no structured compliance evaluation is on the case' };
  const reqs = Array.isArray(ev.requirements) ? ev.requirements.filter((r) => r.finding !== 'not_applicable') : [];
  const nonEvidence = triggers.filter((t) => t !== 'incomplete_evidence');
  if (ev.no_approval_required && ev.no_approval_required.applies === true && ev.no_approval_required.citation && !nonEvidence.length && !triggers.includes('incomplete_evidence')) {
    return { route: 'no_approval_required', triggers, judgments, detail: 'the governing documents require no approval for this work', citation: ev.no_approval_required.citation };
  }
  if (nonEvidence.length) return { route: 'owner_review_required', triggers, judgments, detail: 'judgment needed: ' + nonEvidence.map((t) => JUDGMENT[t] || t).join('; ') };
  const incomplete = (ev.completeness && ev.completeness.complete === false) || triggers.includes('incomplete_evidence');
  if (incomplete) return { route: 'request_more_info', triggers, judgments, detail: 'request the missing information; no decision yet' };
  if (reqs.some((r) => r.finding === 'does_not_comply' && r.mandatory !== false)) {
    return { route: 'owner_review_noncompliance', triggers, judgments, detail: 'a mandatory requirement is not met: Ed reviews before any denial (and any deviation is the committee\'s or Board\'s)' };
  }
  const evErr = validateEvaluation(ev);
  if (evErr.length) return { route: 'evaluation_required', triggers, judgments, detail: 'the evaluation is incomplete: ' + evErr.slice(0, 3).join('; ') };
  return { route: 'eligible_for_ai_approval', triggers, judgments, detail: 'complete, objective, and every mandatory requirement complies' };
}

// Which authorization a decision needs:
//   'denial'             a disapproval (within a delegation or governing provision)
//   'routine_delegated'  an approval of a routine application under a written delegation
//   'routine'            an approval of a routine application under a governing provision
//   'committee_or_board' an approval that is not routine (escalation triggers),
//                        or one that already carries the committee/Board decision
function decisionPath(rec, triggers, gate, row = {}) {
  if (!rec || !isApprovalDecision(rec.outcome)) return 'denial';
  const escalated = (triggers && triggers.length) || (gate && gate.required) || row.approval_gate === 'required';
  if (escalated) return 'committee_or_board';
  const ab = rec.authority_basis || {};
  if (ab.kind === 'written_delegation') return rec.committee_or_board ? 'committee_or_board' : 'routine_delegated';
  return rec.committee_or_board ? 'committee_or_board' : 'routine';
}

// Validate a decision record in the context of its case. Returns errors[].
function validateDecisionRecord(rec, row = {}, { gate, triggers } = {}) {
  const errors = [];
  if (!rec || typeof rec !== 'object') return ['no authorized decision is recorded on this case'];
  const by = String(rec.decided_by || '').toLowerCase();
  if (!DECIDERS[by]) errors.push(`"${rec.decided_by || 'unknown'}" is not authorized to decide ACC applications (Ed, the Architectural Committee or Board, or, within delegated authority, Annie or Amanda; staff never decide)`);
  if (by === 'ed' && String(rec.decided_by_email || '').toLowerCase() !== OWNER_EMAIL) errors.push('the decision is attributed to Ed but was not recorded from the owner account');
  // Every human-entered decision names who recorded it (the signed-in user).
  if (DECIDERS[by] && DECIDERS[by] !== 'agent' && !(rec.recorded_by && rec.recorded_by.user_id && rec.recorded_by.email)) errors.push('the decision does not say who recorded it');
  if (by === 'ed' && rec.recorded_by && String(rec.recorded_by.email || '').toLowerCase() !== OWNER_EMAIL) errors.push('only Ed can record his own decision');
  if (!OUTCOMES.includes(rec.outcome)) errors.push('outcome must be approved, approved_with_conditions or denied');
  if (!rec.decided_at) errors.push('decided_at is missing');
  const ab = rec.authority_basis || {};
  if (!AUTHORITY_KINDS.includes(ab.kind) || String(ab.reference || '').trim().length < 10) errors.push('the governing-document provision or written delegation authorizing this decision is not identified');
  else if (/bedrock_only|arc_approval_workflow|system\s+setting|database|default\s+workflow/i.test(ab.reference)) errors.push('a system setting is not authority; cite the governing-document provision or the written delegation');
  // A written delegation (e.g. Waterview Guidelines §1.4.4.1, the Committee's
  // delegation to the Managing Agent) is authority in its own right; the record
  // names the instrument on file in the community's library.
  if (ab.kind === 'written_delegation' && !ab.library_document_id) errors.push('a written delegation must name the delegation instrument on file for this community');
  const g = gate || classifyDrivewayScope(rowTexts(row));
  const trig = triggers || escalationTriggers({ ...row, decision_record: rec }, g);
  const approval = isApprovalDecision(rec.outcome);
  const path = decisionPath(rec, trig, g, row);
  const cbErrors = validateCommitteeOrBoard(rec.committee_or_board);
  const cbApproves = !cbErrors.length && isApprovalDecision(rec.committee_or_board.decision);
  const cbDenies = !cbErrors.length && String(rec.committee_or_board.decision) === 'denied';
  const edReviewed = by === 'ed' || !!(row.owner_review && row.owner_review.reviewed_at && String(row.owner_review.reviewed_by_email || '').toLowerCase() === OWNER_EMAIL);
  // A committee or Board decision: the body itself decided; the record carries
  // its documented decision (who, when, evidence) matching the outcome.
  if (DECIDERS[by] === 'body') {
    for (const e of cbErrors) errors.push(e);
    if (!cbErrors.length && rec.committee_or_board.body !== by) errors.push(`the decision is attributed to ${DECIDER_LABEL[by]} but the documented decision is the ${rec.committee_or_board.body}'s`);
    if (!cbErrors.length && (approval ? !cbApproves : !cbDenies)) errors.push(`the documented ${rec.committee_or_board.body} decision is "${rec.committee_or_board.decision}", not ${approval ? 'an approval' : 'a denial'}`);
    if (trig.length && !edReviewed) errors.push(`this application needs Ed's review before the ${by}'s decision is issued (${trig.join(', ')})`);
  }
  // Every denial goes to Ed.
  if (!approval && !edReviewed) errors.push("a denial needs Ed's review recorded before it is issued");
  // NO INFERRED AUTHORITY (Ed 2026-10-20). Ed, Amanda and Annie act for
  // Bedrock; Bedrock decides only under a written delegation on file, or by
  // recording the decision of the authorized committee or Board. A governing
  // provision naming the committee is not, by itself, authority for Bedrock.
  if (ab.kind === 'governing_document' && cbErrors.length && DECIDERS[by] !== 'body') {
    errors.push('a governing-document citation alone does not authorize Bedrock to decide: cite the written delegation on file, or document the committee or Board decision');
  }
  // ROUTINE vs NEEDS MORE AUTHORITY. Escalations the documents reserve to the
  // committee or Board (paving expansion, deviation, conflicting provisions)
  // need its documented decision for an approval, whoever records it. Other
  // discretion (appearance, subjective color or finish, uncertainty) is Ed's to
  // review; an approval still needs authority covering discretion: a
  // delegation Ed confirms covers discretionary decisions, or the committee or
  // Board decision. A routine approval under a delegation is attested clearly
  // compliant. Disapprovals stay within a delegation ("all others shall be
  // disapproved").
  if (approval && trig.includes('incomplete_evidence')) errors.push('evidence needed to judge compliance is missing: request it; an approval cannot rest on missing evidence');
  if (approval && path === 'committee_or_board') {
    const reserved = trig.filter((t) => COMMITTEE_ONLY.includes(t)) .length > 0 || (g.required || row.approval_gate === 'required');
    const delegatedDiscretion = ab.kind === 'written_delegation' && ab.covers_discretion === true;
    if (reserved || !delegatedDiscretion) {
      for (const e of cbErrors) errors.push(e);
      if (rec.committee_or_board && !cbErrors.length && !cbApproves) errors.push(`the ${rec.committee_or_board.body || 'committee/Board'} decision recorded is "${rec.committee_or_board.decision}", not an approval`);
    }
  }
  if (!approval && rec.committee_or_board && !cbErrors.length && !cbDenies) errors.push(`the ${rec.committee_or_board.body} decision recorded is "${rec.committee_or_board.decision}", not a denial`);
  if (path === 'routine_delegated' && ab.clearly_compliant !== true) errors.push('a routine approval under the written delegation must confirm the application clearly meets every requirement; anything else needs the committee or Board decision');
  // ANNIE / AMANDA (the autonomy policy): only a routine, objective approval of
  // a clearly compliant application, under a written delegation, with a
  // complete evaluation, and only once AI decisions are enabled. Never a
  // denial, never an escalated case (those are Ed's).
  if (DECIDERS[by] === 'agent') {
    const who = by === 'annie' ? 'Annie' : 'Amanda';
    if (!aiDecisionsEnabled()) errors.push(`${who} cannot decide yet: AI decisions are off until the evaluation engine is validated and Ed enables them`);
    if (!approval) errors.push(`${who} never denies; a noncompliant application goes to Ed for review`);
    const route = routeEvaluation({ ...row, decision_record: rec }).route;
    if (route !== 'eligible_for_ai_approval') errors.push(`${who} may approve only a complete, objective, clearly compliant application (this one is: ${route.replace(/_/g, ' ')})`);
    if (ab.kind !== 'written_delegation' || ab.clearly_compliant !== true) errors.push(`${who} may approve only under a written delegation, attested clearly compliant`);
    const evErr = validateEvaluation(row.compliance_evaluation);
    if (evErr.length) errors.push(`${who} may decide only after a complete compliance evaluation: ${evErr.slice(0, 3).join('; ')}`);
  }
  return errors;
}

// Full authority state for a case (also what the screens display).
function authorityFor(row = {}, extraTexts = []) {
  const gate = classifyDrivewayScope(rowTexts(row, extraTexts));
  if (row.approval_gate === 'required' && !gate.required) Object.assign(gate, { required: true, category: 'flagged', reason: row.approval_gate_reason || 'Flagged for owner review.' });
  const triggers = escalationTriggers(row, gate);
  const record = row.decision_record && typeof row.decision_record === 'object' ? row.decision_record : null;
  const recordErrors = record ? validateDecisionRecord(record, row, { gate, triggers }) : ['no authorized decision is recorded on this case'];
  const escalated = triggers.length > 0;
  const ownerReviewed = !!(row.owner_review && row.owner_review.reviewed_at) || !!(record && record.decided_by === 'ed' && !recordErrors.length);
  let label = 'Decision authority required';
  if (escalated && !ownerReviewed) label = 'Owner Review Required';
  if (record && !recordErrors.length) label = 'Authorized decision recorded';
  // What an approval of this case would need, before anything is recorded.
  const approval_requires = escalated
    ? 'Ed\'s review, and the committee or Board decision documented (or, for appearance-type discretion only, Ed\'s decision under a delegation that covers discretionary decisions). Judgment needed: ' + triggers.map((t) => JUDGMENT[t] || t).join('; ')
    : 'routine: Ed\'s decision (or, once enabled, Annie\'s or Amanda\'s) under the written delegation on file, attested clearly compliant; or the committee or Board decision documented and recorded by staff';
  const evaluation = routeEvaluation(row);
  return { gate, triggers, judgments: triggers.map((t) => JUDGMENT[t] || t), escalated, owner_reviewed: ownerReviewed, record, record_valid: !!record && !recordErrors.length, record_errors: record ? recordErrors : [],
    decision_path: record ? decisionPath(record, triggers, gate, row) : null, approval_requires, label, route: evaluation.route, route_detail: evaluation.detail,
    ai_decisions_enabled: aiDecisionsEnabled(), open: OPEN.includes(row.status || 'pending_review') };
}

// Where a case sits in the Requests screen (Ed 2026-10-29). Derived from the
// same authority state as the gate, never stored, so the screen cannot drift
// from what the server will actually allow.
//   pending_ed     Annie has recommended an approval or denial, or the case
//                  needs Ed's judgment, and no authorized decision is recorded.
//   submitted      in hand but not yet at a decision: no review yet, waiting on
//                  the homeowner, or Annie recommends asking for more
//                  information (staff may send that; it is not a decision).
//   ready_to_send  an authorized decision is recorded; the letter is not sent
//                  yet (or is sending).
//   completed      decided and closed.
function queueStage(row = {}, authority) {
  const a = authority || authorityFor(row);
  const status = row.status || 'pending_review';
  if (status === 'decided') return { stage: 'completed', detail: 'Decision issued' };
  if (status === 'finalizing') return { stage: 'ready_to_send', detail: 'Sending the decision letter' };
  if (!OPEN.includes(status)) return { stage: 'completed', detail: status.replace(/_/g, ' ') };
  if (a.record_valid) return { stage: 'ready_to_send', detail: 'Authorized decision recorded; letter not sent yet' };
  const rec = row.current_ai_recommendation || row.ai_recommendation || null;
  if (status === 'awaiting_info') return { stage: 'submitted', detail: 'Waiting on the homeowner for documents' };
  if (a.escalated && !a.owner_reviewed) return { stage: 'pending_ed', detail: 'Needs Ed\'s judgment: ' + a.triggers.map((t) => t.replace(/_/g, ' ')).join(', ') };
  if (rec && isFinalDecision(rec)) return { stage: 'pending_ed', detail: `Annie recommends: ${String(rec).replace(/_/g, ' ')}` };
  if (rec) return { stage: 'submitted', detail: 'Annie recommends asking for more information (staff can send)' };
  return { stage: 'submitted', detail: 'Not reviewed yet' };
}

function blockedMessage(kind, detail) {
  const base = 'An ACC approval or denial is issued only for an authorized decision recorded on the case (Ed, the Architectural Committee or Board, or, within delegated authority, Annie or Amanda). Staff can enter, document, record a committee or Board decision, request more information, and send a decision once it is recorded.';
  return `${kind}: ${detail} ${base}`;
}

// THE gate. Every approval / denial / decision-letter / send path calls it.
//   opts.decisionType  the decision being issued
//   opts.texts         the letter/email text (a "request more info" letter that
//                      says "approved" is treated as an approval)
//   opts.actor         getActingUser profile; opts.requireIssuer: issuing the
//                      decision (send / mark done / decision PDF) needs a
//                      signed-in, active person (any staff member); WHO
//                      decided is checked on the record, not on the sender
function checkFinalDecision(row = {}, opts = {}) {
  const texts = (opts.texts || []).filter(Boolean);
  const isApproval = isApprovalDecision(opts.decisionType) || texts.some(grantsApproval);
  const isDenial = !isApproval && (isDenialDecision(opts.decisionType) || texts.some(statesDenial));
  const auth = authorityFor(row, texts);
  if (!isApproval && !isDenial) return { ok: true, final: false, auth };
  if (opts.requireIssuer && !isHumanActor(opts.actor)) {
    return { ok: false, status: 401, code: 'not_authenticated', auth,
      error: blockedMessage('Sign in required', 'issuing an ACC approval or denial (sending it, marking it done, or producing the decision letter) needs a signed-in staff account.') };
  }
  if (!auth.record) {
    const why = auth.escalated ? `Owner Review Required (${auth.triggers.join(', ')}); no authorized decision is recorded on this case.` : 'no authorized decision is recorded on this case.';
    return { ok: false, status: 409, code: auth.escalated ? 'owner_review_required' : 'decision_record_required', auth, error: blockedMessage('Decision authority required', why) };
  }
  if (!auth.record_valid) {
    return { ok: false, status: 409, code: 'decision_record_invalid', auth, error: blockedMessage('Decision record incomplete', auth.record_errors.join('; ') + '.') };
  }
  if (isApproval !== isApprovalDecision(auth.record.outcome)) {
    return { ok: false, status: 409, code: 'decision_outcome_mismatch', auth, error: blockedMessage('Decision mismatch', `the recorded decision is "${auth.record.outcome}", but this would issue ${isApproval ? 'an approval' : 'a denial'}.`) };
  }
  // The letter must not say a body decided when it did not (12 staff letters,
  // Jul-Oct 2026, said "the Committee has reviewed ... and is pleased to
  // approve" with no committee action on file).
  const claimed = texts.map(claimsBodyDecision).find(Boolean);
  if (claimed && claimed !== auth.record.decided_by) {
    return { ok: false, status: 409, code: 'letter_misattributes_decision', auth, error: blockedMessage('Letter wording', `the letter says the ${claimed === 'board' ? 'Board' : 'Committee'} decided, but the recorded decision is ${DECIDER_LABEL[auth.record.decided_by] || auth.record.decided_by}'s. Reword the letter to say who decided.`) };
  }
  return { ok: true, final: true, auth };
}

// Which body a letter says decided ("the Architectural Committee has reviewed
// ... and is pleased to approve"): 'committee' | 'board' | null.
const BODY_CLAIM = /\b(?:(architectural\s+(?:review\s+|control\s+)?committee|committee|ACC|ARC)|(board(?:\s+of\s+directors)?))\b[^.]{0,120}?\b(?:has|have)\s+(?:reviewed[^.]{0,80}?and\s+)?(?:is\s+|are\s+)?(?:pleased\s+to\s+)?(?:approved?|approves|grant(?:s|ed)?\s+approval|denied|disapproved|declined)\b/i;
function claimsBodyDecision(text) {
  const m = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(BODY_CLAIM);
  if (!m) return null;
  return m[2] ? 'board' : 'committee';
}

// Build a decision record from the in-app form. The decider comes from the
// form; the recorder is the signed-in actor (never a browser-supplied name).
//   decided_by 'ed'                  only Ed may record it
//   decided_by 'committee' | 'board' any signed-in staff member may record it,
//                                    with the body's documented decision
//   decided_by 'annie' | 'amanda'    never from a screen (agent workflow only)
// Returns { rec } or { error }.
function recordDecision(actor, input = {}, row = {}) {
  if (!isHumanActor(actor)) return { error: 'sign in to record a decision' };
  const by = String(input.decided_by || 'ed').toLowerCase().trim();
  if (!DECIDERS[by]) return { error: `"${input.decided_by}" cannot decide an ACC application; staff record the decision of Ed, the Architectural Committee or the Board` };
  if (DECIDERS[by] === 'agent') return { error: "Annie's and Amanda's decisions are made by the agent workflow, never entered from a screen" };
  if (by === 'ed' && !isOwnerActor(actor)) return { error: 'only Ed can record his own decision; staff record a committee or Board decision' };
  const c = input.committee_or_board && Object.keys(input.committee_or_board).length ? input.committee_or_board : null;
  const cb = c ? {
    body: DECIDERS[by] === 'body' ? by : String(c.body || '').toLowerCase().trim(),
    decision: String(c.decision || '').toLowerCase().trim(),
    decided_on: String(c.decided_on || '').trim(),
    approvers: String(c.approvers || '').trim(),
    evidence_type: String(c.evidence_type || '').toLowerCase().trim(),
    evidence_reference: String(c.evidence_reference || '').trim(),
    deviation_granted: c.deviation_granted === true || c.deviation_granted === 'true',
    deviation_statement: String(c.deviation_statement || '').trim() || null,
  } : null;
  if (DECIDERS[by] === 'body' && !cb) return { error: `record the ${by}'s decision: who decided, when, and the vote, minutes or email` };
  const ev = row.compliance_evaluation && typeof row.compliance_evaluation === 'object' ? row.compliance_evaluation : null;
  const rec = {
    decided_by: by,
    decided_by_user_id: by === 'ed' ? actor.id : null,
    decided_by_email: by === 'ed' ? String(actor.email || '').toLowerCase() : null,
    decided_by_name: by === 'ed' ? (actor.full_name || 'Ed Gojara') : (cb ? cb.approvers : null),
    outcome: String(input.outcome || '').toLowerCase().trim(),
    decided_at: new Date().toISOString(),
    evaluated_by: ev && ev.evaluated_by ? String(ev.evaluated_by).toLowerCase() : null,
    recorded_by: actorStamp(actor),
    authority_basis: {
      kind: String(input.authority_kind || '').trim(),
      reference: String(input.authority_reference || '').trim(),
      library_document_id: String(input.authority_library_document_id || '').trim() || null,
      library_document_title: String(input.authority_library_document_title || '').trim() || null,
      clearly_compliant: input.clearly_compliant === true || input.clearly_compliant === 'true',
      // Ed's confirmation that the cited delegation reaches discretionary
      // (appearance-type) decisions; never paving, deviation or conflicts.
      covers_discretion: by === 'ed' && (input.covers_discretion === true || input.covers_discretion === 'true'),
    },
    committee_or_board: cb,
    conditions: String(input.conditions || '').trim() || null,
    notes: String(input.notes || '').trim() || null,
  };
  return { rec };
}
// Ed's own decision (for callers and tests that build one directly).
function ownerDecisionRecord(actor, input = {}) {
  const r = recordDecision(actor, { ...input, decided_by: 'ed' });
  if (r.error) throw new Error(r.error);
  return r.rec;
}

// Transport check (lib/email/graph_send): an outbound email about an
// architectural application that grants or denies it needs the authorized case.
const ACC_CONTEXT = /\b(?:architectural|ACC|ARC|architectural\s+(?:review|control)|improvement\s+application|home\s+improvement)\b/i;
function checkOutboundText(text) {
  const plain = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const approval = grantsApproval(plain);
  const denial = !approval && statesDenial(plain);
  if (!approval && !denial) return { ok: true };
  const drive = classifyDrivewayScope(plain);
  if (!ACC_CONTEXT.test(plain) && !drive.required) return { ok: true };
  return { ok: false, code: 'decision_not_authorized', approval, denial };
}

// What to stamp on the row so the DB trigger sees the app's classification.
function stampFor(gate) {
  if (gate.required) return { approval_gate: 'required', approval_gate_reason: gate.reason };
  if (gate.category === 'same_footprint_replacement') return { approval_gate: 'not_required', approval_gate_reason: gate.reason };
  return null;
}

module.exports = {
  classifyDrivewayScope, isApprovalDecision, isDenialDecision, isFinalDecision, grantsApproval, statesDenial,
  isOwnerActor, isHumanActor, actorStamp, OWNER_EMAIL, DECIDERS, DECIDER_LABEL, AUTHORITY_KINDS, EVIDENCE_TYPES, OUTCOMES,
  validateCommitteeOrBoard, validateEvaluation, validateDecisionRecord, escalationTriggers, decisionPath,
  routeEvaluation, aiDecisionsEnabled, JUDGMENT, COMMITTEE_ONLY,
  authorityFor, queueStage, checkFinalDecision, recordDecision, ownerDecisionRecord, claimsBodyDecision, checkOutboundText, stampFor, rowTexts, OPEN,
};
