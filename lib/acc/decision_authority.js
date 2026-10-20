// ============================================================================
// lib/acc/decision_authority.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// WHO MAY APPROVE OR DENY AN ACC APPLICATION, and what must be on the record.
//
// Found 2026-10-20: generating an approval letter recorded a "decided" approval
// with no check of who had authority (19814 Moss Bark, 19919 Pemetic: staff
// approvals of driveway widenings, no committee/Board record, no deviation).
// Ed's authorization model, every community, every architectural application:
//
//   DECIDERS. Only three identities may approve or deny:
//     ed      the owner (signed-in account, role admin, OWNER_EMAIL)
//     annie   the authorized ACC agent   } server-side only, never via a staff
//     amanda  the authorized AI manager  } screen or API, and only with a
//                                          complete documented compliance
//                                          evaluation (validateEvaluation)
//   Everyone else (staff, other agents) may enter, classify, upload, evaluate,
//   draft and request more information, but may not record a final approval or
//   denial or issue a decision letter.
//
//   AUTHORITY. Every decision record names the governing-document provision or
//   written delegation that lets this decider decide. A database setting such as
//   arc_approval_workflow = 'bedrock_only' is never authority.
//
//   ESCALATION TO ED. Driveway widening / extension / parking pads / other
//   front-yard paving increases (and ambiguous driveway replacements),
//   deviations or variances, conflicting provisions, incomplete evidence and
//   material uncertainty. Annie and Amanda may not decide an escalated case
//   until Ed has reviewed it, and an approval of a paving expansion or of a
//   deviation also needs the committee or Board authorization documented
//   (Ed's review never substitutes for it).
//
// Pure module (no DB, no network): every path shares one decision.
//   checkFinalDecision(row, opts)  the gate every approval/denial/letter/send
//                                  path calls
//   checkOutboundText(text)        transport check in lib/email/graph_send
// Backstop: migration 540's trigger refuses the same transition in the DB.
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
  if (/disapprov|not[\s_-]*approv|denied|deny/.test(t)) return false;
  return /approv/.test(t);
}

// Does this text GRANT an approval? Negations ("has not been approved",
// "cannot approve") and conditional futures ("once approved") do not count.
const GRANT = [
  /\b(?:is|are|has\s+been|have\s+been|was|were|hereby|been)\s+approved\b/i,
  /\b(?:pleased|happy|glad)\s+to\s+(?:approve|confirm\s+(?:the\s+|your\s+)?approval|inform\s+you\s+that\s+your\s+\w+(?:\s+\w+)?\s+(?:is|has\s+been)\s+approved)\b/i,
  /\b(?:committee|board|association|we)\s+(?:has\s+|have\s+)?(?:approved|approves|grants?\s+approval)\b/i,
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
  /\b(?:is|are|has\s+been|have\s+been|was|were|hereby)\s+(?:denied|declined|disapproved)\b/i,
  /\bnot\s+approved\s+as\s+submitted\b/i,
  /\bregret\s+to\s+inform\s+you\b/i,
  /\b(?:committee|board|association|we)\s+(?:has\s+|have\s+)?(?:denied|declined|disapproved|must\s+deny)\b/i,
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
const DECIDERS = { ed: 'owner', annie: 'agent', amanda: 'agent' };
// Same test as api/_require_admin requireOwner, on a getActingUser profile.
function isOwnerActor(actor) {
  return !!(actor && actor.is_active !== false && actor.role === 'admin'
    && String(actor.email || '').toLowerCase() === OWNER_EMAIL);
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
const FINDINGS = ['complies', 'does_not_comply', 'needs_fact', 'not_applicable'];
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
  return errors;
}

// Mandatory escalation to Ed.
function escalationTriggers(row = {}, gate) {
  const g = gate || classifyDrivewayScope(rowTexts(row));
  const t = [];
  if (g.required || row.approval_gate === 'required') t.push(g.category === 'ambiguous_replacement' ? 'ambiguous_driveway_replacement' : 'driveway_or_paving_expansion');
  const ev = row.compliance_evaluation && typeof row.compliance_evaluation === 'object' ? row.compliance_evaluation : null;
  if (ev) {
    if (ev.deviation_requested === true) t.push('deviation_or_variance');
    if (Array.isArray(ev.conflicts) && ev.conflicts.length) t.push('conflicting_documents');
    if ((Array.isArray(ev.missing_evidence) && ev.missing_evidence.some((m) => !m || m.affects_compliance !== false))
      || (Array.isArray(ev.requirements) && ev.requirements.some((r) => r.finding === 'needs_fact'))) t.push('incomplete_evidence');
    if ((Array.isArray(ev.uncertainties) && ev.uncertainties.length) || (ev.confidence && ev.confidence !== 'high')) t.push('material_uncertainty');
    if (Array.isArray(ev.requirements) && ev.requirements.some((r) => r.modality === 'discretionary' && r.finding !== 'not_applicable')) t.push('discretionary_decision');
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
  if (!DECIDERS[by]) errors.push(`"${rec.decided_by || 'unknown'}" is not authorized to decide ACC applications (only Ed, Amanda or Annie)`);
  if (by === 'ed' && String(rec.decided_by_email || '').toLowerCase() !== OWNER_EMAIL) errors.push('the decision is attributed to Ed but was not recorded from the owner account');
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
  // ROUTINE vs NEEDS MORE AUTHORITY. An approval that is not routine (a paving
  // expansion, a deviation, conflicting provisions, incomplete evidence,
  // uncertainty, a discretionary call) is outside what management may decide
  // alone, under a delegation or otherwise: it needs the committee or Board
  // decision documented. A routine approval under a written delegation must be
  // attested as clearly compliant (the scope of delegations like Waterview
  // §1.4.4.2). Disapprovals stay within a delegation ("all others shall be
  // disapproved").
  if (path === 'committee_or_board') {
    for (const e of validateCommitteeOrBoard(rec.committee_or_board)) errors.push(e);
    if (rec.committee_or_board && !isApprovalDecision(rec.committee_or_board.decision)) errors.push(`the ${rec.committee_or_board.body || 'committee/Board'} decision recorded is "${rec.committee_or_board.decision}", not an approval`);
  }
  if (path === 'routine_delegated' && ab.clearly_compliant !== true) errors.push('a routine approval under the written delegation must confirm the application clearly meets every requirement; anything else needs the committee or Board decision');
  if (DECIDERS[by] === 'agent') {
    const evErr = validateEvaluation(row.compliance_evaluation);
    if (evErr.length) errors.push(`${by === 'annie' ? 'Annie' : 'Amanda'} may decide only after a complete compliance evaluation: ${evErr.slice(0, 3).join('; ')}`);
    if (trig.length) {
      const rv = row.owner_review;
      const reviewed = rv && rv.reviewed_at && (!rec.decided_at || new Date(rv.reviewed_at) <= new Date(rec.decided_at));
      if (!reviewed) errors.push(`escalated to Ed (${trig.join(', ')}): Ed must review before Annie or Amanda decides`);
    }
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
    ? 'the committee or Board decision documented (not routine: ' + triggers.join(', ') + ')'
    : 'a decision by Ed, Amanda or Annie citing the governing provision or the written delegation (routine)';
  return { gate, triggers, escalated, owner_reviewed: ownerReviewed, record, record_valid: !!record && !recordErrors.length, record_errors: record ? recordErrors : [],
    decision_path: record ? decisionPath(record, triggers, gate, row) : null, approval_requires, label, open: OPEN.includes(row.status || 'pending_review') };
}

function blockedMessage(kind, detail) {
  const base = 'Only Ed, Amanda or Annie can approve or deny an ACC application, and only with an authorized decision recorded on the case. Staff can still enter, document, draft and request more information.';
  return `${kind}: ${detail} ${base}`;
}

// THE gate. Every approval / denial / decision-letter / send path calls it.
//   opts.decisionType  the decision being issued
//   opts.texts         the letter/email text (a "request more info" letter that
//                      says "approved" is treated as an approval)
//   opts.actor         getActingUser profile; opts.requireIssuer: issuing the
//                      decision (send / mark done / decision PDF) needs Ed
function checkFinalDecision(row = {}, opts = {}) {
  const texts = (opts.texts || []).filter(Boolean);
  const isApproval = isApprovalDecision(opts.decisionType) || texts.some(grantsApproval);
  const isDenial = !isApproval && (isDenialDecision(opts.decisionType) || texts.some(statesDenial));
  const auth = authorityFor(row, texts);
  if (!isApproval && !isDenial) return { ok: true, final: false, auth };
  if (opts.requireIssuer && !isOwnerActor(opts.actor)) {
    return { ok: false, status: 403, code: 'decision_not_authorized', auth,
      error: blockedMessage('Not authorized', 'issuing an ACC approval or denial (sending it, marking it done, or producing the decision letter) is limited to Ed.') };
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
  return { ok: true, final: true, auth };
}

// Build Ed's decision record from the in-app form (owner only; the caller
// verifies the actor with isOwnerActor first).
function ownerDecisionRecord(actor, input = {}) {
  const cb = input.committee_or_board && Object.keys(input.committee_or_board).length ? {
    body: String(input.committee_or_board.body || '').toLowerCase().trim(),
    decision: String(input.committee_or_board.decision || '').toLowerCase().trim(),
    decided_on: String(input.committee_or_board.decided_on || '').trim(),
    approvers: String(input.committee_or_board.approvers || '').trim(),
    evidence_type: String(input.committee_or_board.evidence_type || '').toLowerCase().trim(),
    evidence_reference: String(input.committee_or_board.evidence_reference || '').trim(),
    deviation_granted: input.committee_or_board.deviation_granted === true || input.committee_or_board.deviation_granted === 'true',
    deviation_statement: String(input.committee_or_board.deviation_statement || '').trim() || null,
  } : null;
  return {
    decided_by: 'ed', decided_by_user_id: actor.id || null, decided_by_email: String(actor.email || '').toLowerCase(), decided_by_name: actor.full_name || 'Ed Gojara',
    outcome: String(input.outcome || '').toLowerCase().trim(),
    decided_at: new Date().toISOString(),
    authority_basis: {
      kind: String(input.authority_kind || '').trim(),
      reference: String(input.authority_reference || '').trim(),
      library_document_id: String(input.authority_library_document_id || '').trim() || null,
      library_document_title: String(input.authority_library_document_title || '').trim() || null,
      clearly_compliant: input.clearly_compliant === true || input.clearly_compliant === 'true',
    },
    committee_or_board: cb,
    conditions: String(input.conditions || '').trim() || null,
    notes: String(input.notes || '').trim() || null,
  };
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
  isOwnerActor, OWNER_EMAIL, DECIDERS, AUTHORITY_KINDS, EVIDENCE_TYPES, OUTCOMES,
  validateCommitteeOrBoard, validateEvaluation, validateDecisionRecord, escalationTriggers, decisionPath,
  authorityFor, checkFinalDecision, ownerDecisionRecord, checkOutboundText, stampFor, rowTexts, OPEN,
};
