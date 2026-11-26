// ============================================================================
// tests/test_acc_work_views.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Annie's queue holds only current, actionable applications; waiting, decision-
// owner, historical and completed cases have their own views, each with receipt
// date, deadline, responsible person and next action (lib/acc/work_view). The
// start-up catch-up finishes current cases only (lib/acc/catch_up).
// Run: node tests/test_acc_work_views.js
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const fs = require('fs');
const path = require('path');
const W = require('../lib/acc/work_view');
const RP = require('../lib/acc/review_periods');
const C = require('../lib/acc/catch_up');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };
const NOW = new Date('2026-11-26T20:00:00Z');
const cur = (o) => ({ id: 'c1', status: 'pending_review', community_id: 'cg', community_name: 'Canyon Gate at Cinco Ranch', created_at: '2026-11-26T18:17:00Z', updated_at: '2026-11-26T18:17:06Z',
  project_summary: 'Removal of 5 trees', ai_recommendation: 'request_more_info', ai_review_text: 'Missing arborist report', submitter_email: 'owner@example.test', ...o });
const ACTIVE = { id: 'cg', management_status: 'active' };

console.log('\nViews');
let v = W.workView(cur(), { community: ACTIVE, now: NOW });
check('a new incomplete application is Annie\'s current work: send the request', v.view === 'current' && v.responsible === 'Annie' && /request for the missing information/.test(v.next_action), JSON.stringify(v));
check('...with receipt date, deadline (CG 45 days from receipt) and the receipt flag', v.received_at === '2026-11-26T18:17:00Z' && /45 days/.test(v.deadline_basis) && Date.parse(v.deadline) >= Date.parse('2027-01-10T00:00:00Z') && v.flags.some((f) => /receipt not yet sent/.test(f)), JSON.stringify(v));
v = W.workView(cur({ received_at: '2026-11-26T17:19:00Z', received_at_basis: 'forwarded_original' }), { community: ACTIVE, now: NOW });
check('the original receipt date (migration 579) wins over when the case was opened', v.received_at === '2026-11-26T17:19:00Z' && v.received_basis === 'forwarded_original');
v = W.workView(cur({ decision_type: 'request_more_info', updated_at: '2026-11-26T18:30:00Z', acknowledged_at: '2026-11-26T18:20:00Z' }), { community: ACTIVE, now: NOW });
check('request sent, nothing new since: waiting on the homeowner', v.view === 'waiting_applicant' && /Homeowner/.test(v.responsible), JSON.stringify(v));
v = W.workView(cur({ decision_type: 'request_more_info', updated_at: '2026-11-26T18:30:00Z', current_review_at: '2026-11-28T15:00:00Z', current_ai_recommendation: 'request_more_info' }), { community: ACTIVE, now: NOW });
check('new documents re-reviewed after the request: back in Annie\'s current work', v.view === 'current', JSON.stringify(v));
v = W.workView(cur({ project_summary: 'Pour a new 12x16 concrete patio', ai_recommendation: 'approved' }), { community: ACTIVE, now: NOW });
check('a concrete addition: waiting on Ed', v.view === 'waiting_decision' && v.responsible === 'Ed', JSON.stringify(v));
v = W.workView(cur({ created_at: '2026-11-17T18:12:00Z' }), { community: ACTIVE, now: NOW });
check('a recent case on Ed\'s backlog hold: waiting on Ed, not Annie\'s queue', v.view === 'waiting_decision' && /backlog hold/.test(v.responsible), JSON.stringify(v));
v = W.workView(cur({ created_at: '2026-08-27T21:28:00Z', community_name: 'Waterview Estates' }), { community: ACTIVE, now: NOW });
check('an old held case past its review period: historical exception (Amanda; Ed decides; nothing sent)', v.view === 'historical' && /Amanda/.test(v.responsible) && /Nothing is sent/.test(v.next_action) && v.overdue, JSON.stringify(v));
v = W.workView(cur({ created_at: '2026-10-22T14:24:00Z', community_name: 'Eaglewood' }), { community: { id: 'eag', management_status: 'archived' }, now: NOW });
check('a community Bedrock no longer manages: historical, no action', v.view === 'historical' && /no longer managed/.test(v.next_action), JSON.stringify(v));
const twins = [{ id: 't1', status: 'decided', reference_number: 'WAT-ARC-2026-0030', created_at: '2026-10-07T12:00:00Z', decided_at: '2026-10-07T12:00:00Z' }];
v = W.workView(cur({ id: 'c2', created_at: '2026-10-13T21:44:00Z', community_name: 'Waterview Estates' }), { community: ACTIVE, twins, now: NOW });
check('a decided twin at the same property: flagged as a possible duplicate, never auto-archived', v.flags.some((f) => /possible duplicate of WAT-ARC-2026-0030/.test(f)) && v.view !== 'completed', JSON.stringify(v));
v = W.workView(cur({ id: 'c3', created_at: '2026-11-25T12:00:00Z' }), { community: ACTIVE, twins: [{ ...twins[0], created_at: '2026-05-01T00:00:00Z' }], now: NOW });
check('a decision at the same property months earlier is not a duplicate', !v.flags.some((f) => /duplicate/.test(f)));
for (const st of ['decided', 'archived', 'withdrawn']) check(`${st}: completed view`, W.workView(cur({ status: st }), { community: ACTIVE, now: NOW }).view === 'completed');

console.log('\nReview periods from the governing documents');
check('Waterview 45 days, deemed denied', RP.reviewPeriodFor('Waterview Estates').days === 45 && /deemed denied/.test(RP.reviewPeriodFor('Waterview Estates').label));
check('Quail Ridge 30 days, deemed approved', RP.reviewPeriodFor('Quail Ridge').days === 30 && /deemed approved/.test(RP.reviewPeriodFor('Quail Ridge').label));
check('Still Creek 30, August Meadows 30', RP.reviewPeriodFor('Still Creek Ranch').days === 30 && RP.reviewPeriodFor('August Meadows').days === 30);
check('no period found (LOPF): Bedrock standard, labeled as such', /Bedrock standard/.test(RP.reviewPeriodFor('Lakes of Pine Forest').label));
const d = RP.deadlineFrom('2026-10-27T15:00:00Z', { days: 30 });
check('a deadline on a weekend/holiday moves to the next business day', require('../lib/builder_arc/deadlines').isBusinessDay(new Date(d)) && Date.parse(d) >= Date.parse('2026-11-26T15:00:00Z'), d);

console.log('\nStart-up catch-up (recovery, current cases only)');
check('receipt goes to the applicant and external correspondents, never staff', JSON.stringify(C.receiptRecipients({ submitter_email: 'Owner@Example.test', correspondent_emails: ['owner@example.test', 'pm@hoa.example', 'martha@bedrocktx.com'] })) === JSON.stringify(['owner@example.test', 'pm@hoa.example']));
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'catch_up.js'), 'utf8');
check('only cases after the backlog cutoff are read, and never held/historical/overdue ones', /gte\('created_at', BH\.BACKLOG_CUTOFF\)/.test(src) && /isBacklogHeld\(row\) \|\| v\.view === 'historical' \|\| v\.overdue/.test(src));
const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('runs once at start (setTimeout, not setInterval)', /setTimeout\(\(\) => \{\s*require\('\.\/lib\/acc\/catch_up'\)\.catchUpCurrentCases/.test(sv));
check('the queue endpoint returns the work view and degrades before migration 579', /work_view = WV\.workView/.test(sv) && /received_at\/i\.test\(error\.message/.test(sv));

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall ACC work-view checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
