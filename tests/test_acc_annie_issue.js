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
const base = (o) => ({ id: 'c1', status: 'pending_review', community_id: WV, community_name: 'Waterview Estates', reference_number: 'WAT-ARC-TEST', submitter_email: 'owner@example.test',
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
  check('no delegation on file (committee or Board decides): not issued', !r.issued && /no written ACC delegation/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ project_summary: 'Pour a new 12x16 concrete patio' }) }), 'c1');
  check('a concrete addition (Ed\'s approval): not issued', !r.issued && /owner review required/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ project_summary: 'Replace existing driveway and extend width on one side by 2 ft' }) }), 'c1');
  check('a driveway modification (Ed\'s approval): not issued', !r.issued && /owner review required/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ project_summary: 'Requesting a variance to build an 8 ft fence' }) }), 'c1');
  check('a variance (committee or Board): not issued', !r.issued && /committee or board/i.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ current_ai_recommendation: 'request_more_info' }) }), 'c1');
  check('an incomplete case is not issued as a decision', !r.issued && /request more info/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ submitter_email: null }) }), 'c1');
  check('no applicant email: left for a person to mail', !r.issued && /no applicant email/.test(r.skipped || ''), JSON.stringify(r));
  r = await A.issueIfReady(fakeDb({ c1: base({ status: 'decided' }) }), 'c1');
  check('a decided case is never re-issued', !r.issued && /decided/.test(r.skipped || ''));
  process.env.ACC_AI_DECISIONS_ENABLED = 'false';
  r = await A.issueIfReady(fakeDb({ c1: base() }), 'c1');
  delete process.env.ACC_AI_DECISIONS_ENABLED;
  check('kill switch: nothing issued', !r.issued && /turned off/.test(r.skipped || ''));
  check('none of those reached the send path', calls.length === n);

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

  console.log('\nDenial letters carry the appeal notice');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fnSrc = server.slice(server.indexOf('function _accWithAppealNotice'), server.indexOf('// ANNIE ISSUES HER OWN ROUTINE DECISIONS'));
  // eslint-disable-next-line no-new-func
  const withNotice = new Function('require', `${fnSrc}; return _accWithAppealNotice;`)((m) => require(m.replace('./lib/', '../lib/')));
  const { injectGlobalRule } = require('../lib/global_rules');
  const statutory = injectGlobalRule('tx_209_00505_arc_denial_hearing');
  const letter = 'Dear Owner,\n\nYour application is denied because Section 3.2 limits fences to 6 ft. A 6 ft fence would be approved.\n\nSincerely,\nAnnie Reeves';
  const out = withNotice(letter, DELEGATION);
  check('the §209.00505 hearing notice is added', out.includes(statutory));
  check('the association\'s own appeal route is added when on file', /How to appeal: A Managing Agent denial may be appealed to the Architectural Control Committee within 30 days/.test(out));
  check('...placed before the closing', out.indexOf(statutory) < out.indexOf('Sincerely'));
  check('without a delegation, the statutory notice alone', withNotice(letter, null).includes(statutory) && !/How to appeal/.test(withNotice(letter, null)));
  check('idempotent: never added twice', withNotice(out, DELEGATION) === out);
  check('the finished letter passes Annie\'s denial check', /request a hearing/.test(out));
  const fin = server.slice(server.indexOf('async function _accFinalizeHandler'), server.indexOf("app.post('/acc-review/decisions/:id/finalize', _accFinalizeHandler)"));
  check('finalize injects the notice into every denial before the authority gate', /_accWithAppealNotice\(bodyText, await _accDelegation\(dec\.community_id\)\)/.test(fin) && fin.indexOf('_accWithAppealNotice') < fin.indexOf('checkFinalDecision'));
  check('the agent issuer is set only in-process (never from the request body)', /req\._accAgentIssuer \|\| await getActingUser\(req\)/.test(fin) && !/req\.body\._accAgentIssuer|body\.agent/.test(fin));
  check('the backlog endpoint is owner-only and dry-runs by default', /app\.post\('\/acc-review\/annie\/issue-ready'[\s\S]{0,200}requireOwner/.test(server) && /dryRun = !\(req\.body && req\.body\.dry_run === false\)/.test(server));
  const docs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'documents.js'), 'utf8');
  const intake = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'pending_intake.js'), 'utf8');
  check('a new review triggers Annie (event-driven, no polling)', /issueIfReadySoon\(supabase, decisionId/.test(docs) && /issueIfReadySoon\(supabase, id, \{ source: 'intake' \}\)/.test(intake));

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall Annie-issue checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
