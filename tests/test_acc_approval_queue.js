// ============================================================================
// tests/test_acc_approval_queue.js  (Ed 2026-10-29)
// ----------------------------------------------------------------------------
// The ACC Requests screen separates work into: Pending Ed's approval,
// Submitted applications, Saved drafts, Decided (letter not sent), Completed
// decisions. The section comes from lib/acc/decision_authority queueStage,
// which reads the SAME authority state the decision gate enforces, so a case
// can only leave "Pending Ed's approval" by having an authorized decision
// recorded, never by Annie recommending it, a staff member saying so, or a
// record forged in Ed's name.
//
// Also walks the path Annie would have to take to issue a decision on her own
// and asserts every step refuses: recording, issuing the letter, and the email
// transport guard every Graph send passes through.
//
// Fixtures are sanitized from the open production queue on 2026-10-29 (no
// names, emails or addresses). Pure and offline: no database, no network.
//
// Run: node tests/test_acc_approval_queue.js
// ============================================================================
const fs = require('fs');
const path = require('path');
delete process.env.ACC_AI_DECISIONS_ENABLED;
const DA = require('../lib/acc/decision_authority');
const { accDecisionGuard } = require('../lib/email/graph_send');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
}

const ED = { id: 'ed-id', email: 'egojara@bedrocktx.com', role: 'admin', is_active: true, full_name: 'Ed Gojara' };
const STAFF = { id: 'staff-id', email: 'staffer@bedrocktx.com', role: 'staff', is_active: true, full_name: 'A Staffer' };
const ADMIN_NOT_ED = { id: 'adm', email: 'someone@bedrocktx.com', role: 'admin', is_active: true, full_name: 'Another Admin' };
const stage = (row) => DA.queueStage(row).stage;

// ---- fixtures: shapes of real open cases ------------------------------------
const ROOF = Object.freeze({ id: 'roof', status: 'pending_review', community_name: 'Lakes of Pine Forest',
  project_summary: 'Complete re-roof, Class 3 shingles, same color family', ai_recommendation: 'approved_with_conditions', decision_record: null });
const REPAINT_INFO = Object.freeze({ id: 'repaint', status: 'pending_review', community_name: 'Waterview Estates',
  project_summary: 'Exterior repaint, body and garage door', ai_recommendation: 'request_more_info', decision_record: null });
const DRIVEWAY = Object.freeze({ id: 'drive', status: 'pending_review', community_name: 'Waterview Estates',
  project_summary: 'Replace existing driveway and extend width on one side', ai_recommendation: 'request_more_info', decision_record: null });
const UNREVIEWED = Object.freeze({ id: 'new', status: 'pending_review', community_name: 'Waterview Estates',
  project_summary: 'Roof replacement/repair, homeowner ACC request', ai_recommendation: null, decision_record: null });
const AWAITING = Object.freeze({ id: 'await', status: 'awaiting_info', community_name: 'Still Creek Ranch',
  project_summary: 'Ground-mounted battery backup', ai_recommendation: 'approved_with_conditions', decision_record: null });
const DENY_REC = Object.freeze({ id: 'deny', status: 'pending_review', community_name: 'Lakes of Pine Forest',
  project_summary: 'Storage shed taller than allowed', ai_recommendation: 'denied', decision_record: null });
const DECIDED = Object.freeze({ id: 'done', status: 'decided', community_name: 'Waterview Estates', decision_type: 'approved_with_conditions', decision_record: null });
const snapshot = JSON.stringify([ROOF, REPAINT_INFO, DRIVEWAY, UNREVIEWED, AWAITING, DENY_REC, DECIDED]);

// Ed deciding a routine case under the written delegation on file (a
// governing-document citation alone is not authority, so it would stay pending).
const edRecord = (extra = {}) => DA.ownerDecisionRecord(ED, { outcome: 'approved_with_conditions', authority_kind: 'written_delegation', authority_reference: 'Guidelines 1.4.4.1, p. 2: Committee delegation to the Managing Agent', authority_library_document_id: '00000000-0000-0000-0000-0000000000d1', clearly_compliant: true, ...extra });

console.log('\nACC queue sections');
check('Annie recommends approval, nothing recorded -> Pending Ed', stage(ROOF) === 'pending_ed');
check('Annie recommends denial -> Pending Ed (every denial is Ed\'s)', stage(DENY_REC) === 'pending_ed');
check('driveway expansion needs Ed\'s judgment even when Annie asks for info -> Pending Ed', stage(DRIVEWAY) === 'pending_ed', JSON.stringify(DA.queueStage(DRIVEWAY)));
check('Annie recommends asking for more info -> Submitted (staff may send that)', stage(REPAINT_INFO) === 'submitted');
check('not reviewed yet -> Submitted', stage(UNREVIEWED) === 'submitted');
check('waiting on the homeowner -> Submitted', stage(AWAITING) === 'submitted');
check('decided -> Completed', stage(DECIDED) === 'completed');
check('archived / withdrawn never show as open work', stage({ ...ROOF, status: 'archived' }) === 'completed' && stage({ ...ROOF, status: 'withdrawn' }) === 'completed');
check('sending -> Decided, letter not sent', stage({ ...ROOF, status: 'finalizing', decision_record: edRecord() }) === 'ready_to_send');
check('Pending Ed explains why', /Annie recommends: approved with conditions/.test(DA.queueStage(ROOF).detail) && /judgment/i.test(DA.queueStage(DRIVEWAY).detail));

console.log('\nOnly an authorized decision moves a case out of Pending Ed');
const roofEd = { ...ROOF, decision_record: edRecord() };
check('Ed\'s own recorded decision -> Decided, letter not sent', stage(roofEd) === 'ready_to_send', JSON.stringify(DA.queueStage(roofEd)));
const forged = { ...edRecord(), decided_by_email: 'staffer@bedrocktx.com', recorded_by: { id: STAFF.id, email: STAFF.email, name: STAFF.full_name } };
check('Ed citing a governing document alone (no delegation, no committee) stays Pending Ed',
  stage({ ...ROOF, decision_record: DA.ownerDecisionRecord(ED, { outcome: 'approved_with_conditions', authority_kind: 'governing_document', authority_reference: 'Declaration Article II, p. 12' }) }) === 'pending_ed');
check('a record claiming Ed but entered by staff does not count', stage({ ...ROOF, decision_record: forged }) === 'pending_ed');
check('staff cannot record a decision as Ed', !!DA.recordDecision(STAFF, { decided_by: 'ed', outcome: 'approved' }, ROOF).error);
check('an admin who is not Ed cannot record a decision as Ed', !!DA.recordDecision(ADMIN_NOT_ED, { decided_by: 'ed', outcome: 'approved' }, ROOF).error);
check('staff cannot record themselves as the decider', !!DA.recordDecision(STAFF, { decided_by: 'staff', outcome: 'approved' }, ROOF).error);
const annieRec = { ...edRecord({ outcome: 'approved', authority_kind: 'written_delegation', authority_reference: 'hypothetical delegation', authority_library_document_id: '00000000-0000-0000-0000-0000000000d1', clearly_compliant: true }), decided_by: 'annie', decided_by_email: null };
check('an Annie decision record does not count while AI decisions are off', stage({ ...ROOF, decision_record: annieRec }) === 'pending_ed');
check('AI decisions are off by default', DA.aiDecisionsEnabled() === false);
check('a case Ed reviewed (review only) but did not decide stays Pending Ed until a decision is recorded',
  stage({ ...ROOF, owner_review: { reviewed_at: '2026-10-29T12:00:00Z', reviewed_by: ED.email } }) === 'pending_ed');
const driveReviewed = { ...DRIVEWAY, owner_review: { reviewed_at: '2026-10-29T12:00:00Z', reviewed_by: ED.email } };
check('a driveway case Ed has reviewed leaves Pending Ed for the info request staff can send', stage(driveReviewed) === 'submitted', JSON.stringify(DA.queueStage(driveReviewed)));

console.log('\nAnnie cannot skip Ed');
check('Annie cannot be entered as decider from any screen', /agent workflow/.test(DA.recordDecision(ED, { decided_by: 'annie', outcome: 'approved' }, ROOF).error || ''));
const annieIssue = DA.checkFinalDecision({ ...ROOF, decision_record: annieRec }, { decisionType: 'approved_with_conditions', actor: ED, requireIssuer: true });
check('an approval letter on an Annie record is refused', !annieIssue.ok, JSON.stringify(annieIssue));
const noRecord = DA.checkFinalDecision(ROOF, { decisionType: 'approved_with_conditions', actor: STAFF, requireIssuer: true });
check('an approval on Annie\'s recommendation alone is refused (decision_record_required)', !noRecord.ok && noRecord.code === 'decision_record_required', JSON.stringify(noRecord));
const denyNoRecord = DA.checkFinalDecision(DENY_REC, { decisionType: 'denied', actor: STAFF, requireIssuer: true });
check('a denial on Annie\'s recommendation alone is refused', !denyNoRecord.ok);
const noActor = DA.checkFinalDecision(roofEd, { decisionType: 'approved_with_conditions', actor: null, requireIssuer: true });
check('an authorized decision still needs a signed-in person to issue it (no automated issuer)', !noActor.ok && noActor.code === 'not_authenticated');
const edIssue = DA.checkFinalDecision(roofEd, { decisionType: 'approved_with_conditions', actor: STAFF, requireIssuer: true });
check('once Ed has decided, a signed-in staff member may send it', edIssue.ok, JSON.stringify(edIssue));
const mismatch = DA.checkFinalDecision(roofEd, { decisionType: 'denied', actor: STAFF, requireIssuer: true });
check('the letter must match the recorded decision (Ed approved -> no denial letter)', !mismatch.ok);
const disguised = DA.checkFinalDecision(REPAINT_INFO, { decisionType: 'request_more_info', texts: ['Good news: your architectural application has been approved.'], actor: STAFF, requireIssuer: true });
check('an "info request" whose text approves is treated as an approval and refused', !disguised.ok);

(async () => {
  console.log('\nEmail transport guard (every Graph send)');
  const homeowner = 'homeowner@example.com';
  const refused = async (args) => { try { await accDecisionGuard(args); return false; } catch (e) { return e.code === 'acc_decision_not_authorized'; } };
  check('an approval email to a homeowner with no case is refused',
    await refused({ to: homeowner, subject: 'Your ACC application', text: 'Your architectural application has been approved, subject to the conditions below.' }));
  check('a denial email to a homeowner with no case is refused',
    await refused({ to: homeowner, subject: 'ACC application', html: '<p>Your architectural application has been denied.</p>' }));
  // The body is often named by abbreviation; these passed unchecked before 2026-10-29.
  for (const t of ['The ACC has approved your architectural application.', 'The ARC approved your request.', 'The ARC has granted approval for your fence.',
    'The ACC has denied your architectural application.', 'The ARC has denied your request.', 'Your application is not approved by the ACC.']) {
    check(`abbreviated body is caught: "${t}"`, await refused({ to: homeowner, subject: 'Your request', text: t }));
  }
  for (const t of ['We cannot say the ACC has approved anything until we receive the survey.', 'Please send the survey so the ACC can review your architectural application.',
    'Your ACC application is not approved by the deadline unless documents arrive.']) {
    check(`info request still sends: "${t}"`, !(await refused({ to: homeowner, subject: 'Your request', text: t })));
  }
  check('an information request still sends',
    !(await refused({ to: homeowner, subject: 'Your ACC application', text: 'Could you send a survey showing the setback? We need it to finish reviewing your architectural application.' })));
  check('internal staff mail (to Ed for review) is not blocked',
    !(await refused({ to: 'egojara@bedrocktx.com', subject: 'Annie recommends approval', text: 'Recommend: approved with conditions for the architectural application.' })));

  console.log('\nWiring (static)');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const list = server.slice(server.indexOf("app.get('/acc-review/decisions',"), server.indexOf("app.get('/acc-review/decisions/:id/email'"));
  check('the Requests list reads the decision record (so sections follow the gate)', /WITH_AUTHORITY = `\$\{WITH_CURRENT\}, decision_record, owner_review/.test(list));
  check('the Requests list returns queue_stage from queueStage', /queue_stage: DA\.queueStage\(/.test(list));
  check('the decision record itself is not sent to the browser list', /\(\{ decision_record, owner_review, approval_gate, approval_gate_reason, \.\.\.r \}\)/.test(list));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const key of ['pending_ed', 'submitted', 'drafts', 'ready_to_send', 'completed']) {
    check(`Requests screen has the "${key}" section`, html.includes(`key: '${key}'`));
  }
  check('Requests screen labels the section "Pending Ed\'s approval"', html.includes("✋ Pending Ed's approval"));

  check('fixtures not mutated', JSON.stringify([ROOF, REPAINT_INFO, DRIVEWAY, UNREVIEWED, AWAITING, DENY_REC, DECIDED]) === snapshot);
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall ACC approval-queue checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
