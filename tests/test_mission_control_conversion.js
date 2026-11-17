// Mission Control: what an unposted conversion waits on (Ed 2026-11-16), each with a Review link to
// the existing screen. Nothing is approved, posted or reversed from Mission Control.
'use strict';
const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const OPS = require('../lib/mission_control/operations');
const C = new Map([['wv', { id: 'wv', name: 'Waterview Estates' }]]);
const batches = [{ id: 'b1', community_id: 'wv', batch_code: 'CONV-WE-20260731', status: 'draft' }];
const items = [
  { id: 'i1', batch_id: 'b1', event_key: 'loose:ap_invoices:33fbabb2-2c62-4df0-af72-a55054e058e9', kind: 'ap_invoices', event_date: '2026-09-23', amount_cents: 3404, evidence: { identifier: '112-0467422-8439405', resolution: 'retain' }, structural_issues: ['subsidiary ap_invoices record with no journal entry'] },
  { id: 'i2', batch_id: 'b1', event_key: 'je:a85f5cb4-33d8-498a-a3b4-a5358c0fbad2', kind: 'ap_billback', event_date: '2026-10-11', amount_cents: 55735, evidence: { resolution: 'retain' }, structural_issues: ['AR is posted but no homeowner AR record is linked'] },
  { id: 'i3', batch_id: 'b1', event_key: 'loose:homeowner_transactions:batch:x', kind: 'homeowner_transactions', event_date: '2026-08-31', amount_cents: 4200, evidence: { resolution: 'needs_owner', decision: { question: 'is it already in the legacy books?' } }, structural_issues: [] },
];
const legalByJe = new Map([['a85f5cb4-33d8-498a-a3b4-a5358c0fbad2', { id: 'e8a7c83c', ap_invoice_id: '58889418-9334-47ed-93aa-c79d6796732f' }]]);
const proposals = [{ id: '0f146aca-ec7f-4dd7-ad09-81b7b8459e4e', community_id: 'wv', current_owner_name: 'Seller', effective_start_date: '2026-05-04' }];
const n = OPS.conversionNodes({ batches, items, legalByJe, proposals }, C);
const by = (re) => n.find((x) => re.test(x.title));
check('four owner items, all tasks under "Requires my approval" (a task kind is what the list renders)', n.length === 4 && n.every((x) => x.kind === 'task' && x.approval === true && x.owner === 'Ed'));
check('the bill opens in Payables by its id', by(/Post the \$34\.04 bill/).action.url === '/#tab=ap&invoice=33fbabb2-2c62-4df0-af72-a55054e058e9');
check('the bill-back opens its invoice in Legal Review', by(/Reverse the duplicate \$557\.35/).action.url === '/app/financial/legal?id=58889418-9334-47ed-93aa-c79d6796732f');
check('the conversion question opens the conversion', by(/Answer the/).action.url === '/admin/onboarding?batch=b1');
check('the ownership change opens that proposal', by(/ownership change/).action.url === '/ownership-proposals-review.html?id=0f146aca-ec7f-4dd7-ad09-81b7b8459e4e');
check('searchable by invoice number, posting and batch code', by(/Post the/).search_terms.includes('112-0467422-8439405') && by(/Reverse/).search_terms.includes('e8a7c83c') && by(/Answer/).search_terms.includes('CONV-WE-20260731'));
// Ed 2026-11-16: post-cutover exceptions are carried, not conversion blockers; the duplicate bill-back
// (linked homeowner charge, so no structural issue) still surfaces with the evidence of the source charge.
const carried = OPS.conversionNodes({ batches, legalByJe, proposals: [], items: [
  { ...items[0], evidence: { ...items[0].evidence, post_cutover_exception: { kind: 'structural', issues: items[0].structural_issues } } },
  { ...items[1], structural_issues: [], evidence: { resolution: 'already_in_source', post_cutover_exception: { kind: 'duplicate_of_source', note: 'the source already charged this on 2026-07-30' } } }] }, C);
const dup = carried.find((x) => /Reverse the duplicate \$557\.35/.test(x.title));
check('a carried duplicate bill-back still surfaces, says the conversion does not wait on it, and cites the source charge', !!dup && /does not wait/.test(dup.title) && /2026-07-30/.test(dup.why) && dup.action.url === '/app/financial/legal?id=58889418-9334-47ed-93aa-c79d6796732f');
check('a carried unposted bill says the conversion does not wait on it', carried.some((x) => /Post the \$34\.04 bill/.test(x.title) && /does not wait/.test(x.title)));
check('the ownership change is described as administrative (no effect on the books)', /Administrative/.test(by(/ownership change/).why));
check('a posted conversion or another association adds nothing', OPS.conversionNodes({ batches: [], items, legalByJe, proposals: [] }, C).length === 0);
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'ownership-proposals-review.html'), 'utf8');
check('Ownership Review opens ?id= directly', page.includes("new URLSearchParams(location.search).get('id')") && page.includes('await loadDetail(deepId)'));
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mission_control', 'operations.js'), 'utf8');
check('Mission Control only reads these sources (no insert, update or rpc)', !/conversion owner actions[\s\S]{0,2500}\.(insert|update|upsert|delete|rpc)\(/.test(src));
console.log(`\nmission control conversion: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
