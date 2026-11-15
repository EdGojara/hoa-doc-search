#!/usr/bin/env node
// Ed 2026-11-15: an autopay confirmation for a bill already open in Payables is recorded against the
// bill, never posted straight to expense (the Still Creek MUD 162 double count); and Kat may hold
// more than one journal-entry run open in a month.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13)).join('');
const { matchOpenPayables } = require('../lib/accounting/record_vendor_payment');
const { jeRunSubject } = require('../lib/accounting/monthly_runs');

console.log('open payable');
const bills = [
  { id: 'a', status: 'awaiting_approval', total_cents: 36142, amount_paid_cents: 0, invoice_date: '2026-10-21' },
  { id: 'b', status: 'approved', total_cents: 185727, amount_paid_cents: 0, invoice_date: '2026-10-21' },
  { id: 'c', status: 'paid', total_cents: 46177, amount_paid_cents: 46177, invoice_date: '2026-10-21' },
  { id: 'd', status: 'awaiting_approval', total_cents: 36142, amount_paid_cents: 0, invoice_date: '2026-06-01' },
];
check('the Still Creek autopay ($361.42 on 11/11) matches its open October bill', matchOpenPayables(bills, { amountCents: 36142, postingDate: '2026-11-11' }).map((b) => b.id).join() === 'a');
check('an approved bill counts as open too', matchOpenPayables(bills, { amountCents: 185727, postingDate: '2026-11-11' }).map((b) => b.id).join() === 'b');
check('a paid bill never holds a payment', !matchOpenPayables(bills, { amountCents: 46177, postingDate: '2026-11-11' }).length);
check('a bill more than 90 days before the payment does not match', !matchOpenPayables([bills[3]], { amountCents: 36142, postingDate: '2026-11-11' }).length);
check('a partly paid bill matches on what is still owed', matchOpenPayables([{ id: 'e', status: 'partially_paid', total_cents: 50000, amount_paid_cents: 20000, invoice_date: '2026-11-01' }], { amountCents: 30000, postingDate: '2026-11-11' }).length === 1);
const rv = src('lib/accounting/record_vendor_payment.js');
check('the open-bill check runs before any posting and is not skipped by "confirm duplicate"', rv.indexOf("return { error: 'open_payable'") > 0 && rv.indexOf("return { error: 'open_payable'") < rv.indexOf('const je = await postJournalEntry') && !/if \(!allowDuplicate\) \{\s*const openBills/.test(rv));
check('ingest holds the email for a person and names the bill', src('lib/email/graph_ingest.js').includes("if (out.error === 'open_payable') {") && src('lib/email/graph_ingest.js').includes('auto_gl_held'));
check("Emma's Record-to-GL button explains it (409, Mark paid ACH)", src('api/email_triage.js').includes("error: 'open_payable'") && src('api/email_triage.js').includes('Mark paid (ACH)'));

console.log('journal-entry runs');
const s1 = jeRunSubject('c1', [{ id: 'x' }, { id: 'y' }]);
check('a run subject is a uuid, stable for the same entries in any order', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(s1) && s1 === jeRunSubject('c1', [{ id: 'y' }, { id: 'x' }]));
check('different entries (or another association) get a different subject', s1 !== jeRunSubject('c1', [{ id: 'z' }]) && s1 !== jeRunSubject('c2', [{ id: 'x' }, { id: 'y' }]));
check('prepare gives a journal-entry run its subject before inserting', src('lib/accounting/monthly_runs.js').includes("if (process === 'journal_entry' && !subject_id && items.length) subject_id = jeRunSubject(community_id, items);"));

console.log(`\nautopay open payable: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
