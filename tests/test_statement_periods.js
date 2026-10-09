// tests/test_statement_periods.js  (Ed 2026-10-09, month-end close PR B)
// ----------------------------------------------------------------------------
// Cutover-safe statement numbers. A converted community's opening entry
// (source_module 'opening_entry', dated the 7/31 cutoff) carries Jan-Jul revenue
// and expense as one lump. Before this, every period statement treated that lump
// as JULY activity. Runs the REAL statement functions (income statement, budget
// vs actual, rolling 12, printed by-fund statement, balance sheet, budget plan
// monthly actuals) against an in-memory ledger:
//   Canyon Gate  converted 7/31: July monthly not available (never Jan-Jul as
//                July), Aug = Aug, Sep = Sep, Sep YTD = carryforward + Aug + Sep.
//   LOPF         same cutover; its broken history stays visible (statements
//                never "fix" books by presentation).
//   Greenfield   no conversion: monthly / YTD exactly as before.
// Plus the favorable-positive variance convention (lib/accounting/variance.js).
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');

// ---------------------------------------------------------------- fake ledger
let db;
const get = (row, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
function enrich(table, r) {
  if (table !== 'journal_entry_lines') return r;
  return { ...r, journal_entries: db.journal_entries.find((j) => j.id === r.journal_entry_id) || null };
}
function fakeClient() {
  return {
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not in fake' } }),
    from(table) {
      const st = { f: [], order: null, range: null, limit: null, head: false };
      const rows = () => {
        let out = (db[table] || []).map((r) => enrich(table, r)).filter((r) => st.f.every((fn) => fn(r)));
        if (table === 'journal_entry_lines') out = out.filter((r) => r.journal_entries);
        if (st.order) out.sort((a, b) => (a[st.order] > b[st.order] ? 1 : a[st.order] < b[st.order] ? -1 : 0));
        if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
        if (st.limit != null) out = out.slice(0, st.limit);
        return out;
      };
      const q = {
        select(_c, o) { if (o && o.head) st.head = true; return q; },
        eq(c, v) { st.f.push((r) => get(r, c) === v); return q; },
        in(c, vs) { st.f.push((r) => vs.includes(get(r, c))); return q; },
        gte(c, v) { st.f.push((r) => get(r, c) >= v); return q; },
        lte(c, v) { st.f.push((r) => get(r, c) <= v); return q; },
        order(c) { st.order = c; return q; },
        range(a, b) { st.range = [a, b]; return q; },
        limit(n) { st.limit = n; return q; },
        neq() { return q; }, not() { return q; }, is() { return q; },
        async maybeSingle() { const r = rows(); return { data: r[0] || null, error: null }; },
        async single() { const r = rows(); return r.length ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } }; },
        then(res, rej) { const r = rows(); return Promise.resolve(st.head ? { data: null, count: r.length, error: null } : { data: r, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  return realLoad.apply(this, arguments);
};
const FS = require('../lib/accounting/financial_statements');
const SP = require('../lib/accounting/statement_periods');
const { monthlyActualsByAccount } = require('../lib/accounting/budget_plan_data');
const { phase } = require('../lib/accounting/budget_phasing');
const { groupStatementRows } = require('../lib/accounting/report_categories');
Module._load = realLoad;

// ---------------------------------------------------------------- fixtures
let seq = 0;
const A = (cid, n, type, name, normal) => ({ id: `${cid}-a${n}`, community_id: cid, account_number: String(n), account_name: name, account_type: type, normal_balance: normal, is_active: true, is_summary: false, fund_id: `${cid}-opr`, account_funds: { fund_code: 'OPR', fund_name: 'Operating' } });
function je(cid, ref, date, module, lines, status = 'posted') {
  const id = `je-${++seq}`;
  db.journal_entries.push({ id, community_id: cid, reference: ref, posting_date: date, source_module: module, status, void_reversal_je_id: null });
  lines.forEach(([acct, d, c]) => db.journal_entry_lines.push({ id: `jl-${++seq}`, journal_entry_id: id, account_id: `${cid}-a${acct}`, fund_id: `${cid}-opr`, debit_cents: d, credit_cents: c }));
  return id;
}
function community(cid) {
  db.chart_of_accounts.push(A(cid, 1000, 'asset', 'Operating Cash', 'debit'), A(cid, 2000, 'liability', 'Accounts Payable', 'credit'), A(cid, 3000, 'equity', 'Fund Balance', 'credit'),
    A(cid, 4000, 'revenue', 'Assessment Income', 'credit'), A(cid, 5000, 'expense', 'Landscaping', 'debit'));
  db.account_funds.push({ id: `${cid}-opr`, community_id: cid, fund_code: 'OPR', fund_name: 'Operating', is_active: true });
}
// Canyon Gate shape: CONV opening on 7/31 carries Jan-Jul revenue $70,000 and expense $40,000;
// a native July bill neutralized on its date and re-posted 8/1; August and September activity.
function seedConverted(cid, code) {
  community(cid);
  je(cid, 'JE-2026-LEGACY', '2026-03-31', 'vantaca_import', [[1000, 500000, 0], [4000, 0, 500000]], 'superseded');   // retired legacy import: never counted
  je(cid, `CONV-${code}-20260731-OPEN-OPR`, '2026-07-31', 'opening_entry', [[1000, 3000000, 0], [5000, 4000000, 0], [4000, 0, 7000000]]);
  const native = je(cid, 'JE-2026-00169', '2026-07-20', 'ap_invoice', [[5000, 50000, 0], [2000, 0, 50000]]);
  je(cid, `CONV-${code}-20260731-NEUT-JE-2026-00169`, '2026-07-20', 'reversal', [[2000, 50000, 0], [5000, 0, 50000]]);
  je(cid, `CONV-${code}-20260731-REPOST-JE-2026-00169`, '2026-08-01', 'manual', [[5000, 50000, 0], [2000, 0, 50000]]);
  je(cid, 'AUG-ASSESS', '2026-08-01', 'assessment_billing', [[1000, 1000000, 0], [4000, 0, 1000000]]);
  je(cid, 'AUG-LAWN', '2026-08-15', 'ap_invoice', [[5000, 400000, 0], [1000, 0, 400000]]);
  je(cid, 'SEP-ASSESS', '2026-09-01', 'assessment_billing', [[1000, 1100000, 0], [4000, 0, 1100000]]);
  je(cid, 'SEP-LAWN', '2026-09-15', 'ap_invoice', [[5000, 500000, 0], [1000, 0, 500000]]);
  return native;
}
function seedBudget(cid) {
  db.community_budgets.push({ id: `${cid}-b26`, community_id: cid, fiscal_year: 2026, status: 'approved' });
  db.budget_line_items.push({ budget_id: `${cid}-b26`, account_id: `${cid}-a4000`, fund_id: null, annual_amount_cents: 10800000, monthly_amounts_cents: Array(12).fill(900000) });
  db.budget_line_items.push({ budget_id: `${cid}-b26`, account_id: `${cid}-a5000`, fund_id: null, annual_amount_cents: 7200000, monthly_amounts_cents: Array(12).fill(600000) });
}
function reset() {
  seq = 0;
  db = { journal_entries: [], journal_entry_lines: [], chart_of_accounts: [], account_funds: [], community_budgets: [], budget_line_items: [], communities: [] };
}
const row = (rows, n) => rows.find((r) => r.account_number === String(n));

const results = [];
const t = (name, fn) => results.push({ name, fn });

// ---------------------------------------------------------------- the rule itself
t('rule: a window is defined by provenance (source_module opening_entry) carrying revenue/expense; a balance-sheet-only opening defines none', () => {
  const types = new Map([['a-rev', 'revenue'], ['a-cash', 'asset']]);
  const w = SP.buildWindows([{ id: 'o1', reference: 'CONV-X-OPEN', posting_date: '2026-07-31' }, { id: 'o2', reference: 'JE-2026-OPEN', posting_date: '2026-01-01' }],
    [{ journal_entry_id: 'o1', account_id: 'a-rev' }, { journal_entry_id: 'o2', account_id: 'a-cash' }], types);
  assert.deepStrictEqual(w.map((x) => [x.from, x.through]), [['2026-01-01', '2026-07-31']]);
  assert.strictEqual(w[0].label, 'Opening YTD activity carried from prior system through 7/31/2026');
});

t('rule: covers / partial / inside / disjoint', () => {
  const w = [{ from: '2026-01-01', through: '2026-07-31', label: 'L', references: [] }];
  assert.strictEqual(SP.coverage(w, '2026-07-01', '2026-07-31').status, 'not_available');
  assert.strictEqual(SP.coverage(w, '2026-01-01', '2026-09-30').status, 'available');
  assert.strictEqual(SP.coverage(w, '2026-01-01', '2026-09-30').carryforward_included.length, 1);
  assert.strictEqual(SP.coverage(w, '2026-06-01', '2026-08-31').status, 'partial');
  assert.deepStrictEqual(SP.coverage(w, '2026-06-01', '2026-08-31').unavailable_months, ['2026-06', '2026-07']);
  assert.strictEqual(SP.coverage(w, '2026-08-01', '2026-08-31').status, 'available');
  assert.strictEqual(SP.coverage(w, '2026-08-01', '2026-08-31').carryforward_included.length, 0);
  assert.strictEqual(SP.coverage([], '2026-07-01', '2026-07-31').status, 'available', 'no window: ordinary community');
});

// ---------------------------------------------------------------- Canyon Gate, converted 7/31
t('Canyon Gate July monthly: NOT AVAILABLE (null), never the Jan-Jul opening lump as July revenue/expense', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const is = await FS.incomeStatement({ community_id: 'cg', period_start: '2026-07-01', period_end: '2026-07-31' });
  assert.strictEqual(is.availability.period.status, 'not_available');
  assert.strictEqual(is.totals.period.revenue_cents, null);
  assert.strictEqual(is.totals.period.expenses_cents, null);
  assert.strictEqual(row(is.sections.revenue, 4000).period_amount_cents, null);
  assert.ok(/Not available in TrustEd: 2026-07/.test(is.availability.period.note), is.availability.period.note);
  // YTD through 7/31 covers the whole window: it is the carryforward
  assert.strictEqual(is.totals.ytd.revenue_cents, 7000000);
  assert.strictEqual(is.totals.ytd.expenses_cents, 4000000);
  assert.strictEqual(is.carryforward.ytd.revenue_cents, 7000000);
});

t('Canyon Gate August monthly = August only (incl. the conversion re-post of a July bill moved across the cutover)', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const is = await FS.incomeStatement({ community_id: 'cg', period_start: '2026-08-01', period_end: '2026-08-31' });
  assert.strictEqual(is.availability.period.status, 'available');
  assert.strictEqual(is.totals.period.revenue_cents, 1000000);
  assert.strictEqual(is.totals.period.expenses_cents, 400000 + 50000);
  assert.strictEqual(is.carryforward.period.revenue_cents, 0, 'no carryforward in August');
});

t('Canyon Gate September monthly = September only; September YTD = carryforward + August + September', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const is = await FS.incomeStatement({ community_id: 'cg', period_start: '2026-09-01', period_end: '2026-09-30' });
  assert.strictEqual(is.totals.period.revenue_cents, 1100000);
  assert.strictEqual(is.totals.period.expenses_cents, 500000);
  assert.strictEqual(is.totals.ytd.revenue_cents, 7000000 + 1000000 + 1100000);
  assert.strictEqual(is.totals.ytd.expenses_cents, 4000000 + 450000 + 500000);
  assert.deepStrictEqual([is.carryforward.ytd.revenue_cents, is.carryforward.ytd.expenses_cents], [7000000, 4000000], 'carryforward identifiable');
  assert.strictEqual(row(is.sections.revenue, 4000).ytd_carryforward_cents, 7000000);
  assert.strictEqual(is.carryforward.windows[0].label, 'Opening YTD activity carried from prior system through 7/31/2026');
});

t('a full-year / Jan-Sep period covers the window: the carryforward counts (budget builder prior-year actuals keep Jan-Jul)', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const is = await FS.incomeStatement({ community_id: 'cg', period_start: '2026-01-01', period_end: '2026-12-31' });
  assert.strictEqual(is.totals.period.revenue_cents, 9100000);
  assert.strictEqual(is.totals.ytd.revenue_cents, 9100000);
});

t('a Jun-Aug period overlaps the window partially: carryforward excluded, June/July flagged, August counted', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const is = await FS.incomeStatement({ community_id: 'cg', period_start: '2026-06-01', period_end: '2026-08-31' });
  assert.strictEqual(is.availability.period.status, 'partial');
  assert.deepStrictEqual(is.availability.period.unavailable_months, ['2026-06', '2026-07']);
  assert.strictEqual(is.totals.period.revenue_cents, 1000000, 'August only; never the Jan-Jul lump');
});

t('budget vs actual (Sep): month actual = September; YTD actual = carryforward + Aug + Sep; variance favorable-positive for revenue AND expense', async () => {
  reset(); seedConverted('cg', 'CGACR'); seedBudget('cg');
  const b = await FS.budgetVsActual({ community_id: 'cg', period_end: '2026-09-30' });
  const rev = row(b.rows, 4000), exp = row(b.rows, 5000);
  assert.strictEqual(b.variance_convention, 'favorable_positive');
  assert.deepStrictEqual([rev.mtd_budget_cents, rev.mtd_actual_cents, rev.mtd_variance_cents], [900000, 1100000, 200000], 'revenue over budget = +');
  assert.deepStrictEqual([exp.mtd_budget_cents, exp.mtd_actual_cents, exp.mtd_variance_cents], [600000, 500000, 100000], 'expense under budget = +');
  assert.deepStrictEqual([rev.ytd_budget_cents, rev.ytd_actual_cents, rev.ytd_variance_cents], [8100000, 9100000, 1000000]);
  assert.deepStrictEqual([exp.ytd_budget_cents, exp.ytd_actual_cents, exp.ytd_variance_cents], [5400000, 4950000, 450000]);
  assert.strictEqual(rev.ytd_carryforward_cents, 7000000);
});

t('budget vs actual (Jul): no monthly actual or variance (null, never $0 or a fake variance); YTD actual = the carryforward', async () => {
  reset(); seedConverted('cg', 'CGACR'); seedBudget('cg');
  const b = await FS.budgetVsActual({ community_id: 'cg', period_end: '2026-07-31' });
  const rev = row(b.rows, 4000);
  assert.strictEqual(b.availability.mtd.status, 'not_available');
  assert.strictEqual(rev.mtd_actual_cents, null);
  assert.strictEqual(rev.mtd_variance_cents, null);
  assert.strictEqual(rev.mtd_budget_cents, 900000, 'the budget is still shown');
  assert.strictEqual(rev.ytd_actual_cents, 7000000);
});

t('printed by-fund statement (Jul): month totals are not available (null), never summed to $0; YTD totals real', async () => {
  reset(); seedConverted('cg', 'CGACR'); seedBudget('cg');
  const p = await FS.perFundIncomeStatement({ community_id: 'cg', period_end: '2026-07-31', _mapping: { has_mapping: false, byAccount: new Map() } });
  const f = p.funds[0];
  assert.strictEqual(f.revenue_totals.mtd_actual_cents, null);
  assert.strictEqual(f.net_totals.mtd_actual_cents, null);
  assert.strictEqual(f.revenue_totals.mtd_budget_cents, 900000);
  assert.strictEqual(f.revenue_totals.ytd_actual_cents, 7000000);
});

t('category grouping keeps "not available" amounts null in every subtotal (never a fake zero)', () => {
  const mapping = { has_mapping: false, byAccount: new Map() };
  const g = groupStatementRows([{ account_id: 'x', account_type: 'revenue', account_number: '4000', mtd_actual_cents: null, ytd_actual_cents: 5 }], mapping, ['mtd_actual_cents', 'ytd_actual_cents']);
  assert.strictEqual(g.totals.revenue.mtd_actual_cents, null);
  assert.strictEqual(g.totals.net.mtd_actual_cents, null);
  assert.strictEqual(g.totals.revenue.ytd_actual_cents, 5);
});

t('rolling 12 (Oct 2025-Sep 2026): July is NOT Jan-Jul; Jan-Jul are not available (not "zero gaps"); the carryforward is its own column and in the total', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const r = await FS.rollingIncomeStatement({ community_id: 'cg', end_date: '2026-09-30', months: 12 });
  const jul = r.monthly.find((m) => m.month === '2026-07');
  assert.strictEqual(jul.status, 'not_available');
  assert.strictEqual(jul.revenue_cents, null);
  assert.deepStrictEqual(r.not_available_months, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
  assert.ok(!r.zero_months.some((m) => r.not_available_months.includes(m)), 'not-available months are not data gaps');
  assert.deepStrictEqual(r.zero_months, ['2025-10', '2025-11', '2025-12'], 'months before the year are honest zeros here');
  assert.strictEqual(r.monthly.find((m) => m.month === '2026-08').revenue_cents, 1000000);
  assert.strictEqual(r.carryforward.revenue_cents, 7000000);
  const rev = r.revenue_groups.flatMap((g) => g.accounts).find((a) => a.account_number === '4000');
  assert.strictEqual(rev.by_month['2026-07'] || 0, 0, 'no carryforward attributed to July');
  assert.strictEqual(rev.carryforward_cents, 7000000);
  assert.strictEqual(rev.total_cents, 9100000);
});

t('balance sheet keeps the conversion opening entry in balances (this rule is for period activity only)', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const bs = await FS.balanceSheet({ community_id: 'cg', as_of_date: '2026-09-30' });
  const cash = bs.sections.assets.find((r) => r.account_number === '1000');
  assert.strictEqual(cash.balance_cents, 3000000 + 1000000 - 400000 + 1100000 - 500000);
});

t('budget plan monthly actuals: Jan-Jul null (not available), never the lump in July; Aug/Sep real; prior-actual phasing refuses rather than mis-shape', async () => {
  reset(); seedConverted('cg', 'CGACR');
  const m = await monthlyActualsByAccount(fakeClient(), 'cg', 2026, [{ id: 'cg-a4000', normal_balance: 'credit' }]);
  assert.deepStrictEqual(m['cg-a4000'].slice(0, 7), [null, null, null, null, null, null, null]);
  assert.strictEqual(m['cg-a4000'][7], 1000000);
  assert.strictEqual(m['cg-a4000'][8], 1100000);
  assert.throws(() => phase({ method: 'prior_actual', annual_cents: 12000000, prior_actual_months: m['cg-a4000'], settings: {} }), /prior_actual_months_not_available_in_trusted/);
});

// ---------------------------------------------------------------- LOPF: same cutover, known broken history
t('LOPF: same cutover behavior, and statements never hide its broken history', async () => {
  reset(); seedConverted('lpf', 'LPF');
  // JE-2026-00170..: posted headers whose lines were deleted (the scar). They carry no lines, so no
  // statement can show them; presentation must not fabricate or net anything for them either.
  db.journal_entries.push({ id: 'je-lineless', community_id: 'lpf', reference: 'JE-2026-00170', posting_date: '2026-07-28', source_module: 'ap_invoice', status: 'posted', void_reversal_je_id: null });
  // A native July bill that was NOT neutralized: real trustEd activity inside a not-available month.
  je('lpf', 'JE-2026-00180', '2026-07-29', 'ap_invoice', [[5000, 123400, 0], [2000, 0, 123400]]);
  const jul = await FS.incomeStatement({ community_id: 'lpf', period_start: '2026-07-01', period_end: '2026-07-31' });
  assert.strictEqual(jul.availability.period.status, 'not_available');
  assert.strictEqual(jul.totals.ytd.expenses_cents, 4000000 + 123400, 'YTD keeps the un-neutralized July bill: never normalized away');
  const r = await FS.rollingIncomeStatement({ community_id: 'lpf', end_date: '2026-09-30', months: 12 });
  const m7 = r.monthly.find((m) => m.month === '2026-07');
  assert.strictEqual(m7.native_expense_cents, 123400, 'shown on the not-available month, flagged, never dropped');
  const exp = r.expense_groups.flatMap((g) => g.accounts).find((a) => a.account_number === '5000');
  assert.strictEqual(exp.by_month['2026-07'], 123400);
  assert.strictEqual(exp.total_cents, 4000000 + 123400 + 450000 + 500000);
  const bs = await FS.balanceSheet({ community_id: 'lpf', as_of_date: '2026-09-30' });
  const ap = bs.sections.liabilities.find((x) => x.account_number === '2000');
  assert.strictEqual(ap.balance_cents, 50000 + 123400, 'AP = the re-posted July bill + the un-neutralized one, as booked (not repaired by presentation)');
});

// ---------------------------------------------------------------- greenfield
t('greenfield (no conversion): July monthly is July, YTD is the plain sum — exactly as before', async () => {
  reset(); community('gf');
  je('gf', 'JAN', '2026-01-10', 'assessment_billing', [[1000, 200000, 0], [4000, 0, 200000]]);
  je('gf', 'JUL', '2026-07-10', 'assessment_billing', [[1000, 300000, 0], [4000, 0, 300000]]);
  je('gf', 'JULX', '2026-07-20', 'ap_invoice', [[5000, 70000, 0], [1000, 0, 70000]]);
  const is = await FS.incomeStatement({ community_id: 'gf', period_start: '2026-07-01', period_end: '2026-07-31' });
  assert.strictEqual(is.availability.period.status, 'available');
  assert.strictEqual(is.totals.period.revenue_cents, 300000);
  assert.strictEqual(is.totals.period.expenses_cents, 70000);
  assert.strictEqual(is.totals.ytd.revenue_cents, 500000);
  assert.deepStrictEqual(is.carryforward.windows, []);
  const r = await FS.rollingIncomeStatement({ community_id: 'gf', end_date: '2026-07-31', months: 12 });
  assert.deepStrictEqual(r.not_available_months, []);
  assert.strictEqual(r.monthly.find((m) => m.month === '2026-07').revenue_cents, 300000);
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of results) {
    try { await fn(); console.log('  ✓', name); passed++; } catch (e) { console.log('  ✗', name, '\n      ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e); failed++; }
  }
  console.log(`\nstatement_periods: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
