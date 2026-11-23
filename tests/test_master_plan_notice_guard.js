// tests/test_master_plan_notice_guard.js  (Ed 2026-11-20)
// A recorded builder master-plan decision authorizes a notice of that decision
// only to its applicant or a recipient recorded on it, and only when the email's
// outcome matches the recorded one. Offline: pure rule, no database.
const DA = require('../lib/acc/decision_authority');
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  \x1b[32m✓\x1b[0m ' + name);
  else { failures++; console.log('  \x1b[31m✗ ' + name + '\x1b[0m' + (detail ? '\n      ' + detail : '')); }
}
const APPROVE = { ok: false, approval: true, denial: false };
const DENY = { ok: false, approval: false, denial: true };
const sub = (o = {}) => Object.assign({ reference_number: 'TST-MPS-2026-0001', status: 'approved_with_conditions', decided_by: 'Owner', decided_at: '2026-11-20T22:00:00Z',
  submitter_email: 'applicant@builder.example', ai_extraction: { decision_notice_recipients: [{ email: 'developer@dev.example', authorized_by: 'Owner' }] } }, o);
const ok = (subs, chk, to) => DA.authorizesMasterPlanNotice(subs, chk, to).ok;

check('applicant may be told of a recorded approval', ok([sub()], APPROVE, ['applicant@builder.example']));
check('recorded notice recipient may be told', ok([sub()], APPROVE, ['Developer@Dev.example']));
check('a stranger may not', !ok([sub()], APPROVE, ['someone@else.example']));
check('one stranger among allowed recipients blocks the send', !ok([sub()], APPROVE, ['developer@dev.example', 'someone@else.example']));
check('undecided submission does not authorize', !ok([sub({ decided_by: null })], APPROVE, ['applicant@builder.example']));
check('approval email against a denied record is refused', !ok([sub({ status: 'denied' })], APPROVE, ['applicant@builder.example']));
check('denial email against an approved record is refused', !ok([sub()], DENY, ['applicant@builder.example']));
check('pending submission does not authorize', !ok([sub({ status: 'under_review', decided_by: null, decided_at: null })], APPROVE, ['applicant@builder.example']));
check('every submission in a set must list the recipient', !ok([sub(), sub({ reference_number: 'TST-MPS-2026-0002', ai_extraction: {} })], APPROVE, ['developer@dev.example']));
check('empty set does not authorize', !ok([], APPROVE, ['applicant@builder.example']));

if (failures) { console.log('\n' + failures + ' failed'); process.exit(1); }
console.log('\nmaster plan notice guard: all passed');
