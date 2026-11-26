// ============================================================================
// tests/test_acc_annie_issue.js  (Ed 2026-11-18)
// ----------------------------------------------------------------------------
// Annie issues her own routine ACC decisions (lib/acc/annie_issue) through the
// finalize path, with no staff step, only where the community's written
// delegation is on file; everything else stays in the queue. Denial letters
// carry the appeal notice (server.js _accWithAppealNotice + GLOBAL_RULES).
// Run: node tests/test_acc_annie_issue.js
// ============================================================================
const fs = require('fs');
const path = require('path');
delete process.env.ACC_AI_DECISIONS_ENABLED;
const DA = require('../lib/acc/decision_authority');
const A = require('../lib/acc/annie_issue');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

const WV = 'wv'; const LOPF = 'lopf';
const DELEGATION = { library_document_id: '6eeb8060-9b0a-4e88-b714-45f775a0442a', reference: 'Architectural Guidelines (2016) §1.4.4.1-1.4.4.2: the Committee delegates to the Managing Agent', appeal: 'a Managing Agent denial may be appealed to the Architectural Control Committee within 30 days (§1.4.5.1)' };
const base = (o) => ({ id: 'c1', status: 'pending_review', created_at: '2026-11-20T12:00:00Z', community_id: WV, community_name: 'Waterview Estates', reference_number: 'WAT-ARC-TEST', submitter_email: 'owner@example.test',
  project_summary: 'Roof replacement with architectural shingles, Weathered Wood', current_ai_recommendation: 'approved_with_conditions', current_review_at: '2026-11-18T15:00:00Z',
  current_letter_body: 'Your application is approved subject to the conditions below.', ...o });
function fakeDb(rows, delegations = { [WV]: DELEGATION }) {
  return { from(table) {
    const q = { _t: table, _id: null, select() { return q; }, eq(k, v) { q._id = v; return q; },
      async maybeSingle() {
        if (table === 'acc_decisions') return { data: rows[q._id] || null, error: null };
        if (table === 'communities') return { data: { acc_delegation: delegations[q._id] || null }, error: null };
        return { data: null, error: null };
      } };
    return q;
  } };
}
const calls = [];
A.registerIssuer(async (id, body) => { calls.push({ id, body }); return { status: 200, json: { final: true, email: { sent: true }, finalization_id: 'fin-1' } }; });

(async () => {
  console.log('\nAnnie issues routine decisions herself');
  let r = await A.issueIfReady(fakeDb({ c1: base() }), 'c1');
  check('a routine Waterview roof is issued by Annie, no staff step', r.issued === true && calls.length === 1, JSON.stringify(r));
  check('...with her current letter, to the applicant, as her own decision', calls[0] && calls[0].body.send === true && calls[0].body.to_email === 'owner@example.test'
    && calls[0].body.decision_type === 'approved_with_conditions' && calls[0].body.body_text === base().current_letter_body && calls[0].body.draft_basis_review_at === base().current_review_at);
  r = await A.issueIfReady(fakeDb({ c1: base({ current_ai_recommendation: 'denied', current_letter_body: 'Your application is denied because Section 3.2 limits fences to 6 ft.' }) }), 'c1');
  check('a routine denial is issued by Annie too', r.issued === true && calls[1].body.decision_type === 'denied', JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base() }), 'c1', { dryRun: true });
  check('dry run lists it and sends nothing', r.would_issue === true && calls.length === 2, JSON.stringify(r));

  console.log('\nEverything else stays in the queue');
  const n = calls.length;
  r = await A.issueIfReady(fakeDb({ c1: base({ community_id: LOPF, community_name: 'Lakes of Pine Forest' }) }), 'c1');
  check('no delegation on file (committee or Board decides): not issued', !r.issued && /no ACC authority is recorded/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ project_summary: 'Pour a new 12x16 concrete patio' }) }), 'c1');
  check('a concrete addition (Ed\'s approval): not issued', !r.issued && /owner review required/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ project_summary: 'Replace existing driveway and extend width on one side by 2 ft' }) }), 'c1');
  check('a driveway modification (Ed\'s approval): not issued', !r.issued && /owner review required/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ project_summary: 'Requesting a variance to build an 8 ft fence' }) }), 'c1');
  check('a variance (committee or Board): not issued', !r.issued && /committee or board/i.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ submitter_email: null }) }), 'c1');
  check('no applicant email: left for a person to mail', !r.issued && /no applicant email/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ status: 'decided' }) }), 'c1');
  check('a decided case is never re-issued', !r.issued && /decided/.test(r.skipped || ''));
  process.env.ACC_AI_DECISIONS_ENABLED = 'false';
  r = await A.issueIfReady(fakeDb({ c1: base() }), 'c1');
  delete process.env.ACC_AI_DECISIONS_ENABLED;
  check('kill switch: nothing issued', !r.issued && /turned off/.test(r.skipped || ''));
  check('none of those reached the send path', calls.length === n);

  console.log('\nAnnie requests the missing information herself (Ed 2026-11-26, 6331 Clear Canyon)');
  {
    const rfi = (o) => base({ community_id: 'cg', community_name: 'Canyon Gate at Cinco Ranch', project_summary: 'Removal of 5 trees along the side street', current_review_at: null, current_ai_recommendation: null, current_letter_body: null,
      ai_recommendation: 'request_more_info', ai_review_text: 'Missing: arborist report.', ai_letter_body: 'Thank you for your application. To complete the review, please send the arborist report.', created_at: '2026-11-26T18:17:04Z', updated_at: '2026-11-26T18:17:06Z', ...o });
    const k = calls.length;
    r = await A.issueIfReady(fakeDb({ c1: rfi() }, {}), 'c1');
    check('an incomplete current case: Annie sends her request for information (no staff step, no Ed)', r.requested_info === true && calls.length === k + 1, JSON.stringify(r));
    check('...as a request (not a decision), her drafted letter, to the applicant', calls[k] && calls[k].body.decision_type === 'request_more_info' && calls[k].body.send === true && calls[k].body.to_email === 'owner@example.test' && /arborist report/.test(calls[k].body.body_text));
    check('...it is never issued as a decision', !r.issued);
    r = await A.issueIfReady(fakeDb({ c1: rfi({ decision_type: 'request_more_info', updated_at: '2026-11-26T18:20:00Z' }) }, {}), 'c1');
    check('the request for this review is sent once (already recorded: not again)', !r.requested_info && /already sent/.test(r.skipped || '') && calls.length === k + 1, JSON.stringify(r));
    r = await A.issueIfReady(fakeDb({ c1: rfi({ decision_type: 'request_more_info', updated_at: '2026-11-26T18:20:00Z', current_review_at: '2026-11-28T15:00:00Z', current_ai_recommendation: 'request_more_info', current_letter_body: 'Thank you for the report. Please also send the survey.' }) }, {}), 'c1');
    check('a NEW review after new documents may ask again', r.requested_info === true && /survey/.test(calls[calls.length - 1].body.body_text), JSON.stringify(r));
    const k2 = calls.length;
    r = await A.issueIfReady(fakeDb({ c1: rfi({ created_at: '2026-10-13T21:36:00Z' }) }, {}), 'c1');
    check('a historical (backlog) case: nothing is sent to the homeowner', !r.requested_info && /backlog hold/.test(r.skipped || '') && calls.length === k2, JSON.stringify(r));
    r = await A.issueIfReady(fakeDb({ c1: rfi({ ai_recommendation: 'approved_with_conditions', ai_letter_body: 'Your application is approved.', project_summary: 'Driveway extension, footprint not stated' }) }, {}), 'c1');
    check('routed for information but the review recommends a decision: a person words the request', !r.requested_info && calls.length === k2, JSON.stringify(r));
    r = await A.issueIfReady(fakeDb({ c1: rfi({ submitter_email: null }) }, {}), 'c1');
    check('no applicant email: left for a person', !r.requested_info && /no applicant email/.test(r.skipped || '') && calls.length === k2, JSON.stringify(r));
    r = await A.issueIfReady(fakeDb({ c1: rfi() }, {}), 'c1', { dryRun: true });
    check('dry run lists it and sends nothing', r.would_request_info === true && calls.length === k2, JSON.stringify(r));
    process.env.ACC_AI_INFO_REQUESTS = 'off';
    r = await A.issueIfReady(fakeDb({ c1: rfi() }, {}), 'c1');
    delete process.env.ACC_AI_INFO_REQUESTS;
    check('kill switch: nothing sent', !r.requested_info && /turned off/.test(r.skipped || '') && calls.length === k2);
    const ei = fs.readFileSync(path.join(__dirname, '..', 'lib', 'applications', 'email_intake.js'), 'utf8');
    check('the email door coordinates ONE first message (receipt folded into the outcome)', /deferIssue: true/.test(ei) && ei.includes("require('../acc/first_contact').respondToApplication(supabase, pend.id"));
  }

  console.log('\nWhich letter Annie sends');
  check('her current-review letter', A.letterFor(base(), 'approved_with_conditions').source === 'current_review');
  check('a staff-edited draft for the same decision, from the current review, is kept', A.letterFor(base({ letter_body: 'Edited wording.', letter_draft_review_at: '2026-11-18T15:00:00Z', decision_type: 'approved_with_conditions' }), 'approved_with_conditions').source === 'working_draft');
  check('a staff draft from an older review is not used', A.letterFor(base({ letter_body: 'Old.', letter_draft_review_at: '2026-11-01T00:00:00Z' }), 'approved_with_conditions').source === 'current_review');
  check('a staff draft for a different decision is not used', A.letterFor(base({ letter_body: 'Denied.', letter_draft_review_at: '2026-11-18T15:00:00Z', decision_type: 'denied' }), 'approved_with_conditions').source === 'current_review');
  check('older cases: the intake letter', A.letterFor({ ai_recommendation: 'approved', ai_review_text: 'ok', ai_letter_body: 'Approved.', created_at: '2026-10-01T00:00:00Z' }, 'approved').source === 'intake_review');

  console.log('\nAnnie as issuer of her own decision only');
  const ANNIE = { id: null, agent: 'annie', email: 'annie@bedrocktx.com', is_active: true };
  const row = { ...base(), acc_delegation: DELEGATION };
  const rec = DA.annieDecisionFor(row, DELEGATION).rec;
  const ok = DA.checkFinalDecision({ ...row, decision_record: rec }, { decisionType: 'approved_with_conditions', actor: ANNIE, requireIssuer: true });
  check('Annie may issue her own recorded decision', ok.ok, ok.error);
  const ED = { id: 'ed', email: 'egojara@bedrocktx.com', role: 'admin', is_active: true, full_name: 'Ed Gojara' };
  const edRec = DA.ownerDecisionRecord(ED, { outcome: 'approved_with_conditions', authority_kind: 'written_delegation', authority_reference: 'Guidelines §1.4.4.1 delegation', authority_library_document_id: DELEGATION.library_document_id, clearly_compliant: true });
  check('Annie may not issue someone else\'s decision', DA.checkFinalDecision({ ...row, decision_record: edRec }, { decisionType: 'approved_with_conditions', actor: ANNIE, requireIssuer: true }).code === 'not_authenticated');

  console.log('\nBedrock acts as the ACC: the letter says the Committee decided (Ed 2026-11-18)');
  const ACTS = { ...DELEGATION, acts_as: 'committee', basis: 'governing_document' };
  const actsRow = { ...base(), acc_delegation: ACTS };
  const actsRec = DA.annieDecisionFor(actsRow, ACTS).rec;
  const committeeLetter = 'The Architectural Control Committee of Waterview Estates has reviewed your application and is pleased to approve it, subject to the conditions below.';
  check('Annie\'s record says Bedrock acts as the Committee', actsRec && actsRec.authority_basis.acts_as === 'committee' && actsRec.decided_by === 'annie' && actsRec.evaluated_by === 'annie');
  check('a letter saying the Committee approved is sent where Bedrock acts as the ACC', DA.checkFinalDecision({ ...actsRow, decision_record: actsRec }, { decisionType: 'approved_with_conditions', texts: [committeeLetter], actor: ANNIE, requireIssuer: true }).ok);
  check('...Annie stays in the internal record (decided_by annie), never in the letter', actsRec.decided_by === 'annie' && !/Annie/.test(committeeLetter));
  const noActs = { ...base(), acc_delegation: DELEGATION };
  const noActsRec = DA.annieDecisionFor(noActs, DELEGATION).rec;
  check('where Bedrock is not recorded as acting as the ACC, a Committee claim is still refused', DA.checkFinalDecision({ ...noActs, decision_record: noActsRec }, { decisionType: 'approved_with_conditions', texts: [committeeLetter], actor: ANNIE, requireIssuer: true }).code === 'letter_misattributes_decision');
  check('a letter claiming the BOARD decided is still refused (Bedrock acts as the Committee, not the Board)', DA.checkFinalDecision({ ...actsRow, decision_record: actsRec }, { decisionType: 'approved_with_conditions', texts: ['The Board of Directors has reviewed your application and is pleased to approve it.'], actor: ANNIE, requireIssuer: true }).code === 'letter_misattributes_decision');
  const flagged = DA.annieDecisionFor(base(), { status: 'needs_clarification', reason: 'declarant still controls the ARC' });
  check('an association flagged for clarification says why, and only that association waits', /needs clarification \(declarant still controls the ARC\)/.test(flagged.error || ''));
  check('...while another association\'s routine case is still Annie\'s', !!DA.annieDecisionFor(actsRow, ACTS).rec);

  console.log('\nDeveloper communities (Still Creek Ranch, August Meadows; Ed 2026-11-18)');
  const DEV = { library_document_id: '887a9352-bff5-4148-80be-28b1d36ce112', reference: 'Declaration Art. X.A: the Declarant has engaged Bedrock to handle ACC applications', acts_as: 'committee', basis: 'developer_authorization', reserved_to: 'developer', follow_up: 'obtain written confirmation' };
  const dev = (o) => base({ community_id: 'scr', community_name: 'Still Creek Ranch', ...o });
  const devStage = (o) => DA.queueStage({ ...dev(o), acc_delegation: DEV });
  check('a routine Still Creek application is Annie\'s, ready to send (no Ed, no extra step)', devStage({ project_summary: 'Installation of ground-mounted whole-home battery backup system' }).stage === 'ready_to_send');
  r = await A.issueIfReady(fakeDb({ c1: dev({ project_summary: 'Roof replacement, same color' }) }, { scr: DEV }), 'c1');
  check('...and Annie issues it herself', r.issued === true, JSON.stringify(r));
  check('a like-for-like driveway replacement there is Annie\'s too', devStage({ project_summary: 'Driveway replacement, like-for-like within the existing footprint' }).stage === 'ready_to_send');
  check('a concrete addition there goes to Ed (only his two exceptions)', devStage({ project_summary: 'Pour a new concrete patio' }).stage === 'pending_ed');
  check('a driveway modification there goes to Ed', devStage({ project_summary: 'Extend the driveway 3 ft on the left side' }).stage === 'pending_ed');
  const v = devStage({ project_summary: 'Requesting a variance to build an 8 ft fence' });
  check('a decision reserved to the Declarant (variance) goes to the developer, not Ed', v.stage === 'submitted' && /developer's decision/.test(v.detail), JSON.stringify(v));
  r = await A.issueIfReady(fakeDb({ c1: dev({ project_summary: 'Requesting a variance to build an 8 ft fence' }) }, { scr: DEV }), 'c1');
  check('...and Annie never issues it as an approval', !r.issued);
  check('the letter keeps the existing Committee wording (no developer or delegation language)', DA.checkFinalDecision({ ...dev(), acc_delegation: DEV, decision_record: DA.annieDecisionFor({ ...dev(), acc_delegation: DEV }, DEV).rec }, { decisionType: 'approved_with_conditions', texts: ['The Architectural Review Committee of Still Creek Ranch has reviewed your application and is pleased to approve it.'], actor: ANNIE, requireIssuer: true }).ok);

  console.log('\nBacklog hold (Ed 2026-11-18): existing cases wait for Ed; new ones do not');
  const H = require('../lib/acc/backlog_hold');
  const old = base({ created_at: '2026-07-13T12:00:00Z' });
  const before = calls.length;
  r = await A.issueIfReady(fakeDb({ c1: old }), 'c1');
  check('a backlog case Annie would decide is NOT issued', !r.issued && /backlog hold/.test(r.skipped || '') && calls.length === before, JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: old }), 'c1', { dryRun: true });
  check('...not even listed to issue in the owner dry run', !r.would_issue);
  check('...the queue shows it on hold, not ready to send', /On hold: Ed is reviewing/.test(DA.queueStage({ ...old, acc_delegation: DELEGATION }).detail) && DA.queueStage({ ...old, acc_delegation: DELEGATION }).stage === 'submitted');
  r = await A.issueIfReady(fakeDb({ c1: base() }), 'c1');
  check('a new case is issued as usual (no delay, no new approval)', r.issued === true, JSON.stringify(r));
  check('a case with no creation date is treated as backlog (fail closed)', H.isBacklogHeld({ id: 'x' }));
  check('the cutoff is fixed in code (deploys, migrations and restarts never release it)', H.BACKLOG_CUTOFF === '2026-11-19T03:04:33Z' && !/process\.env/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'backlog_hold.js'), 'utf8')));
  check('only cases Ed specifically released (dated, referenced) are out of the hold', [...H.RELEASED.values()].every((v) => v && v.released && v.ref) && H.RELEASED.size === 3 && !H.isBacklogHeld({ id: '5a9a393b-6388-4f15-b0e9-6eced39afc9d', created_at: '2026-11-17T15:05:00Z' }) && H.isBacklogHeld({ id: 'other', created_at: '2026-11-17T15:05:00Z' }));
  {
    const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const f = sv.slice(sv.indexOf('async function _accFinalizeHandler'), sv.indexOf("app.post('/acc-review/decisions/:id/finalize', _accFinalizeHandler)"));
    check('the send path refuses a backlog decision letter unless Ed sends it himself', /isFinal && require\('\.\/lib\/acc\/backlog_hold'\)\.isBacklogHeld\(dec\) && !require\('\.\/lib\/acc\/decision_authority'\)\.isOwnerActor\(actor\)/.test(f) && f.indexOf('backlog_hold') < f.indexOf('finalizeAccDecision('));
  }

  console.log('\nAnnie\'s determination is the decision on every path (Ed 2026-11-19, WAT-ARC-2026-0043)');
  {
    const STAFF = { id: 'u1', email: 'staff@bedrocktx.com', is_active: true, role: 'staff' };
    const OWNER = { id: 'u0', email: DA.OWNER_EMAIL, is_active: true, role: 'admin' };
    const denial = 'The Committee has reviewed your application and has denied it because the garage door color is not cohesive with the home. You may request a hearing before the Board within 30 days.';
    const den = (o) => ({ ...base({ project_summary: 'Garage door repaint, custom color', current_ai_recommendation: 'denied', current_letter_body: denial, ...o }), acc_delegation: { ...DELEGATION, acts_as: 'committee' } });
    let g = DA.checkFinalDecision(den(), { decisionType: 'denied', texts: [denial], actor: STAFF, requireIssuer: true });
    check('a new case: Annie\'s denial is the authorized decision for the draft/letter (no second approval)', g.ok && g.final && g.annie_record && g.annie_record.decided_by === 'annie', JSON.stringify(g.error || g.code));
    g = DA.checkFinalDecision(den(), { decisionType: 'approved', texts: ['Your application is approved.'], actor: STAFF, requireIssuer: true });
    check('staff cannot issue the opposite of Annie\'s decision', !g.ok && g.code === 'decision_outcome_mismatch');
    g = DA.checkFinalDecision(den({ created_at: '2026-11-16T23:33:23Z' }), { decisionType: 'denied', texts: [denial], actor: STAFF, requireIssuer: true });
    check('an existing (backlog) case stays on hold for staff', !g.ok && g.code === 'backlog_hold', JSON.stringify(g.code));
    g = DA.checkFinalDecision(den({ created_at: '2026-11-16T23:33:23Z' }), { decisionType: 'denied', texts: [denial], actor: OWNER, requireIssuer: true });
    check('...and only Ed can produce it from his own account', g.ok && g.final, JSON.stringify(g.error || g.code));
    g = DA.checkFinalDecision(den({ project_summary: 'Pour a new 12x16 concrete patio', current_ai_recommendation: 'approved', current_letter_body: 'Approved.' }), { decisionType: 'approved', texts: ['Your application is approved.'], actor: STAFF, requireIssuer: true });
    check('a concrete addition still needs Ed (not treated as Annie\'s decision)', !g.ok && g.code === 'owner_review_required', JSON.stringify(g.code));
    g = DA.checkFinalDecision(den({ project_summary: 'Requesting a variance to build an 8 ft fence', current_ai_recommendation: 'approved', current_letter_body: 'Approved.' }), { decisionType: 'approved', texts: ['Your application is approved.'], actor: STAFF, requireIssuer: true });
    check('a variance still goes to the Committee/Board', !g.ok && !g.annie_record, JSON.stringify(g.code));
    g = DA.checkFinalDecision({ ...den(), acc_delegation: null }, { decisionType: 'denied', texts: [denial], actor: STAFF, requireIssuer: true });
    check('no delegation on file: still no decision', !g.ok && g.code === 'decision_record_required');
    g = DA.checkFinalDecision(den({ current_ai_recommendation: 'request_more_info' }), { decisionType: 'request_more_info', texts: ['Please send a photo of the home.'], actor: STAFF, requireIssuer: true });
    check('a request for more information is unaffected', g.ok && !g.final);
    const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('draft save, letter, letter PDF and packet paths pass the community delegation to the gate',
      (sv.match(/checkFinalDecision\(\{ \.\.\.dec, acc_delegation: await _accDelegation\(dec\.community_id\) \}/g) || []).length === 2
      && /checkFinalDecision\(row\.id \? \{ \.\.\.row, acc_delegation/.test(sv) && /checkFinalDecision\(gateRow \? \{ \.\.\.gateRow, acc_delegation/.test(sv));
  }

  console.log('\nDenial letters carry the appeal notice');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fnSrc = server.slice(server.indexOf('function _accWithAppealNotice'), server.indexOf('// ANNIE ISSUES HER OWN ROUTINE DECISIONS'));
  // eslint-disable-next-line no-new-func
  const withNotice = new Function('require', `${fnSrc}; return _accWithAppealNotice;`)((m) => require(m.replace('./lib/', '../lib/')));
  const { injectGlobalRule } = require('../lib/global_rules');
  const statutory = injectGlobalRule('tx_209_00505_arc_denial_hearing');
  const letter = 'Dear Owner,\n\nYour application is denied because Section 3.2 limits fences to 6 ft. A 6 ft fence would be approved.\n\nSincerely,\nAnnie Reeves';
  const out = withNotice(letter);
  check('the §209.00505 hearing notice is added', out.includes(statutory));
  check('...and nothing else: the letter is the original plus that notice (Ed: keep letters simple)', out.replace(statutory, '').replace(/\s+/g, ' ').trim() === letter.replace(/\s+/g, ' ').trim());
  check('...no authority, delegation, Managing Agent or Annie wording is added', !/Managing Agent|delegat|Bedrock|Annie Reeves[\s\S]*Annie/.test(out.replace(letter, '')));
  check('...placed before the closing', out.indexOf(statutory) < out.indexOf('Sincerely'));
  check('idempotent: never added twice', withNotice(out) === out);
  check('the finished letter passes Annie\'s denial check', /request a hearing/.test(out));
  const fin = server.slice(server.indexOf('async function _accFinalizeHandler'), server.indexOf("app.post('/acc-review/decisions/:id/finalize', _accFinalizeHandler)"));
  check('finalize injects the notice into every denial before the authority gate', /_accWithAppealNotice\(bodyText\)/.test(fin) && fin.indexOf('_accWithAppealNotice') < fin.indexOf('checkFinalDecision'));
  check('finalize adds nothing else to approval letters (no attribution rewrite)', !/attributeToManagingAgent/.test(fin));
  check('the agent issuer and the owner-authorized actor are set only in-process (never from the request body)', /req\._accAgentIssuer \|\| req\._accOwnerAuthorized \|\| await getActingUser\(req\)/.test(fin) && !/req\.body\._accAgentIssuer|req\.body\._accOwnerAuthorized|body\.agent/.test(fin));
  check('the backlog endpoint is owner-only and dry-runs by default', /app\.post\('\/acc-review\/annie\/issue-ready'[\s\S]{0,200}requireOwner/.test(server) && /dryRun = !\(req\.body && req\.body\.dry_run === false\)/.test(server));
  const docs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'documents.js'), 'utf8');
  const intake = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'pending_intake.js'), 'utf8');
  check('a new review triggers Annie (event-driven, no polling)', /issueIfReadySoon\(supabase, decisionId/.test(docs) && /issueIfReadySoon\(supabase, id, \{ source: 'intake' \}\)/.test(intake));

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall Annie-issue checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
