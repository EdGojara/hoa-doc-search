// ============================================================================
// tests/test_acc_decision_authority.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// Only Ed, Amanda or Annie may approve or deny an ACC application, and only with
// an authorized decision recorded on the case (lib/acc/decision_authority).
// Driveway / paving expansions and deviations escalate to Ed and need the
// committee or Board decision documented. Staff keep intake, drafting and
// requests for more information.
//
// Fixtures are sanitized from real Waterview cases (no names or emails):
//   Brian Decker's pending application (WAT-ARC-2026-0033), and the two
//   historical approvals issued by staff with no committee record
//   (19814 Moss Bark, 19919 Pemetic). The historical rows are read as fixtures
//   only: these tests never write, and assert the fixtures are not mutated.
//
// Run: node tests/test_acc_decision_authority.js
// ============================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const DA = require('../lib/acc/decision_authority');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}

const ED = { id: 'ed-id', email: 'egojara@bedrocktx.com', role: 'admin', is_active: true, full_name: 'Ed Gojara' };
const STAFF = { id: 'staff-id', email: 'staffer@bedrocktx.com', role: 'staff', is_active: true, full_name: 'A Staffer' };
const STAFF_ADMIN_LOOKALIKE = { id: 'x', email: 'someone@bedrocktx.com', role: 'admin', is_active: true };

// ---- fixtures (sanitized) ---------------------------------------------------
const BRIAN = Object.freeze({
  id: 'brian', status: 'pending_review', community_name: 'Waterview Estates',
  project_summary: 'Replace existing driveway and extend width on one side by 2\'6" x 20.5\' with 3000 PSI concrete per Fort Bend County Standards',
  ai_recommendation: 'request_more_info', decision_type: null,
  ai_letter_body: 'We\'re almost ready to move forward. Could you send a survey showing the distance from the extension to the side property line, and confirm drainage will flow to the street? Once we have that, we\'ll get the approval out promptly.',
});
const MOSS_BARK = Object.freeze({
  id: 'moss', status: 'decided', community_name: 'Waterview Estates', decision_type: 'approved_with_conditions',
  project_summary: 'Driveway widening (16.5 ft to 19.5 ft) and front approach walkway modification',
  letter_body: 'The Architectural Review Committee of Waterview Estates has reviewed your application for replacement of the existing 16½-foot driveway with a new 19½-foot driveway and modification of the approach walkway to the front entry. We are pleased to confirm that your application is approved, subject to the following conditions.',
  decided_by_user_id: 'staff-id', decision_record: null,
});
const PEMETIC = Object.freeze({
  id: 'pemetic', status: 'decided', community_name: 'Waterview Estates', decision_type: 'approved_with_conditions',
  project_summary: 'Extend concrete on left side of driveway approximately 13 ft long by 5.25 ft wide',
  letter_body: 'The Architectural Control Committee has reviewed your request and is pleased to approve this project, subject to the conditions listed below. Your proposed 13-foot by 5.25-foot concrete extension is consistent with the Design Standards for driveways.',
  decided_by_user_id: 'staff-id', decision_record: null,
});
const snapshot = JSON.stringify([BRIAN, MOSS_BARK, PEMETIC]);

const COMMITTEE_APPROVAL = { body: 'board', decision: 'approved_with_conditions', decided_on: '2026-10-19', approvers: 'Director A, Director B, Director C', evidence_type: 'email', evidence_reference: 'Board email thread 2026-10-19, saved to the case' };
const edRecord = (extra = {}) => DA.ownerDecisionRecord(ED, { outcome: 'approved_with_conditions', authority_kind: 'governing_document', authority_reference: 'Declaration Article II, ACC approval authority, p. 12', ...extra });
const COMPLETE_EVAL = {
  applicant_verified: true, community_verified: true, property_verified: true,
  completeness: { complete: true, items: [] }, documents_reviewed: ['application.pdf', 'survey.pdf'],
  governing_documents: [{ title: 'Declaration', current: true }],
  requirements: [{ requirement: 'Fence height', modality: 'maximum', citation: { document: 'Declaration', section: '2.10', page: '14' }, finding: 'complies' }],
  missing_evidence: [], conflicts: [], nonconformities: [],
  authority: { kind: 'governing_document', reference: 'Declaration Article II §2.01, p. 9' },
  recommendation: 'approved', confidence: 'high',
};

console.log('\n1. Escalation scope: what the project is, not its label');
for (const [n, r] of [['Brian (replace + 2\'6" extension)', BRIAN], ['Moss Bark (16.5 to 19.5 ft)', MOSS_BARK], ['Pemetic (13 x 5.25 ft beside driveway)', PEMETIC]]) {
  const c = DA.classifyDrivewayScope(DA.rowTexts(r));
  check(`${n} is escalated as a paving expansion`, c.required && c.category === 'expansion', JSON.stringify(c));
}
check('Moss Bark form wording (no expansion word, widths increase) is an expansion',
  DA.classifyDrivewayScope('Replace existing driveway (16 ½ ft) with new (19½ ft) driveway.').category === 'expansion');
check('Pemetic form wording is an expansion', DA.classifyDrivewayScope('Extend the concrete on the left side of driveway.').required);
check('a parking pad is an expansion', DA.classifyDrivewayScope('Add a concrete parking pad next to the driveway').required);
check('a walkway widening is an expansion', DA.classifyDrivewayScope('Widen the front walkway to 6 feet').required);
check('new pavers in the front yard are an expansion', DA.classifyDrivewayScope('Install pavers in the front yard').required);
check('same-footprint replacement is NOT escalated', DA.classifyDrivewayScope('Replace the existing driveway in the same footprint; no change to size.').category === 'same_footprint_replacement');
check('a replacement with no footprint statement is escalated (ambiguous)', DA.classifyDrivewayScope('Driveway replacement - remove and replace cracked concrete').category === 'ambiguous_replacement');
// The prescribed-width trap (Ed 2026-10-20): "shall be 18 feet" is not "at least
// 18 feet". The screener cannot know a community's width, so a driveway being
// built or sized is escalated; the evaluation engine compares the number.
for (const t of ['Pour a new 30-foot wide driveway', 'Install a 30 ft wide concrete driveway', 'Driveway, 30\' width, broom finish', 'New driveway 25 feet wide']) {
  check(`hypothetical: "${t}" is escalated, never routine`, DA.classifyDrivewayScope(t).required, JSON.stringify(DA.classifyDrivewayScope(t)));
}
{
  const thirty = { id: 't30', status: 'pending_review', project_summary: 'Pour a new 30-foot wide driveway' };
  const del30 = DA.ownerDecisionRecord(ED, { outcome: 'approved', authority_kind: 'written_delegation', authority_reference: 'Guidelines §1.4.4.1-1.4.4.2, p. 2', authority_library_document_id: '00000000-0000-0000-0000-0000000000d1', clearly_compliant: true });
  check('hypothetical 30 ft driveway: a "routine" delegated approval is refused (committee/Board required)', DA.validateDecisionRecord(del30, thirty).some((e) => /committee or Board/.test(e)));
  check('hypothetical 30 ft driveway: staff cannot approve it', DA.checkFinalDecision(thirty, { decisionType: 'approved', actor: STAFF, requireIssuer: true }).code === 'decision_not_authorized');
}
check('a same-footprint replacement that states its width stays routine', !DA.classifyDrivewayScope('Replace the existing 18 ft driveway in the same footprint, no change to size.').required);
check('driveway crack repair is not escalated', !DA.classifyDrivewayScope('Driveway crack repair and sealing').required);
check('a roof replacement that mentions parking in the driveway is not escalated', !DA.classifyDrivewayScope('Roof replacement with architectural shingles. The contractor will park in the driveway.').required);
check('a back patio extension is not escalated as front paving', !DA.classifyDrivewayScope('Extend back patio slab 10 ft').required);

console.log('\n2. Brian Decker (WAT-ARC-2026-0033): staff and the engine cannot approve');
{
  const staffApprove = DA.checkFinalDecision(BRIAN, { decisionType: 'approved_with_conditions', actor: STAFF, requireIssuer: true });
  check('staff approval is refused (403, decision_not_authorized)', !staffApprove.ok && staffApprove.status === 403 && staffApprove.code === 'decision_not_authorized');
  const staffDeny = DA.checkFinalDecision(BRIAN, { decisionType: 'denied', actor: STAFF, requireIssuer: true });
  check('staff denial is refused too', !staffDeny.ok && staffDeny.code === 'decision_not_authorized');
  const edNoRecord = DA.checkFinalDecision(BRIAN, { decisionType: 'approved_with_conditions', actor: ED, requireIssuer: true });
  check('Ed with no decision record: Owner Review Required (409)', !edNoRecord.ok && edNoRecord.code === 'owner_review_required' && /Owner Review Required/.test(edNoRecord.error));
  const edNoCommittee = DA.checkFinalDecision({ ...BRIAN, decision_record: edRecord() }, { decisionType: 'approved_with_conditions', actor: ED, requireIssuer: true });
  check('Ed\'s own approval of a paving expansion still needs the committee/Board decision', !edNoCommittee.ok && /committee or Board authorization is not documented/.test(edNoCommittee.error));
  const devNoText = DA.checkFinalDecision({ ...BRIAN, decision_record: edRecord({ committee_or_board: { ...COMMITTEE_APPROVAL, deviation_granted: true } }) }, { decisionType: 'approved_with_conditions', actor: ED, requireIssuer: true });
  check('a granted deviation needs the written deviation authorization', !devNoText.ok && /written deviation authorization/.test(devNoText.error));
  const ok = DA.checkFinalDecision({ ...BRIAN, decision_record: edRecord({ committee_or_board: { ...COMMITTEE_APPROVAL, deviation_granted: true, deviation_statement: 'Board grants a width deviation under the committee\'s size and location deviation authority.' } }) }, { decisionType: 'approved_with_conditions', actor: ED, requireIssuer: true });
  check('Ed + documented Board approval + written deviation: allowed', ok.ok);
  const rmi = DA.checkFinalDecision(BRIAN, { decisionType: 'request_more_info', texts: [BRIAN.ai_letter_body], actor: STAFF, requireIssuer: true });
  check('staff can still send Brian\'s request for more information', rmi.ok && rmi.final === false);
  check('"we\'ll get the approval out promptly" is not itself an approval', !DA.grantsApproval(BRIAN.ai_letter_body));
  const disguised = DA.checkFinalDecision(BRIAN, { decisionType: 'request_more_info', texts: ['Good news: your driveway extension has been approved.'], actor: STAFF, requireIssuer: true });
  check('a "request more info" letter that says "approved" is treated as an approval and refused', !disguised.ok);
}

console.log('\n3. Historical Waterview approvals (read-only fixtures)');
for (const [n, r] of [['19814 Moss Bark', MOSS_BARK], ['19919 Pemetic', PEMETIC]]) {
  const a = DA.authorityFor(r);
  check(`${n}: no authorized decision record exists`, !a.record && !a.record_valid);
  check(`${n}: escalated (driveway_or_paving_expansion)`, a.escalated && a.triggers.includes('driveway_or_paving_expansion'));
  check(`${n}: the case is not open, so nothing re-decides it`, a.open === false);
  const reissue = DA.checkFinalDecision(r, { decisionType: r.decision_type, texts: [r.letter_body], actor: STAFF, requireIssuer: true });
  check(`${n}: a staff re-issue of the same approval is refused`, !reissue.ok);
  const reissueEd = DA.checkFinalDecision(r, { decisionType: r.decision_type, texts: [r.letter_body], actor: ED, requireIssuer: true });
  check(`${n}: even Ed cannot re-issue it without a committee/Board record`, !reissueEd.ok);
}
check('historical fixtures were not mutated by any check', JSON.stringify([BRIAN, MOSS_BARK, PEMETIC]) === snapshot);
{
  const cols = fs.readFileSync(path.join(__dirname, '..', 'migrations', '540_acc_decision_authority_columns.sql'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '541_acc_decision_authority_guard.sql'), 'utf8');
  check('540 is additive only: no default, trigger or row change (safe before the code)', !/SET DEFAULT|CREATE TRIGGER|UPDATE\s+acc_decisions\s+SET|DROP COLUMN/i.test(cols) && /ADD COLUMN IF NOT EXISTS decision_record/.test(cols));
  check('541 trigger fires only on the transition INTO finalizing/decided (historical rows untouched)', /OLD\.status NOT IN \('finalizing', 'decided'\)/.test(sql) && /TG_OP = 'INSERT'/.test(sql));
  check('541 changes no existing row (no UPDATE ... SET on acc_decisions)', !/UPDATE\s+acc_decisions\s+SET/i.test(sql));
  check('541: new rows are never decided by default', /ALTER COLUMN status SET DEFAULT 'pending_review'/.test(sql));
  check('541 requires 540 in its checks file', /540_acc_decision_authority_columns\.sql/.test(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'checks', '541_acc_decision_authority_guard.json'), 'utf8')));
}

console.log('\n3b. Written delegation is decision authority (routine vs not)');
{
  const LIB = '00000000-0000-0000-0000-0000000000d1';
  const fence = { id: 'f2', status: 'pending_review', project_summary: 'Replace rear wood fence, 6 ft cedar, same location' };
  const del = (extra = {}) => DA.ownerDecisionRecord(ED, { outcome: 'approved', authority_kind: 'written_delegation', authority_reference: 'Guidelines §1.4.4.1-1.4.4.2, p. 2: Committee delegation to the Managing Agent', authority_library_document_id: LIB, clearly_compliant: true, ...extra });
  check('a routine, clearly compliant approval under the written delegation needs NO committee vote', DA.validateDecisionRecord(del(), fence).length === 0, DA.validateDecisionRecord(del(), fence).join('; '));
  const issue = DA.checkFinalDecision({ ...fence, decision_record: del() }, { decisionType: 'approved', actor: ED, requireIssuer: true });
  check('Ed can ISSUE a properly authorized routine decision (send / mark done) without any bypass', issue.ok && issue.final === true, issue.error);
  check('...but staff cannot issue that same authorized decision', DA.checkFinalDecision({ ...fence, decision_record: del() }, { decisionType: 'approved', actor: STAFF, requireIssuer: true }).code === 'decision_not_authorized');
  check('...its decision path is routine_delegated', DA.decisionPath(del(), [], DA.classifyDrivewayScope(fence.project_summary), fence) === 'routine_delegated');
  check('a delegated approval must name the instrument on file', DA.validateDecisionRecord(del({ authority_library_document_id: '' }), fence).some((e) => /instrument/.test(e)));
  check('a delegated approval must be attested clearly compliant', DA.validateDecisionRecord(del({ clearly_compliant: false }), fence).some((e) => /clearly meets every requirement/.test(e)));
  check('a disapproval under the delegation is allowed ("all others shall be disapproved")', DA.validateDecisionRecord(del({ outcome: 'denied', clearly_compliant: false }), fence).length === 0);
  check('a delegated "routine" approval of a paving expansion still needs the committee/Board decision', DA.validateDecisionRecord(del({ outcome: 'approved_with_conditions' }), BRIAN).some((e) => /committee or Board authorization is not documented/.test(e)));
  const uncertain = { ...fence, compliance_evaluation: { ...COMPLETE_EVAL, confidence: 'medium' } };
  check('an approval with material uncertainty is not routine: committee/Board needed', DA.validateDecisionRecord(del(), uncertain).some((e) => /committee or Board/.test(e)));
  const annieDel = { ...del(), decided_by: 'annie', decided_by_email: null };
  check('AI decisions are OFF by default: Annie cannot decide even a routine case', DA.validateDecisionRecord(annieDel, { ...fence, compliance_evaluation: COMPLETE_EVAL }).some((e) => /AI decisions are off/.test(e)));
  process.env.ACC_AI_DECISIONS_ENABLED = 'true';
  check('once enabled, Annie may make a routine delegated approval with a complete evaluation', DA.validateDecisionRecord(annieDel, { ...fence, compliance_evaluation: COMPLETE_EVAL }).length === 0,
    DA.validateDecisionRecord(annieDel, { ...fence, compliance_evaluation: COMPLETE_EVAL }).join('; '));
  check('...but never without one', DA.validateDecisionRecord(annieDel, fence).some((e) => /complete compliance evaluation/.test(e)));
  delete process.env.ACC_AI_DECISIONS_ENABLED;
  check('the screen says what an approval needs before anything is recorded',
    /routine/.test(DA.authorityFor(fence).approval_requires) && /committee or Board/.test(DA.authorityFor(BRIAN).approval_requires));
}

console.log('\n4. Every improvement type: only Ed, Amanda or Annie decide');
{
  const fence = { id: 'f', status: 'pending_review', project_summary: 'Replace rear wood fence, 6 ft cedar, same location' };
  check('staff approval of a fence is refused', DA.checkFinalDecision(fence, { decisionType: 'approved', actor: STAFF, requireIssuer: true }).code === 'decision_not_authorized');
  check('an admin who is not the owner cannot issue', DA.checkFinalDecision(fence, { decisionType: 'approved', actor: STAFF_ADMIN_LOOKALIKE, requireIssuer: true }).code === 'decision_not_authorized');
  check('Ed without a decision record is refused (decision_record_required)', DA.checkFinalDecision(fence, { decisionType: 'approved', actor: ED, requireIssuer: true }).code === 'decision_record_required');
  const bedrockOnly = DA.checkFinalDecision({ ...fence, decision_record: edRecord({ outcome: 'approved', authority_kind: 'written_delegation', authority_reference: 'communities.arc_approval_workflow = bedrock_only' }) }, { decisionType: 'approved', actor: ED, requireIssuer: true });
  check('a system setting (bedrock_only) is never authority', !bedrockOnly.ok && /system setting is not authority/.test(bedrockOnly.error));
  const edFence = DA.checkFinalDecision({ ...fence, decision_record: edRecord({ outcome: 'approved' }) }, { decisionType: 'approved', actor: ED, requireIssuer: true });
  check('no inferred authority: a governing-document citation alone does not let Bedrock approve', !edFence.ok && /governing-document citation alone/.test(edFence.error));
  const edFenceCb = DA.checkFinalDecision({ ...fence, decision_record: edRecord({ outcome: 'approved', committee_or_board: { ...COMMITTEE_APPROVAL, decision: 'approved' } }) }, { decisionType: 'approved', actor: ED, requireIssuer: true });
  check('...with the committee/Board decision documented, Ed may issue it', edFenceCb.ok, edFenceCb.error);
  const delFence = (o) => DA.ownerDecisionRecord(ED, { outcome: 'approved', authority_kind: 'written_delegation', authority_reference: 'Guidelines §1.4.4.1, p. 2', authority_library_document_id: '00000000-0000-0000-0000-0000000000d1', clearly_compliant: true, ...o });
  const mismatch = DA.checkFinalDecision({ ...fence, decision_record: delFence() }, { decisionType: 'denied', actor: ED, requireIssuer: true });
  check('a denial cannot be issued on an approval record', !mismatch.ok && mismatch.code === 'decision_outcome_mismatch', mismatch.code);
  const forged = { ...edRecord({ outcome: 'approved' }), decided_by_email: 'staffer@bedrocktx.com' };
  check('a record attributed to Ed but not from the owner account is invalid', DA.validateDecisionRecord(forged, fence).some((e) => /owner account/.test(e)));
  const staffRec = { ...edRecord({ outcome: 'approved' }), decided_by: 'martha' };
  check('a record by anyone other than ed/annie/amanda is invalid', DA.validateDecisionRecord(staffRec, fence).some((e) => /not authorized/.test(e)));
  const annieNoEval = { decided_by: 'annie', outcome: 'approved', decided_at: new Date().toISOString(), authority_basis: { kind: 'governing_document', reference: 'Declaration Article II §2.01, p. 9' } };
  check('Annie without a complete compliance evaluation cannot decide', DA.validateDecisionRecord(annieNoEval, fence).some((e) => /complete compliance evaluation/.test(e)));
  process.env.ACC_AI_DECISIONS_ENABLED = 'true';
  check('Annie citing only a governing provision cannot decide (written delegation required)', DA.validateDecisionRecord(annieNoEval, { ...fence, compliance_evaluation: COMPLETE_EVAL }).some((e) => /written delegation/.test(e)));
  const annieDelRec = { ...delFence(), decided_by: 'annie', decided_by_email: null };
  check('Annie with a complete evaluation, routine and delegated, may approve', DA.validateDecisionRecord(annieDelRec, { ...fence, compliance_evaluation: COMPLETE_EVAL }).length === 0);
  const evNoPage = { ...COMPLETE_EVAL, requirements: [{ ...COMPLETE_EVAL.requirements[0], citation: { document: 'Declaration', section: '2.10' } }] };
  check('an evaluation citation without a page is incomplete', DA.validateEvaluation(evNoPage).some((e) => /page/.test(e)));
  const driveRow = { ...BRIAN, compliance_evaluation: COMPLETE_EVAL };
  check('Annie never decides an escalated case (paving expansion is Ed\'s)', DA.validateDecisionRecord(annieDelRec, driveRow).some((e) => /owner review required/.test(e)));
  const reviewed = { ...driveRow, owner_review: { reviewed_at: new Date(Date.now() - 60000).toISOString() } };
  check('...not even with Ed\'s review and a committee/Board record (Ed records it)', DA.validateDecisionRecord({ ...annieDelRec, committee_or_board: COMMITTEE_APPROVAL }, reviewed).length > 0);
  check('Annie never denies', DA.validateDecisionRecord({ ...annieDelRec, outcome: 'denied' }, { ...fence, compliance_evaluation: COMPLETE_EVAL }).some((e) => /never denies/.test(e)));
  delete process.env.ACC_AI_DECISIONS_ENABLED;
  const conflictRow = { ...fence, compliance_evaluation: { ...COMPLETE_EVAL, conflicts: [{ what: 'two width sentences' }] } };
  check('conflicting documents escalate to Ed', DA.escalationTriggers(conflictRow).includes('conflicting_documents'));
  const uncertain = { ...fence, compliance_evaluation: { ...COMPLETE_EVAL, confidence: 'medium' } };
  check('material uncertainty escalates to Ed', DA.escalationTriggers(uncertain).includes('material_uncertainty'));
  check('incomplete notices and requests for more information stay open to staff',
    DA.checkFinalDecision(fence, { decisionType: 'incomplete', actor: STAFF, requireIssuer: true }).ok
    && DA.checkFinalDecision(fence, { decisionType: 'request_more_info', actor: STAFF, requireIssuer: true }).ok);
}

console.log('\n4b. Autonomy policy (Ed 2026-10-20): AI approves only the clearly compliant and objective');
{
  const cite = (document, section, page, quote) => ({ document, section, page, quote });
  const base = { ...COMPLETE_EVAL, missing_evidence: [], conflicts: [], nonconformities: [], uncertainties: [] };
  // Karen Deaver (LOPF): black front door. Black is not prohibited; whether it
  // suits her home is a judgment the documents leave to the committee.
  const karen = { id: 'karen', status: 'pending_review', community_name: 'Lakes of Pine Forest', project_summary: 'Paint front door black',
    compliance_evaluation: { ...base, requirements: [
      { requirement: 'Color change needs written ARC approval', category: 'procedural', modality: 'required', finding: 'complies', citation: cite('Master Declaration', 'Art. VI §3', '15-16', 'painting or staining of any exterior surface a different color than the one previously approved') },
      { requirement: 'Bold primary colors prohibited', category: 'color', modality: 'prohibited', finding: 'complies', proposed: 'black (not a primary color)', citation: cite('Builder Guidelines', '§2.3', '16', 'Bold primary colors are prohibited.') },
      { requirement: 'Soft subdued colors; avoid high-contrast trim', category: 'aesthetic', modality: 'discretionary', finding: 'judgment_required', citation: cite('Builder Guidelines', '§2.3', '16', 'High contrast trim or material variation should be avoided') },
    ], recommendation: 'approved' } };
  const rk = DA.routeEvaluation(karen);
  check('Karen\'s black door -> Owner Review Required (discretionary aesthetic review)', rk.route === 'owner_review_required' && rk.triggers.includes('aesthetic_judgment'), JSON.stringify(rk));
  check('...the screen explains the judgment needed (harmony / appearance on this home)', DA.authorityFor(karen).judgments.some((j) => /harmony or appearance/.test(j)));
  process.env.ACC_AI_DECISIONS_ENABLED = 'true';
  const annieKaren = { ...DA.ownerDecisionRecord(ED, { outcome: 'approved', authority_kind: 'written_delegation', authority_reference: 'hypothetical delegation for the test', authority_library_document_id: '00000000-0000-0000-0000-0000000000d1', clearly_compliant: true }), decided_by: 'annie', decided_by_email: null };
  check('...and Annie cannot approve it, even with AI decisions on', DA.validateDecisionRecord(annieKaren, karen).some((e) => /owner review required/.test(e)));
  // Brian Decker: driveway extension.
  const rb = DA.routeEvaluation({ ...BRIAN, compliance_evaluation: base });
  check('Brian\'s driveway extension -> Owner Review Required', rb.route === 'owner_review_required' && rb.triggers.includes('driveway_or_paving_expansion'), JSON.stringify(rb));
  // Same-color repaint: the documents require no approval.
  const repaint = { id: 'rp', status: 'pending_review', project_summary: 'Repaint front door the same color as previously approved',
    compliance_evaluation: { ...base, requirements: [], no_approval_required: { applies: true, citation: cite('Master Declaration', 'Art. VI §3', '16', 'repaint or restore the exterior … with the same color which has been previously approved') } } };
  check('fully compliant same-color repaint -> no approval required (routine processing)', DA.routeEvaluation(repaint).route === 'no_approval_required');
  const info = DA.checkFinalDecision(repaint, { decisionType: 'no_approval_required', texts: ['No application is needed to repaint your door the same color previously approved.'], actor: STAFF, requireIssuer: true });
  check('...staff can send that informational answer (it is not a decision)', info.ok && info.final === false);
  // Fully compliant objective application.
  const objective = { id: 'obj', status: 'pending_review', project_summary: 'Replace rear wood fence, 6 ft cedar, same location', compliance_evaluation: base };
  check('fully compliant objective application -> eligible for AI approval', DA.routeEvaluation(objective).route === 'eligible_for_ai_approval');
  check('...and Annie may approve it once enabled, under the delegation', DA.validateDecisionRecord(annieKaren, objective).length === 0, DA.validateDecisionRecord(annieKaren, objective).join('; '));
  // Unambiguous noncompliance.
  const noncompliant = { id: 'nc', status: 'pending_review', project_summary: 'Install 8 ft rear fence',
    compliance_evaluation: { ...base, requirements: [{ requirement: 'Rear fence height', category: 'dimensional', modality: 'maximum', mandatory: true, finding: 'does_not_comply', proposed: '8 ft', citation: cite('Declaration', '§2.25', '17', 'No side or rear fence … shall be more than six feet (6\') in height') }], recommendation: 'denied' } };
  check('unambiguous noncompliance -> owner review (no automatic denial)', DA.routeEvaluation(noncompliant).route === 'owner_review_noncompliance');
  check('...Annie cannot approve it', DA.validateDecisionRecord(annieKaren, noncompliant).length > 0);
  check('...Annie cannot deny it', DA.validateDecisionRecord({ ...annieKaren, outcome: 'denied' }, noncompliant).some((e) => /never denies/.test(e)));
  check('...staff cannot deny it', DA.checkFinalDecision(noncompliant, { decisionType: 'denied', actor: STAFF, requireIssuer: true }).code === 'decision_not_authorized');
  delete process.env.ACC_AI_DECISIONS_ENABLED;
  // Incomplete -> request information, not approval.
  const incomplete = { id: 'inc', status: 'pending_review', project_summary: 'Replace rear wood fence', compliance_evaluation: { ...base, completeness: { complete: false, items: ['survey'] } } };
  check('incomplete application -> request more information', DA.routeEvaluation(incomplete).route === 'request_more_info');
  check('no evaluation at all -> evaluation required (nobody AI-decides)', DA.routeEvaluation({ id: 'x', status: 'pending_review', project_summary: 'Patio cover' }).route === 'evaluation_required');
}

console.log('\n5. Decision language in letters and emails');
check('"has been approved" grants', DA.grantsApproval('Your application has been approved.'));
check('"has not been approved" does not', !DA.grantsApproval('Your application has not been approved yet.'));
check('"Once approved, you may proceed" does not', !DA.grantsApproval('Once approved, you may proceed.'));
check('"Attached is your approval letter" grants', DA.grantsApproval('Attached is your approval letter.'));
check('"is denied" is a denial', DA.statesDenial('Your request is denied.'));
check('"not approved as submitted" is a denial', DA.statesDenial('The proposed extension is not approved as submitted.'));
check('a request for a survey is neither', !DA.grantsApproval('Please send a survey.') && !DA.statesDenial('Please send a survey.'));

console.log('\n6. Transport guard (lib/email/graph_send)');
{
  check('an external email approving an architectural application is caught', !DA.checkOutboundText('Hi, your architectural application has been approved.').ok);
  check('an email approving a driveway extension is caught even without "architectural"', !DA.checkOutboundText('Good news, your driveway extension has been approved!').ok);
  check('a pool-fob email that says "approved" is not ACC and passes', DA.checkOutboundText('Your pool key fob request has been approved.').ok);
  check('an acknowledgment passes', DA.checkOutboundText('We have received your architectural application and will review it.').ok);
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
  const G = require('../lib/email/graph_send');
  (async () => {
    let threw = null;
    try { await G.accDecisionGuard({ to: 'homeowner@example.com', subject: 'Your architectural application', html: 'Your architectural application has been approved.' }); } catch (e) { threw = e; }
    check('graph_send refuses it before sending (preSend, no retry confirmation)', threw && threw.code === 'acc_decision_not_authorized' && threw.preSend === true && /Only Ed, Amanda or Annie/.test(threw.userMessage));
    let internal = null;
    try { await G.accDecisionGuard({ to: 'egojara@bedrocktx.com', subject: 'ARC', html: 'ARC application approved' }); } catch (e) { internal = e; }
    check('mail only to our own staff is not a homeowner decision and passes', internal === null);

    console.log('\n7. No alternate path: every decision / letter / send route calls the gate');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const handler = (re) => { const m = server.match(re); if (!m) return ''; const start = m.index; const next = server.indexOf('\napp.', start + 10); return server.slice(start, next < 0 ? undefined : next); };
    const routes = [
      ['POST /acc-review/letter (Generate letter)', /app\.post\('\/acc-review\/letter'/],
      ['POST /acc-review/render-letter (Download letter PDF)', /app\.post\('\/acc-review\/render-letter'/],
      ['POST /acc-review/decisions/:id/finalize (Send / Mark done)', /app\.post\('\/acc-review\/decisions\/:id\/finalize'/],
      ['POST /acc-review/decisions/:id/reply (Annie reply box)', /app\.post\('\/acc-review\/decisions\/:id\/reply'/],
      ['GET /acc-review/decisions/:id/letter', /app\.get\('\/acc-review\/decisions\/:id\/letter'/],
      ['GET /acc-review/decisions/:id/packet', /app\.get\('\/acc-review\/decisions\/:id\/packet'/],
    ];
    for (const [n, re] of routes) {
      const h = handler(re);
      check(`${n} calls lib/acc/decision_authority`, h && /decision_authority/.test(h) && /checkFinalDecision/.test(h));
    }
    const gen = handler(/app\.post\('\/acc-review\/letter'/);
    check('Generate letter inserts a DRAFT (status pending_review), never a decision', /insert\(\{ \.\.\.fields, status: 'pending_review' \}\)/.test(gen));
    check('Generate letter no longer stamps a "decided by"', !/decided_by_user_id:\s*actor/.test(gen));
    check('Generate letter never rewrites a decided case', /case_closed/.test(gen) && /\.in\('status', \['pending_review', 'awaiting_info'\]\)/.test(gen));
    check('Generate letter no longer seals a draft letter as a sent record', !/record_type: 'acc_letter'/.test(gen));
    check('finalize passes the case to the transport guard', /accDecisionId: id/.test(handler(/app\.post\('\/acc-review\/decisions\/:id\/finalize'/)));
    for (const ep of ['owner-review', 'decision-record']) {
      check(`${ep} is owner-only (isOwnerActor) and never sends`, /_accAuthorityWrite/.test(server) && new RegExp(`app\\.post\\('\\/acc-review\\/decisions\\/:id\\/${ep}'`).test(server) && /isOwnerActor\(actor\)/.test(server.slice(server.indexOf('async function _accAuthorityWrite'), server.indexOf('async function _accAuthorityWrite') + 800)));
    }
    check('a cited instrument is verified as on file for the case\'s community (record endpoint and Send)',
      (server.match(/_accResolveAuthorityDocument\(dec, rec\)/g) || []).length >= 2 && /doc\.community_id !== dec\.community_id/.test(server));
    const gs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_send.js'), 'utf8');
    check('graph_send sendAs runs the decision guard', /async function sendAs[\s\S]{0,700}accDecisionGuard\(/.test(gs));
    check('graph_send sendReplyAs runs the decision guard', /async function sendReplyAs[\s\S]{0,1400}accDecisionGuard\(/.test(gs));
    const apps = fs.readFileSync(path.join(__dirname, '..', 'api', 'applications.js'), 'utf8');
    check('portal: ARC finalize still refuses (decided only in the ACC queue)', /svc\.service_type === 'arc'[\s\S]{0,200}status\(409\)/.test(apps));
    check('portal: ARC send-decision still refuses', /app\.service_type === 'arc'[\s\S]{0,200}status\(409\)/.test(apps));
    // AI decisions are impossible until the engine lands: no production code
    // records an Annie/Amanda decision or writes a compliance evaluation, and
    // the only decision-record builder hardcodes Ed.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'tests' || e.name.startsWith('.')) ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : (/\.js$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const prod = [path.join(__dirname, '..', 'server.js'), ...walk(path.join(__dirname, '..', 'lib')), ...walk(path.join(__dirname, '..', 'api'))];
    const agentWriters = prod.filter((f) => /decided_by:\s*['"](?:annie|amanda)['"]/.test(fs.readFileSync(f, 'utf8')));
    const evalWriters = prod.filter((f) => /[{,]\s*compliance_evaluation\s*:/.test(fs.readFileSync(f, 'utf8')));
    check('no production code records an Annie/Amanda decision', agentWriters.length === 0, agentWriters.join(', '));
    check('no production code writes a compliance evaluation yet (engine not landed)', evalWriters.length === 0, evalWriters.join(', '));
    check('AI decisions default OFF (ACC_AI_DECISIONS_ENABLED unset)', !DA.aiDecisionsEnabled());
    // Background writers never set a final status.
    for (const f of ['lib/acc/pending_intake.js', 'lib/applications/email_intake.js', 'lib/acc/match_open_application.js', 'lib/acc/documents.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      check(`${f} never writes status 'decided'`, !/status:\s*'decided'/.test(src));
    }

    console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
    process.exit(failures ? 1 : 0);
  })();
}
