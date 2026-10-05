// tests/test_vantaca_ap_gl_layouts.js  (Issue #15, 2026-10-05)
// Two Vantaca layouts the adapter misread on Canyon Gate's real 7/31/2026 package
// (normalize FAIL, 7 controls). SYNTHETIC text only: the repo is public, real vendor
// and homeowner figures are never committed. The real files are proved by
// tests/onboarding_cg_normalize_local.js.
//   AP Aging: open items WITHOUT "Inv #" (utility bills) print their five amounts on the
//     same line; items WITH "Inv #" print them on the line directly below. The parser
//     only knew "Inv #" items and paired items with amount lines by counting through the
//     report, so the bills without a number were dropped (and any interleaving would have
//     shifted every amount after it).
//   GL Trial Balance: an 8-digit account ("20000000 - TEST - AP") was not recognized as an
//     account header (3-6 digits only), so its lines were added to the account above it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/onboarding/adapters/vantaca');

const ART = { sha256: 'b'.repeat(64) };
const ap = (text) => V.parse('ap_aging', text, ART);
const controls = (parsed) => V.extractionControls(parsed);
const status = (cs, code) => (cs.find((c) => c.code === code) || {}).status;
const pad = (s, n) => s + ' '.repeat(Math.max(1, n - s.length));
const amounts = (a) => a.map((x) => x.padStart(14)).join('  ');
// An AP aging page in Vantaca's layout. Items: { head, amounts, sameLine, tail }.
function apReport(items, totalAmounts, { title = 'AP Aging for Ending Date: 3/31/2026', extra = [] } = {}) {
  const out = ['                               Example Creek Homeowners Association, Inc', '', '                                            ' + title, '',
    '     Provider                                                                Current      Over 30       Over 60       Over 90            Total', ''];
  for (const it of items) {
    if (it.sameLine) out.push(pad('     ' + it.head, 78) + amounts(it.amounts));
    else { out.push('     ' + it.head); out.push(' '.repeat(70) + amounts(it.amounts)); if (it.tail) out.push('     ' + it.tail); }
    out.push('');
  }
  out.push(...extra);
  if (totalAmounts) out.push(pad('                                                                  Total', 72) + amounts(totalAmounts));
  out.push('', '     Report generated on 4/1/2026 9:00 AM - V3.1                                                                                       Page 1');
  return out.join('\n');
}
const INV1 = { head: 'EXAMPLE MANAGEMENT LLC Inv # EX-101 on 2/28/2026 -', amounts: ['0.00', '11.70', '0.00', '0.00', '11.70'], tail: 'Postage - Postage' };
const INV2 = { head: 'EXAMPLE MANAGEMENT LLC Inv # EX-102 on 3/1/2026 -', amounts: ['550.00', '0.00', '0.00', '0.00', '550.00'], tail: 'Monthly Management Fees - Management Fees' };
const BILL = { head: 'EXAMPLE WATER DISTRICT on 12/17/2025 - 11/10/25 12/09/25 - Water', amounts: ['0.00', '0.00', '0.00', '37.18', '37.18'], sameLine: true };
const BILL2 = { head: 'EXAMPLE POWER CO on 1/4/2026 - 11/13/25 12/14/25 - Electricity - Total', amounts: ['0.00', '0.00', '78.43', '0.00', '78.43'], sameLine: true };
const tests = []; const check = (n, fn) => tests.push([n, fn]);

// ---- AP: the "Inv #" layout reads as before
check('AP: "Inv #" items with amounts on the following line read exactly as before (the Quail Ridge shape)', () => {
  const p = ap(apReport([INV1, INV2], ['550.00', '11.70', '0.00', '0.00', '561.70']));
  assert.deepStrictEqual(p.defects, []);
  assert.deepStrictEqual(p.rows.map((r) => [r.source_vendor_key, r.invoice_number, r.invoice_date, r.amount_cents, r.over_30_cents]),
    [['EXAMPLE MANAGEMENT LLC', 'EX-101', '2026-02-28', 1170, 1170], ['EXAMPLE MANAGEMENT LLC', 'EX-102', '2026-03-01', 55000, 0]]);
  assert.deepStrictEqual(p.rows.map((r) => r.provenance.locator), [{ line: 7, amount_line: 8 }, { line: 11, amount_line: 12 }]);
  assert.deepStrictEqual(p.printed.total, { current_cents: 55000, over_30_cents: 1170, over_60_cents: 0, over_90_cents: 0, balance_cents: 56170 });
  assert.ok(controls({ ap_aging: p }).every((c) => c.status === 'PASS'));
});
// ---- AP: bills without an invoice number
check('AP: an item WITHOUT "Inv #" is read, with invoice number null, from its same-line amounts', () => {
  const p = ap(apReport([BILL], ['0.00', '0.00', '0.00', '37.18', '37.18']));
  assert.deepStrictEqual(p.defects, []);
  assert.strictEqual(p.rows.length, 1);
  const r = p.rows[0];
  assert.deepStrictEqual([r.source_vendor_key, r.invoice_number, r.invoice_date, r.over_90_cents, r.amount_cents], ['EXAMPLE WATER DISTRICT', null, '2025-12-17', 3718, 3718]);
  assert.strictEqual(r.provenance.locator.line, r.provenance.locator.amount_line, 'same-line item: header and amounts are one line');
  assert.ok(!r.provenance.raw.includes('\n'));
});
check('AP: items with and without "Inv #", interleaved, each keep their OWN amounts (position, not counting)', () => {
  const p = ap(apReport([INV1, BILL, INV2, BILL2], ['550.00', '11.70', '78.43', '37.18', '677.31']));
  assert.deepStrictEqual(p.defects, []);
  assert.deepStrictEqual(p.rows.map((r) => [r.invoice_number, r.amount_cents]), [['EX-101', 1170], [null, 3718], ['EX-102', 55000], [null, 7843]]);
  const cs = controls({ ap_aging: p });
  assert.ok(cs.every((c) => c.status === 'PASS'), JSON.stringify(cs.filter((c) => c.status !== 'PASS')));
});
check('AP: the printed Total line is the report total (not the last amount line by position)', () => {
  const p = ap(apReport([BILL, INV1], ['0.00', '11.70', '0.00', '37.18', '48.88']));
  assert.deepStrictEqual(p.printed.total, { current_cents: 0, over_30_cents: 1170, over_60_cents: 0, over_90_cents: 3718, balance_cents: 4888 });
});
check('AP: dropping a no-invoice bill from the Total makes the tie FAIL (the Total stays authoritative)', () => {
  const p = ap(apReport([INV1, BILL], ['0.00', '11.70', '0.00', '0.00', '11.70']));
  assert.strictEqual(status(controls({ ap_aging: p }), 'ap_aging.items_tie_to_printed_total.balance'), 'FAIL');
});
// ---- AP: fail safe
check('AP: an amount line that belongs to no item is a defect and is not counted', () => {
  const p = ap(apReport([INV1], ['0.00', '11.70', '0.00', '0.00', '11.70'], { extra: [' '.repeat(70) + amounts(['5.00', '0.00', '0.00', '0.00', '5.00']), ''] }));
  assert.ok(p.defects.some((d) => d.code === 'AP_AGING_AMOUNT_LINE_UNATTACHED'), JSON.stringify(p.defects));
  assert.strictEqual(p.rows.length, 1);
  assert.strictEqual(status(controls({ ap_aging: p }), 'ap_aging.no_unreadable_lines'), 'FAIL');
});
check('AP: amounts separated from their item by a blank line are NOT attached (unattached line + item without amounts)', () => {
  const text = apReport([INV1], ['0.00', '11.70', '0.00', '0.00', '11.70']).replace(INV1.head + '\n', INV1.head + '\n\n');
  const p = ap(text);
  assert.deepStrictEqual(p.defects.map((d) => d.code).sort(), ['AP_AGING_AMOUNT_LINE_UNATTACHED', 'AP_AGING_ITEM_WITHOUT_AMOUNTS']);
  assert.strictEqual(p.rows.length, 0);
});
check('AP: an item with no amount line at all is a defect', () => {
  const text = apReport([INV1, INV2], ['550.00', '11.70', '0.00', '0.00', '561.70']).split('\n').filter((l, i) => i !== 11).join('\n');   // drop INV2's amount line
  const p = ap(text);
  assert.ok(p.defects.some((d) => d.code === 'AP_AGING_ITEM_WITHOUT_AMOUNTS'), JSON.stringify(p.defects));
  assert.strictEqual(p.rows.length, 1);
});
check('AP: a report with no Total line is a defect and the tie controls are BLOCKED, not passed', () => {
  const p = ap(apReport([INV1], null));
  assert.ok(p.defects.some((d) => d.code === 'AP_AGING_TOTAL_NOT_FOUND'));
  assert.strictEqual(p.printed.total, null);
  assert.strictEqual(status(controls({ ap_aging: p }), 'ap_aging.items_tie_to_printed_total.balance'), 'BLOCKED');
});

// ---- AP: the offset (pdftotext) shape keeps the original in-order reader
check('AP offset shape (bare "Total" label, amounts drifting a line up): in-order pairing as before, and a no-"Inv #" item counts', () => {
  const OFFSET = [
    '          AP Aging for Ending Date: 3/31/2026', '',
    'Provider                                                                            Current      Over 30      Over 60       Over 90         Total', '',
    'EXAMPLE LANDSCAPING LLC Inv # EX-0002 on 3/01/2026 -                                       0.00        60.00          0.00          0.00      60.00',
    'Monthly - Landscaping                                                                     25.00         0.00          0.00          0.00      25.00',
    'EXAMPLE POSTAGE LLC Inv # P-77 on 3/20/2026 -                                              0.00         0.00          0.00         37.18      37.18',
    'Postage - Postage',
    'EXAMPLE WATER DISTRICT on 12/17/2025 - 11/10/25 12/09/25 - Water                          25.00        60.00          0.00         37.18     122.18',
    '', '                                                                             Total'].join('\n');
  const p = ap(OFFSET);
  assert.deepStrictEqual(p.defects, []);
  assert.deepStrictEqual(p.rows.map((r) => [r.invoice_number, r.amount_cents]), [['EX-0002', 6000], ['P-77', 2500], [null, 3718]]);
  assert.strictEqual(p.printed.total.balance_cents, 12218);
  const short = ap(OFFSET.replace('EXAMPLE WATER DISTRICT on 12/17/2025 - 11/10/25 12/09/25 - Water', 'EXAMPLE WATER DISTRICT (no date)'));
  assert.ok(short.defects.some((d) => d.code === 'AP_AGING_ROW_COUNT_MISMATCH'), 'n items need exactly n + 1 amount rows');
});

// ---- GL: account codes longer than 6 digits
const FIX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const GL = fs.readFileSync(path.join(FIX, 'gl_trial_balance.txt'), 'utf8');
// An 8-digit account that nets to zero, placed directly after account 1000's lines (where the
// old pattern would have handed its two lines to 1000).
const LONG = ['', '10000000 - TEST - Clearing                                                              0.00        25.00             25.00                  0.00',
  '  Date           Ledger ID Description                                                             Debit               Credit             Type',
  '  03/15/2026                    TEST#1 - Test Vendor - TEST                                       25.00                   -         Invoice',
  '  03/15/2026                    TEST#1 - Test Vendor - TEST                                           -               25.00         Invoice'].join('\n');
const GL_LONG = GL.replace(/(  03\/01\/2026[^\n]*\n)/, `$1${LONG}\n`);
check('GL: an 8-digit account is its own account, with its own lines and printed totals', () => {
  assert.notStrictEqual(GL_LONG, GL, 'fixture edit applied');
  const p = V.parse('gl_trial_balance', GL_LONG, ART);
  assert.deepStrictEqual(p.defects, []);
  const acct = p.printed.accounts.find((a) => a.account_code === '10000000');
  assert.deepStrictEqual(acct && [acct.account_name, acct.beginning_cents, acct.debit_cents, acct.credit_cents, acct.ending_cents], ['TEST - Clearing', 0, 2500, 2500, 0]);
  assert.strictEqual(p.rows.filter((r) => r.domain === 'gl_transaction' && r.account_code === '10000000').length, 2);
});
check('GL: the account above it keeps only its own lines (no contamination); every GL control PASSes', () => {
  const p = V.parse('gl_trial_balance', GL_LONG, ART);
  const base = V.parse('gl_trial_balance', GL, ART);
  const lines1000 = (x) => x.rows.filter((r) => r.domain === 'gl_transaction' && r.account_code === '1000').length;
  assert.strictEqual(lines1000(p), lines1000(base));
  const cs = controls({ gl_trial_balance: p });
  assert.ok(cs.every((c) => c.status === 'PASS'), JSON.stringify(cs.filter((c) => c.status !== 'PASS')));
});
check('GL: the committed synthetic GL (4-digit accounts only) parses exactly as before', () => {
  const p = V.parse('gl_trial_balance', GL, ART);
  assert.deepStrictEqual(p.printed.accounts.map((a) => a.account_code), ['1000', '1100', '1300', '2400', '3000', '4000', '4030', '4100', '5200']);
  assert.ok(controls({ gl_trial_balance: p }).every((c) => c.status === 'PASS'));
});

let pass = 0, fail = 0;
for (const [n, fn] of tests) {
  try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
