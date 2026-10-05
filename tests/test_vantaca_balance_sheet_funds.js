// tests/test_vantaca_balance_sheet_funds.js  (Issue #15, 2026-10-05)
// Vantaca prints the Balance Sheet in two layouts. Quail Ridge's single-column
// "Balance Sheet For <date>" was the only one the adapter read; Canyon Gate's (and
// LOPF's) fund-column "Balance Sheet as of <date>" was rejected at upload as "not a
// report Trusted recognizes yet". This proves, on SYNTHETIC fixtures only (the real
// packages hold association financials and the repo is public):
//   1. the single-column layout recognizes and parses exactly as before;
//   2. the fund-column layout recognizes (content, not filename);
//   3. every fund column is kept separately, with Total, and character-span provenance;
//   4. fund columns add to Total (per line) and each fund's lines tie to its printed totals;
//   5. malformed fund-column layouts fail (defect / control FAIL) instead of guessing.
// The real Canyon Gate file is proved by tests/onboarding_canyon_gate_bs_local.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/onboarding/adapters/vantaca');
const { sourceControls } = require('../lib/onboarding/source_controls');

const FIX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const SINGLE = fs.readFileSync(path.join(FIX, 'balance_sheet.txt'), 'utf8');
const FUNDS = fs.readFileSync(path.join(FIX, 'balance_sheet_funds.txt'), 'utf8');
const ART = { sha256: 'a'.repeat(64) };
const parse = (text) => V.parse('balance_sheet', text, ART);
const controls = (bs) => V.extractionControls({ balance_sheet: bs });
const status = (cs, code) => (cs.find((c) => c.code === code) || {}).status;
const row = (bs, code) => bs.rows.find((r) => r.account_code === code);
const funds = (r) => Object.fromEntries(r.fund_amounts.map((f) => [f.fund, f.amount_cents]));
// Change one line of the fixture (matched by its leading text) to build a malformed variant.
const edit = (text, startsWith, fn) => text.split('\n').map((l) => (l.trimStart().startsWith(startsWith) ? fn(l) : l)).join('\n');
const tests = []; const check = (n, fn) => tests.push([n, fn]);

// ---- 1. single-column layout: unchanged
check('single column: recognized as balance_sheet dated 3/31/2026 (as before)', () => {
  assert.deepStrictEqual(V.identify(SINGLE), { type: 'balance_sheet', as_of: '2026-03-31', period_start: null });
});
check('single column: same rows, same printed totals, no fund fields, no new keys', () => {
  const bs = parse(SINGLE);
  assert.deepStrictEqual(Object.keys(bs.printed), ['totals']);
  assert.deepStrictEqual(bs.defects, []);
  assert.deepStrictEqual(bs.rows.map((r) => [r.section, r.account_code, r.amount_cents]),
    [['assets', '1000', 143500], ['assets', '1100', 200073], ['assets', '1300', 51000], ['liabilities', '2400', 8500], ['equity', '3000', 386073]]);
  assert.ok(bs.rows.every((r) => r.fund_amounts === undefined && Object.keys(r.provenance.locator).join() === 'line'));
});
check('single column: the same four extraction controls, all PASS (no fund controls added)', () => {
  const cs = controls(parse(SINGLE));
  assert.deepStrictEqual(cs.map((c) => [c.code, c.status]), [['balance_sheet.no_unreadable_lines', 'PASS'], ['balance_sheet.asset_lines_tie', 'PASS'], ['balance_sheet.liability_lines_tie', 'PASS'], ['balance_sheet.equity_lines_tie', 'PASS']]);
});

// ---- 2. fund-column layout recognizes
check('fund columns: recognized from content as balance_sheet as of 3/31/2026, and dated at that cutoff', () => {
  const id = V.identify(FUNDS);
  assert.deepStrictEqual(id, { type: 'balance_sheet', as_of: '2026-03-31', period_start: null });
  assert.strictEqual(V.cutoffCheck(id, '2026-03-31').ok, true);
});

// ---- 3. fund columns preserved, with Total and provenance
check('fund columns: every account line read, no defects, columns named from the report header', () => {
  const bs = parse(FUNDS);
  assert.deepStrictEqual(bs.defects, []);
  assert.strictEqual(bs.as_of, '2026-03-31');
  assert.deepStrictEqual(bs.printed.fund_columns, ['Operating', 'Reserve', 'Adopt a School']);
  assert.deepStrictEqual(bs.rows.map((r) => r.account_code), ['1000', '1200', '1250', '1201', '1300', '1305', '2000', '2002', '2400', '3000', '3020', '3030', '3050']);
  assert.deepStrictEqual(bs.rows.map((r) => r.section), ['assets', 'assets', 'assets', 'assets', 'assets', 'assets', 'liabilities', 'liabilities', 'liabilities', 'equity', 'equity', 'equity', 'equity']);
});
check('fund columns: a split cash account keeps both funds (Operating negative, Adopt a School positive) and its Total', () => {
  const r = row(parse(FUNDS), '1250');
  assert.deepStrictEqual(funds(r), { Operating: -125000, 'Adopt a School': 300000 });
  assert.strictEqual(r.amount_cents, 175000);
});
check('fund columns: a three-way fund balance keeps all three funds and its Total', () => {
  const r = row(parse(FUNDS), '3050');
  assert.deepStrictEqual(funds(r), { Operating: 3150025, Reserve: 300000, 'Adopt a School': -25000 });
  assert.strictEqual(r.amount_cents, 3425025);
});
check('fund columns: single-fund lines carry only their own fund (blank cells are not invented)', () => {
  const bs = parse(FUNDS);
  assert.deepStrictEqual(funds(row(bs, '1201')), { Reserve: 25000000 });
  assert.deepStrictEqual(funds(row(bs, '2002')), { 'Adopt a School': 50000 });
});
check('fund columns: provenance names each column\'s character span, and each span is exactly the printed amount', () => {
  for (const r of parse(FUNDS).rows) {
    const cols = r.provenance.locator.columns;
    assert.ok(cols.Total, `${r.account_code} has a Total span`);
    for (const [col, [a, b]] of Object.entries(cols)) {
      const printed = r.provenance.raw.slice(a, b);
      const expect = col === 'Total' ? r.amount_cents : r.fund_amounts.find((f) => f.fund === col).amount_cents;
      assert.strictEqual(require('../lib/onboarding/money').parseCents(printed), expect, `${r.account_code} ${col}: span reads ${printed}`);
    }
  }
});
check('fund columns: printed totals kept per fund and in Total', () => {
  const bs = parse(FUNDS);
  assert.strictEqual(bs.printed.totals['total assets'], 30535075);
  assert.deepStrictEqual(bs.printed.fund_totals['total assets'], { Operating: 5025025, Reserve: 25210050, 'Adopt a School': 300000 });
  assert.deepStrictEqual(bs.printed.fund_totals['total liabilities'], { Operating: 375000, 'Adopt a School': 50000 });
});

// ---- 4. ties
check('fund columns: every extraction control PASSes (section ties, fund columns add to Total, each fund\'s lines tie)', () => {
  const cs = controls(parse(FUNDS));
  assert.ok(cs.length === 14 && cs.every((c) => c.status === 'PASS'), JSON.stringify(cs.filter((c) => c.status !== 'PASS')));
  assert.strictEqual(status(cs, 'balance_sheet.fund_columns_add_to_total'), 'PASS');
  assert.strictEqual(status(cs, 'balance_sheet.fund_lines_tie.adopt_a_school.equity'), 'PASS');
});
check('fund columns: the provider-agnostic source control (assets = liabilities + equity) PASSes on the Total column', () => {
  const sc = sourceControls({ balance_sheet: parse(FUNDS) });
  assert.strictEqual(status(sc, 'balance_sheet.assets_equal_liabilities_plus_equity'), 'PASS');
});

// ---- 5. malformed layouts fail, never guess
check('malformed: an amount printed between two columns is a defect; the line is not emitted and the ties FAIL', () => {
  // Reserve's header ends at column 89 and Adopt a School's at 110; this amount now ends at 100,
  // about halfway between them, so it belongs to neither.
  const bad = edit(FUNDS, '1200 - Reserve Cash Account', (l) => l.replace('$2,100.50           ', '           $2,100.50'));
  const bs = parse(bad);
  assert.ok(bs.defects.some((d) => d.code === 'BS_AMOUNT_COLUMN_AMBIGUOUS'), JSON.stringify(bs.defects));
  assert.strictEqual(row(bs, '1200'), undefined);
  const cs = controls(bs);
  assert.strictEqual(status(cs, 'balance_sheet.no_unreadable_lines'), 'FAIL');
  assert.strictEqual(status(cs, 'balance_sheet.asset_lines_tie'), 'FAIL');
});
check('malformed: a line with no Total column amount is a defect, not a line with an inferred Total', () => {
  const bad = edit(FUNDS, '1000 - Operating Cash Account', (l) => l.replace(/\$41,500\.25\s*$/, ''));
  const bs = parse(bad);
  assert.ok(bs.defects.some((d) => d.code === 'BS_TOTAL_COLUMN_MISSING'));
  assert.strictEqual(row(bs, '1000'), undefined);
});
check('malformed: two amounts under one column header is a defect', () => {
  const bad = edit(FUNDS, '2400 - Prepaid Owners Assessments', (l) => l.replace('    $750.00', '$1.00 $750.00'));
  const bs = parse(bad);
  assert.ok(bs.defects.some((d) => d.code === 'BS_TWO_AMOUNTS_IN_ONE_COLUMN'), JSON.stringify(bs.defects));
  assert.strictEqual(row(bs, '2400'), undefined);
});
check('malformed: fund columns that do not add to the printed Total FAIL fund_columns_add_to_total (no plug)', () => {
  const bad = edit(FUNDS, '1300 - Accounts Receivable', (l) => l.replace('$12,000.00   ', '$12,500.00   '));
  const bs = parse(bad);
  assert.deepStrictEqual(bs.defects, []);
  assert.strictEqual(row(bs, '1300').amount_cents, 1200000, 'Total is the printed Total, not the fund sum');
  const cs = controls(bs);
  const c = cs.find((x) => x.code === 'balance_sheet.fund_columns_add_to_total');
  assert.strictEqual(c.status, 'FAIL');
  assert.deepStrictEqual(c.failures, [{ account: '1300', funds_cents: 1250000, total_cents: 1200000 }]);
});
check('malformed: an amount under the wrong fund (Total still right) FAILs that fund\'s tie', () => {
  // 1000's Operating amount moved under Reserve; the line still adds to its Total.
  const bad = edit(FUNDS, '1000 - Operating Cash Account', (l) => l.replace('$41,500.25                      ', '                      $41,500.25'));
  const cs = controls(parse(bad));
  assert.strictEqual(status(cs, 'balance_sheet.fund_columns_add_to_total'), 'PASS');
  assert.strictEqual(status(cs, 'balance_sheet.fund_lines_tie.operating.assets'), 'FAIL');
  assert.strictEqual(status(cs, 'balance_sheet.fund_lines_tie.reserve.assets'), 'FAIL');
});
check('malformed: a fund-column header with no Total column is unreadable; its lines become defects', () => {
  const bad = edit(FUNDS, 'Assets ', (l) => l.replace(/\s+Total\s*$/, ''));
  const bs = parse(bad);
  assert.ok(bs.defects.some((d) => d.code === 'BS_COLUMN_HEADER_UNREADABLE'));
  assert.strictEqual(status(controls(bs), 'balance_sheet.no_unreadable_lines'), 'FAIL');
});
check('malformed: fund columns that change between pages are a defect', () => {
  const bad = edit(FUNDS, 'Liabilities / Equity', (l) => l.replace('Adopt a School', '       Savings'));
  const bs = parse(bad);
  assert.ok(bs.defects.some((d) => d.code === 'BS_FUND_COLUMNS_CHANGE'));
  assert.strictEqual(status(controls(bs), 'balance_sheet.no_unreadable_lines'), 'FAIL');
});

let pass = 0, fail = 0;
for (const [n, fn] of tests) {
  try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
