// Check remittance layout (Ed 2026-11-16): each physical page has fixed, clipped regions for the
// check, the vendor remittance and the payer copy; a long invoice list continues on a VOID
// remittance continuation page, never into the next check.
// Scar: Waterview check #1040 (7 RMWBH invoices) ran past its stub and printed over check #1041.
'use strict';
const assert = require('assert');
const { renderChecksHTML, STUB_ROWS, CONT_ROWS } = require('../lib/accounting/check_renderer');
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + e.message); } };

const cfg = { account_name: 'WV HOA', bank_name: 'NewFirst', routing: '113104796', account_number: '765961', ready_for_print: false };
const inv = (n) => Array.from({ length: n }, (_, i) => ({ invoice_number: 'PS-INV35' + String(i).padStart(4, '0'), invoice_date: '2026-09-28',
  description: 'MCS2 - Received phone call from Celina as to resale request and reviewed the account ledger and history '.repeat(2), amount_cents: 100 + i }));
const mk = (n) => ({ check_number: '1040', issue_date: '2026-11-04', amount_cents: 999999, payee_name: 'RMWBH', payee_address_lines: ['PO Box 1'], invoices: inv(n) });
const pages = (html) => (html.match(/<div class="page/g) || []).length;

check('every region of a check page is fixed and clipped (3.5 + 3.75 + 3.75 = 11in)', () => {
  const html = renderChecksHTML([mk(3)], cfg);
  assert.ok(/\.page {[^}]*overflow: hidden/.test(html), 'page');
  assert.ok(/\.check {[^}]*height: 3\.5in;[^}]*overflow: hidden/.test(html), 'check region');
  assert.ok(/\.stub {[^}]*height: 3\.75in;[^}]*overflow: hidden/.test(html), 'remittance regions');
  assert.ok(/table\.inv td {[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/.test(html), 'rows are one line');
});
check('dates are compact MM/DD/YYYY and descriptions are clipped', () => {
  const html = renderChecksHTML([mk(1)], cfg);
  assert.ok(html.includes('09/28/2026'));
  assert.ok(!html.includes('September 28, 2026</td>'));
  assert.ok(html.includes('…</td>'), 'long description ends with an ellipsis');
});
check('check #1040 (7 invoices) fits on its own page: no continuation page', () => {
  assert.ok(STUB_ROWS >= 7);
  assert.strictEqual(pages(renderChecksHTML([mk(7)], cfg)), 1);
});
check('more invoices than fit: both stubs say so and show the full total; one VOID continuation page lists every invoice, with no MICR', () => {
  const n = STUB_ROWS + 5; const html = renderChecksHTML([mk(n)], cfg);
  assert.strictEqual(pages(html), 2);
  assert.strictEqual((html.match(/more invoices &mdash;/g) || []).length, 2, 'both stubs');
  assert.ok(html.includes('VOID &mdash; NOT A CHECK'));
  assert.strictEqual((html.match(new RegExp('Total paid \\(' + n + ' invoices\\)', 'g')) || []).length, 2);
  const cont = html.slice(html.indexOf('class="page cont"'));
  assert.strictEqual((cont.match(/<tr><td class="c-inv">/g) || []).length, n, 'every invoice on the continuation');
  assert.ok(!/class="micr"/.test(cont), 'no MICR line on a continuation page');
});
check('a very long list spreads over several continuation pages, each held to CONT_ROWS', () => {
  const html = renderChecksHTML([mk(CONT_ROWS * 2 + 1)], cfg);
  assert.strictEqual(pages(html), 4);
});
check('continuation pages follow their own check, before the next check', () => {
  const html = renderChecksHTML([mk(STUB_ROWS + 1), { ...mk(1), check_number: '1041', payee_name: 'Superior LawnCare' }], cfg);
  const i1040cont = html.indexOf('Remittance continuation for check #1040'), i1041 = html.indexOf('Superior LawnCare');
  assert.ok(i1040cont > 0 && i1040cont < i1041);
});
check('the check itself is identical whatever the invoice count: amount, payee, number, MICR', () => {
  const top = (h) => h.slice(h.indexOf('<div class="check">'), h.indexOf('<div class="stub">'));
  assert.strictEqual(top(renderChecksHTML([mk(1)], cfg)), top(renderChecksHTML([mk(40)], cfg)));
});

console.log(`\ncheck remittance layout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
