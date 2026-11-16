// Mission Control search and "Requires my approval" (Ed 2026-11-16): a search box over every task,
// and a filter showing only real pending owner approvals, each linking to its approval screen.
// Mission Control never approves anything itself.
'use strict';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const OPS = require('../lib/mission_control/operations');
const c = { id: 'cid', name: 'Canyon Gate at Cinco Ranch' };
const C = new Map([[c.id, c]]);

console.log('approvals');
{
  const runs = [
    { id: 'run-prepared-1', process: 'recognition', period_month: '2026-11-01', status: 'prepared', totals: {} },
    { id: 'run-held-2', process: 'bank_reconciliation', period_month: '2026-10-01', status: 'held', totals: { account: 'Operating 3170' }, held_reason: 'statement missing' },
  ];
  const t = OPS.runTasks(c, runs, () => null);
  const by = Object.fromEntries(t.map((n) => [n.source.ref, n]));
  check('a prepared Kat run requires the owner\'s approval and reviews on the Command Center', by['run-prepared-1'].approval === true && by['run-prepared-1'].action.url === '/ed.html?run=run-prepared-1');
  check('a held run waits on an input, not on an approval', by['run-held-2'].approval === false);
  check('the run id and process are searchable', by['run-prepared-1'].search_terms.includes('run-prepared-1') && by['run-prepared-1'].search_terms.includes('recognition'));
}
{
  const invs = [
    { id: 'i1', community_id: 'cid', vendor_invoice_number: '26856', total_cents: 1294778, vendors: { name: 'Taylor Security LLC' }, ap_invoice_approvals: [{ action: 'approved' }] },
    { id: 'i2', community_id: 'cid', vendor_invoice_number: '118198', total_cents: 870330, vendors: { name: 'Earthcare Management, Inc.' }, ap_invoice_approvals: [{ action: 'approved' }] },
    { id: 'i3', community_id: 'cid', vendor_invoice_number: 'X1', total_cents: 100, vendors: { name: 'Not approved yet' }, ap_invoice_approvals: [] },
    { id: 'i4', community_id: 'cid', vendor_invoice_number: 'X2', total_cents: 100, vendors: { name: 'Already released' }, ap_invoice_approvals: [{ action: 'approved' }, { action: 'released_for_payment' }] },
    { id: 'i5', community_id: 'other', vendor_invoice_number: 'X3', total_cents: 100, vendors: { name: 'Books elsewhere' }, ap_invoice_approvals: [{ action: 'approved' }] },
  ];
  const r = OPS.releaseNodes(invs, C);
  check('manager-approved, unreleased bills become ONE release item per association', r.length === 1 && /Release 2 approved bills/.test(r[0].title));
  check('it requires approval and its Review link is the Command Center list (nothing is released here)', r[0].approval === true && r[0].action.url === '/ed.html' && r[0].owner === 'Ed');
  check('vendors and invoice numbers are searchable', ['26856', '118198', 'Taylor Security LLC'].every((s) => r[0].search_terms.includes(s)) && r[0].detail.some((d) => /#26856/.test(d)));
  check('unapproved, released and other-books bills are left out', !r[0].search_terms.some((s) => /^X\d/.test(s)));
}
{
  const objs = OPS.objectiveNodes([
    { id: 'o1', title: 'Payment awaiting release: RMWBH PS-INV350881 ($557.35)', subject_key: 'legal_invoice:58889418-9334-47ed-93aa-c79d6796732f', autonomy_class: 'REVIEW', accountable_persona: 'amanda' },
    { id: 'o2', title: 'Approval required: $170.00 homeowner chargebacks on Winstead PC 4071916', subject_key: 'legal_recovery:9de94cd8-adc1-44ec-b539-5b754346bdff', autonomy_class: 'REVIEW', accountable_persona: 'amanda' },
    { id: 'o3', title: 'Chase the vendor for a W-9', subject_key: 'vendor:abc', autonomy_class: 'ACT', accountable_persona: 'emma' },
  ], C);
  check('an agent\'s "payment awaiting release" is an approval reviewed in the approval queue', objs[0].approval === true && objs[0].action.url === '/ed.html');
  check('an agent\'s "approval required" opens the Legal Invoice Review screen', objs[1].approval === true && /^\/app\/financial\/legal\?id=/.test(objs[1].action.url));
  check('an agent\'s own open work is not an approval', objs[2].approval === false);
}

console.log('page');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'mission-control.html'), 'utf8');
check('a prominent search box and a "Requires my approval" toggle', /id="mc-q" type="search"/.test(page) && /id="mc-appr"[^>]*>Requires my approval/.test(page));
check('search reads association, agents, description, detail (vendors, invoice #), source id (run id) and search_terms', ['n.community && n.community.name', 'n.owner', 'n.requested_by', 'n.why', "(n.detail || []).join(' ')", 'n.source && n.source.ref', "(n.search_terms || []).join(' ')"].every((s) => page.includes(s)));
check('search covers the whole dataset: the dropdown filters and the done filter do not narrow it', /if \(searching\(\)\) \{[\s\S]{0,200}return \(data\.nodes \|\| \[\]\)\.filter/.test(page));
check('the approval filter keeps only open items marked approval by the server', page.includes("function isApproval(n) { return n.approval === true && (n.effective_state || n.state) !== 'done'; }"));
check('approval rows link to their authoritative screen with Review; Mission Control adds no approve call', page.includes('Review →') && !/\/approve['"]/.test(page) && !/released_for_payment/.test(page));
check('search runs on input, with no timer', page.includes("$('mc-q').addEventListener('input'") && !/setInterval|setTimeout\(\s*function\s*\(\)\s*\{\s*filters/.test(page));

console.log(`\nmission control search: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
