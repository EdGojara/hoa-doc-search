#!/usr/bin/env node
// A bill must get its accrual at intake (Ed 2026-11-04): 8 of 74 bills recovered for Emma had no
// journal entry, so they sat in the approval queue unable to be approved. Two causes:
//   a taxed bill: the lines are pre-tax, and the intake call did not pass the header tax
//   a burst of bills: next_je_reference's lock ends before the insert, so numbers could collide
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13)).join('');
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const intake = src('lib/ap/intake.js');
const call = intake.slice(intake.indexOf('accrualJeId = await postAccrualForInvoice({'), intake.indexOf('accrualJeId = await postAccrualForInvoice({') + 700);
check('intake passes the header tax to the accrual', call.includes('taxCents: extracted.tax_cents || 0'));
check('the guard refuses lines that match neither the total less tax nor the total', intake.includes('const expectedNet = creditTotal - taxCents;') && intake.includes('Math.abs(net - expectedNet) > 1 && Math.abs(net - creditTotal) > 1') && intake.includes('refusing to post a split accrual'));

const posting = src('lib/accounting/posting.js');
const block = posting.slice(posting.indexOf('let ref = reference ||'), posting.indexOf('if (jeErr) {', posting.indexOf('let ref = reference ||')));
check('a colliding automatic number is drawn again, a bounded number of times', /attempt <= 5/.test(block) && /journal_entries_community_id_reference_key/.test(block) && /ref = await generateReference/.test(block));
check('a caller\'s explicit reference is never replaced', /if \(reference \|\| !jeErr/.test(block));

console.log(`\nap accrual at intake: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
