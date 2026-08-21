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
// These three assertions had been RED since 2026-07-16 and nobody noticed,
// on the surface where being wrong means a bank rejection.
//
// They asserted the Unicode E-13B symbols (⑆ ⑈) and an unpadded serial. Both
// were corrected in July after NewFirst's live test: the bundled font maps the
// symbols to LETTERS (A = transit, C = on-us), and the serial is zero-padded to
// the bank's field width while the account prints as its real digits. The code
// was fixed against a real cleared check; the test was not updated, so it sat
// failing and was read as noise.
//
// Asserting the PROVEN format now, so a future change to the symbol mapping
// fails loudly instead of quietly reprinting July's bug.
check('MICR format — letters, not Unicode symbols (proven vs a cleared check)', () => {
  assert.strictEqual(formatMicr({ routing: '111000025', account: '1234567890', checkNumber: '1001' }),
    'C001001C A111000025A 1234567890C');
});
check('MICR strips non-digits', () => {
  assert.strictEqual(formatMicr({ routing: '11-1000-025', account: '1234 5678 90', checkNumber: '#1001' }),
    'C001001C A111000025A 1234567890C');
});
check('MICR pads the serial but never the account', () => {
  // A leading zero on the account changes it: the reader takes the digits
  // between the on-us symbols AS the account number, so 787385 != 0787385 and
  // the item does not post. An earlier pass zero-filled to 7 and failed to scan.
  const line = formatMicr({ routing: '113100091', account: '787385', checkNumber: '112', serialDigits: 6 });
  assert.strictEqual(line, 'C000112C A113100091A 787385C');
  assert.ok(!/A\s*0787385/.test(line), 'the account must never be zero-padded');
});
check('MICR line is exactly the width the geometry assumes', () => {
  // E-13B is 8 characters per inch, and .micr is positioned so its right edge
  // sits 1.9375in from the check's right edge, reserving the 12-position amount
  // field for the bank of first deposit. Character COUNT is therefore physical
  // width: 28 characters is exactly 3.5in. A format change that alters the
  // count moves where every field lands.
  const line = formatMicr({ routing: '113100091', account: '787385', checkNumber: '1001', serialDigits: 6 });
  assert.strictEqual(line.length, 28, 'MICR character count changed — re-check the geometry and re-test with the bank');
  assert.strictEqual(line.length * 0.125, 3.5, 'at 8 CPI this must be 3.5in');
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
  assert.ok(html.includes('A111000025A'), 'MICR routing bracketed by the transit symbol');
  // Geometry, not just content: these are what Wells Fargo rejected on 2026-08-21.
  assert.ok(/.micr {[^}]*font-size: 10pt/.test(html), 'MICR must render at 10pt (8 chars/inch for this font)');
  assert.ok(/.micr {[^}]*letter-spacing: 0/.test(html), 'letter-spacing must be 0 — the font advance IS the pitch');
  assert.ok(/.micr {[^}]*right: 1.9375in/.test(html), 'MICR must be positioned from the RIGHT edge, reserving the amount field');
  assert.ok(html.includes('NON-NEGOTIABLE'), 'draft watermark when not ready');
});
check('no watermark when ready_for_print', () => {
  const html = renderChecksHTML([{ check_number: '1', issue_date: '2026-06-21', amount_cents: 100, payee_name: 'X', invoices: [] }],
    { account_name: 'A', routing: '1', account_number: '2', ready_for_print: true });
  assert.ok(!html.includes('NON-NEGOTIABLE'), 'no watermark');
});

console.log(`\ncheck_renderer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
