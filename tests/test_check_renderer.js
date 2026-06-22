// Regression tests for the check renderer — a catastrophic-output surface.
// The amount-in-words line and MICR format are the parts that, if wrong, cause
// bank rejection or fraud. Run: node tests/test_check_renderer.js
const assert = require('assert');
const { amountToWords, formatMicr, renderChecksHTML } = require('../lib/accounting/check_renderer');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL:', name, '\n  ', e.message); } }

// --- amountToWords: the legal line ---
const words = [
  [47630, 'Four Hundred Seventy-Six and 30/100'],
  [0, 'Zero and 00/100'],
  [1, 'Zero and 01/100'],
  [100, 'One and 00/100'],
  [101, 'One and 01/100'],
  [99, 'Zero and 99/100'],
  [2000, 'Twenty and 00/100'],
  [100000, 'One Thousand and 00/100'],
  [1000000, 'Ten Thousand and 00/100'],
  [1500050, 'Fifteen Thousand and 50/100'],
  [111100, 'One Thousand One Hundred Eleven and 00/100'],
  [200000000, 'Two Million and 00/100'],
  [123456789, 'One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven and 89/100'],
  [10000000000, 'One Hundred Million and 00/100'],
];
for (const [cents, exp] of words) {
  check('amountToWords ' + cents, () => assert.strictEqual(amountToWords(cents), exp));
}
check('amountToWords rejects negative', () => { assert.throws(() => amountToWords(-1)); });

// --- MICR: structure + digit-stripping ---
check('MICR format', () => {
  assert.strictEqual(formatMicr({ routing: '111000025', account: '1234567890', checkNumber: '1001' }),
    '⑈1001⑈ ⑆111000025⑆ 1234567890⑈');
});
check('MICR strips non-digits', () => {
  assert.strictEqual(formatMicr({ routing: '11-1000-025', account: '1234 5678 90', checkNumber: '#1001' }),
    '⑈1001⑈ ⑆111000025⑆ 1234567890⑈');
});

// --- renderChecksHTML: critical fields present, draft watermark when not ready ---
check('render includes payee, amount, words, MICR', () => {
  const html = renderChecksHTML([{
    check_number: '1001', issue_date: '2026-06-21', amount_cents: 47630, memo: 'June',
    payee_name: 'GreenScape LLC', payee_address_lines: ['1 A St', 'Katy, TX'],
    invoices: [{ invoice_number: '4821', invoice_date: '2026-06-01', description: 'maint', amount_cents: 47630 }],
  }], { account_name: 'QR HOA', bank_name: 'Frost', routing: '111000025', account_number: '1234567890', ready_for_print: false });
  assert.ok(html.includes('GreenScape LLC'), 'payee');
  assert.ok(html.includes('$476.30'), 'numeric amount');
  assert.ok(html.includes('Four Hundred Seventy-Six and 30/100'), 'words');
  assert.ok(html.includes('⑆111000025⑆'), 'MICR routing');
  assert.ok(html.includes('NON-NEGOTIABLE'), 'draft watermark when not ready');
});
check('no watermark when ready_for_print', () => {
  const html = renderChecksHTML([{ check_number: '1', issue_date: '2026-06-21', amount_cents: 100, payee_name: 'X', invoices: [] }],
    { account_name: 'A', routing: '1', account_number: '2', ready_for_print: true });
  assert.ok(!html.includes('NON-NEGOTIABLE'), 'no watermark');
});

console.log(`\ncheck_renderer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
