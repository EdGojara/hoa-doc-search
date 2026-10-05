// tests/test_vantaca_ar_aging_detail_governs.js  (Issue #15, 2026-10-05)
// AR Aging: the account-level DETAIL governs; the report's printed summary line is
// source evidence. Canyon Gate's real 7/31/2026 AR Aging prints a summary line whose
// 0-30 and Over-90 totals disagree with its own detail by an equal and opposite amount,
// while the detail reconciles completely and the balance ties. SYNTHETIC text only.
// Proves:
//   1. detail-derived aging is unchanged (the printed summary never alters a row);
//   2. detail buckets add to each account balance and, in total, to total AR;
//   3. a printed-summary mismatch is preserved as evidence: detail vs printed, both amounts,
//      classified as a source-level control (not an extraction defect), still blocking;
//   4. Quail Ridge-shaped (consistent) reports are unchanged: every control PASSes;
//   5. a true detail mismatch still fails (account buckets vs balance; detail vs printed balance).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/onboarding/adapters/vantaca');
const C = require('../lib/onboarding/controls');

const AR = fs.readFileSync(path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca', 'ar_aging.txt'), 'utf8').split('\r\n').join('\n');
const ART = { sha256: 'd'.repeat(64) };
const parse = (t) => V.parse('ar_aging', t, ART);
const arControls = (p) => V.extractionControls({ ar_aging: p }).filter((c) => c.code.startsWith('ar_aging.'));
const ctl = (cs, code) => cs.find((c) => c.code === code);
const heads = (p) => p.rows.filter((r) => r.domain === 'ar_aging_account');
const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);
const B = ['current_cents', 'over_30_cents', 'over_60_cents', 'over_90_cents'];
// Replace one line, found by its leading text (after indentation), with fn(line). Plain string ops only.
const editLine = (text, start, fn) => text.split('\n').map((l) => (l.trimStart().startsWith(start) ? fn(l) : l)).join('\n');
const swap = (line, from, to) => { const i = line.indexOf(from); if (i < 0) throw new Error(`"${from}" not in line`); return line.slice(0, i) + to + line.slice(i + from.length); };
// Printed summary shifted 50.00 from Over 90 into 0-30; the balance still 510.00 (the Canyon Gate shape).
// The 0-30 cell prints "-" right-aligned; replace that dash (with the padding before it) by "$50.00".
const SHIFTED = editLine(AR, 'Total:', (l) => swap(swap(l, '      -', '$50.00'), '$200.00', '$150.00'));
const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('fixture edit applied (printed summary shifted, balance unchanged)', () => {
  assert.deepStrictEqual(parse(SHIFTED).printed.total, { current_cents: 5000, over_30_cents: 1000, over_60_cents: 30000, over_90_cents: 15000, balance_cents: 51000 });
});
// ---- 1 + 2: detail governs and reconciles
check('detail-derived aging is identical whatever the printed summary says (no row altered)', () => {
  assert.deepStrictEqual(parse(SHIFTED).rows, parse(AR).rows);
});
check('detail buckets add to each account balance, and in total to total AR (= printed Total balance)', () => {
  const h = heads(parse(SHIFTED));
  for (const a of h) assert.strictEqual(B.reduce((s, k) => s + a[k], 0), a.balance_cents, a.source_account_key);
  assert.strictEqual(B.reduce((s, k) => s + sum(h, k), 0), sum(h, 'balance_cents'));
  assert.strictEqual(sum(h, 'balance_cents'), parse(SHIFTED).printed.total.balance_cents);
  const cs = arControls(parse(SHIFTED));
  for (const code of ['ar_aging.no_unreadable_lines', 'ar_aging.items_tie_to_account_totals', 'ar_aging.account_buckets_add_to_balance', 'ar_aging.accounts_tie_to_printed_total.balance']) assert.strictEqual(ctl(cs, code).status, 'PASS', code);
});
// ---- 3: printed summary mismatch preserved as evidence, source level, still blocking
check('printed-summary mismatch is preserved: detail vs printed amounts on the control, classified source-level, and it stays blocking (FAIL)', () => {
  const cs = arControls(parse(SHIFTED));
  const cur = ctl(cs, 'ar_aging.accounts_tie_to_printed_total.current'); const o90 = ctl(cs, 'ar_aging.accounts_tie_to_printed_total.over_90');
  assert.deepStrictEqual([cur.status, cur.level, cur.left_cents, cur.right_cents, cur.difference_cents], ['FAIL', C.LEVEL.SOURCE, 0, 5000, -5000]);
  assert.deepStrictEqual([o90.status, o90.level, o90.left_cents, o90.right_cents, o90.difference_cents], ['FAIL', C.LEVEL.SOURCE, 20000, 15000, 5000]);
  assert.deepStrictEqual([cur.left_label, cur.right_label], ['account detail (governs)', 'Vantaca printed summary']);
  assert.match(cur.label, /the account detail governs/);
  for (const k of ['over_30', 'over_60']) assert.strictEqual(ctl(cs, `ar_aging.accounts_tie_to_printed_total.${k}`).status, 'PASS');
});
check('the printed summary itself is kept on the parse output as source evidence', () => {
  assert.strictEqual(parse(SHIFTED).printed.total.over_90_cents, 15000);
  assert.strictEqual(parse(SHIFTED).printed.total.current_cents, 5000);
});
// ---- 4: consistent reports unchanged
check('a consistent report (the Quail Ridge shape): every AR control PASSes, the same codes as before plus the new detail check', () => {
  const cs = arControls(parse(AR));
  assert.ok(cs.every((c) => c.status === 'PASS'), JSON.stringify(cs.filter((c) => c.status !== 'PASS')));
  assert.deepStrictEqual(cs.map((c) => c.code), ['ar_aging.no_unreadable_lines', 'ar_aging.items_tie_to_account_totals', 'ar_aging.account_buckets_add_to_balance',
    'ar_aging.accounts_tie_to_printed_total.current', 'ar_aging.accounts_tie_to_printed_total.over_30', 'ar_aging.accounts_tie_to_printed_total.over_60',
    'ar_aging.accounts_tie_to_printed_total.over_90', 'ar_aging.accounts_tie_to_printed_total.balance']);
});
check('the balance tie stays an extraction-level control (a misread total is a reader defect)', () => {
  assert.strictEqual(ctl(arControls(parse(AR)), 'ar_aging.accounts_tie_to_printed_total.balance').level, C.LEVEL.EXTRACTION);
});
// ---- 5: true detail mismatches still fail
check('an account whose buckets do not add to its balance FAILs account_buckets_add_to_balance', () => {
  // account 90000002: Over 60 printed as 290.00 on its account line and on its charge line; balance still 300.00
  const L = AR.split('\n'); const i = L.findIndex((l) => l.startsWith('90000002'));
  L[i + 1] = swap(L[i + 1], '$300.00 ', '$290.00 '); L[i + 2] = swap(L[i + 2], '$300.00 ', '$290.00 ');
  const c = ctl(arControls(parse(L.join('\n'))), 'ar_aging.account_buckets_add_to_balance');
  assert.strictEqual(c.status, 'FAIL');
  assert.deepStrictEqual(c.failures, [{ account: '90000002', buckets_cents: 29000, balance_cents: 30000 }]);
});
check('detail that does not add to the printed Total balance FAILs the (extraction) balance tie', () => {
  const bad = editLine(AR, 'Total:', (l) => swap(l, '$510.00', '$520.00'));
  const c = ctl(arControls(parse(bad)), 'ar_aging.accounts_tie_to_printed_total.balance');
  assert.deepStrictEqual([c.status, c.level], ['FAIL', C.LEVEL.EXTRACTION]);
});
check('a charge line that disagrees with its account FAILs items_tie_to_account_totals', () => {
  // the charge line under account 90000001 (not the "Late Fees (1)" line in the report's summary section)
  const L = AR.split('\n'); const i = L.findIndex((l, n) => n > L.findIndex((x) => x.startsWith('90000001')) && l.trimStart().startsWith('Late Fees'));
  L[i] = swap(swap(L[i], '$10.00', '$12.00'), '$10.00', '$12.00');
  const bad = L.join('\n');
  assert.strictEqual(ctl(arControls(parse(bad)), 'ar_aging.items_tie_to_account_totals').status, 'FAIL');
});

let pass = 0, fail = 0;
for (const [n, fn] of tests) {
  try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
