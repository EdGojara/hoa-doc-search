// tests/test_living_budget_prior_year.js  (Ed 2026-10-09)
// ----------------------------------------------------------------------------
// Living budget (GET /api/books/budgets/living-lines): a prior year that is not
// available in trustEd (a converted community's pre-history, PR #107) is null on
// EVERY row, never $0, including budget-only rows (an account budgeted last year
// with no activity, which the route adds after the activity rows). A year that IS
// available and had no activity stays a real 0 (non-converted communities). And no
// downstream calculation treats "not available" as zero.
// Drives the REAL route against an in-memory ledger.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');
const http = require('http');

let db;
const get = (row, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
function enrich(table, r) {
  if (table !== 'journal_entry_lines') return r;
  return { ...r, journal_entries: db.journal_entries.find((j) => j.id === r.journal_entry_id) || null };
}
function fakeClient() {
  return {
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not in fake' } }),
    storage: { from() { return { createSignedUrl: async () => ({ data: null, error: null }) }; } },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
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
        order(c) { st.order = c; return q; }, range(a, b) { st.range = [a, b]; return q; }, limit(n) { st.limit = n; return q; },
        neq() { return q; }, not() { return q; }, is() { return q; }, or() { return q; }, ilike() { return q; }, gt() { return q; }, lt() { return q; },
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
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  return realLoad.apply(this, arguments);
};
const express = require('express');
const { router } = require('../api/books');
Module._load = realLoad;
const app = express(); app.use('/api/books', router);

// ---------------------------------------------------------------- fixtures
let seq = 0;
const A = (cid, n, type, name, normal) => ({ id: `${cid}-a${n}`, community_id: cid, account_number: String(n), account_name: name, account_type: type, normal_balance: normal, is_active: true, is_summary: false, fund_id: `${cid}-opr`, account_funds: { fund_code: 'OPR', fund_name: 'Operating' } });
function je(cid, ref, date, module, lines, status = 'posted') {
  const id = `je-${++seq}`;
  db.journal_entries.push({ id, community_id: cid, reference: ref, posting_date: date, source_module: module, status, void_reversal_je_id: null });
  lines.forEach(([acct, d, c]) => db.journal_entry_lines.push({ id: `jl-${++seq}`, journal_entry_id: id, account_id: `${cid}-a${acct}`, fund_id: `${cid}-opr`, debit_cents: d, credit_cents: c, vendor_id: null }));
}
function community(cid) {
  db.communities.push({ id: cid, name: cid });
  db.chart_of_accounts.push(A(cid, 1000, 'asset', 'Operating Cash', 'debit'), A(cid, 2000, 'liability', 'Accounts Payable', 'credit'),
    A(cid, 4000, 'revenue', 'Assessment Income', 'credit'), A(cid, 5000, 'expense', 'Landscaping', 'debit'),
    A(cid, 5100, 'expense', 'Insurance', 'debit'));   // 5100: budgeted, never any activity (a budget-only row)
  db.account_funds.push({ id: `${cid}-opr`, community_id: cid, fund_code: 'OPR', fund_name: 'Operating', is_active: true });
}
function budget(cid, fy, lines) {
  db.community_budgets.push({ id: `${cid}-b${fy}`, community_id: cid, fiscal_year: fy, status: 'approved' });
  for (const [acct, cents] of lines) db.budget_line_items.push({ budget_id: `${cid}-b${fy}`, account_id: `${cid}-a${acct}`, fund_id: null, annual_amount_cents: cents, monthly_amounts_cents: Array(12).fill(Math.round(cents / 12)) });
}
// Converted at 7/31/2026: the opening entry carries Jan-Jul; Aug/Sep native activity.
function converted(cid, code) {
  community(cid);
  je(cid, `CONV-${code}-20260731-OPEN-OPR`, '2026-07-31', 'opening_entry', [[1000, 3000000, 0], [5000, 4000000, 0], [4000, 0, 7000000]]);
  je(cid, 'AUG', '2026-08-01', 'assessment_billing', [[1000, 1000000, 0], [4000, 0, 1000000]]);
  je(cid, 'SEP-LAWN', '2026-09-15', 'ap_invoice', [[5000, 500000, 0], [1000, 0, 500000]]);
}
// Non-converted: real 2025 history (with a 2025 year that HAS data) and 2026 activity.
function greenfield(cid) {
  community(cid);
  je(cid, 'GF-2025', '2025-05-10', 'assessment_billing', [[1000, 900000, 0], [4000, 0, 900000]]);
  je(cid, 'GF-2026', '2026-05-10', 'assessment_billing', [[1000, 950000, 0], [4000, 0, 950000]]);
  je(cid, 'GF-2026-L', '2026-06-10', 'ap_invoice', [[5000, 300000, 0], [1000, 0, 300000]]);
}
function reset() { seq = 0; db = { communities: [], journal_entries: [], journal_entry_lines: [], chart_of_accounts: [], account_funds: [], community_budgets: [], budget_line_items: [], vendors: [], amenities: [], vendor_contracts: [], properties: [], library_documents: [] }; }

let base;
async function living(cid, fy) {
  const r = await fetch(`${base}/api/books/budgets/living-lines?community_id=${cid}&fiscal_year=${fy}`);
  const text = await r.text();
  assert.ok(!/NaN/.test(text), 'no NaN anywhere in the response');
  return { status: r.status, body: JSON.parse(text), text };
}
const rowOf = (j, n) => j.rows.find((x) => x.account_number === String(n));
const results = [];
const t = (name, fn) => results.push({ name, fn });

for (const [cid, code, label] of [['cg', 'CGACR', 'Canyon Gate'], ['lpf', 'LPF', 'LOPF']]) {
  t(`${label}: budget-only account (no activity) shows null for a prior year not available in trustEd, exactly like the rows with activity (FY2027: 2025 n/a, 2026 real)`, async () => {
    reset(); converted(cid, code); budget(cid, 2026, [[4000, 10800000], [5000, 7200000], [5100, 1800000]]);
    const { status, body } = await living(cid, 2027);
    assert.strictEqual(status, 200, JSON.stringify(body));
    const ins = rowOf(body, 5100), rev = rowOf(body, 4000);
    assert.ok(ins, 'the budget-only account is still listed');
    assert.strictEqual(ins.fy2_actual_cents, null, 'FY2025 (pre-history): not available, never $0');
    assert.strictEqual(rev.fy2_actual_cents, null, 'same rule as a row with activity');
    assert.strictEqual(ins.fy1_actual_cents, 0, 'FY2026 is available: no activity is a real 0');
    assert.strictEqual(rev.fy1_actual_cents, 8000000, 'FY2026 actual unchanged (carryforward + Aug)');
  });
  t(`${label}: when BOTH prior years are pre-history (FY2026), the budget-only row has both prior-year fields null`, async () => {
    reset(); converted(cid, code); budget(cid, 2025, [[5100, 1700000], [5000, 6000000]]);
    const { status, body } = await living(cid, 2026);
    assert.strictEqual(status, 200, JSON.stringify(body));
    const ins = rowOf(body, 5100);
    assert.ok(ins, 'the budget-only account is still listed');
    assert.deepStrictEqual([ins.fy1_actual_cents, ins.fy2_actual_cents], [null, null]);
  });
}

t('converted: no downstream arithmetic treats "not available" as zero (no spike flag from a null prior year, proposal from the prior budget, no NaN, no "$0 actual" claim)', async () => {
  reset(); converted('cg', 'CGACR'); budget('cg', 2026, [[4000, 10800000], [5000, 7200000], [5100, 1800000]]);
  const { body, text } = await living('cg', 2027);
  const ins = rowOf(body, 5100);
  assert.ok(Number.isFinite(ins.proposed_cents), 'a proposal is computed');
  assert.ok(ins.proposed_cents >= 1800000, 'built from the prior adopted budget, not from a null-as-zero actual');
  assert.ok(!(ins.flags || []).some((f) => f.type === 'one_time'), 'a null prior year is no evidence of a one-time spike');
  assert.ok(!/2025 actual \$0/.test(text), 'never claims a $0 2025 actual');
});

t('non-converted: a prior year with data shows its real value, and a budget-only account shows a legitimate 0 (not null)', async () => {
  reset(); greenfield('gf'); budget('gf', 2026, [[4000, 11000000], [5100, 1800000]]);
  const { status, body } = await living('gf', 2027);
  assert.strictEqual(status, 200, JSON.stringify(body));
  const rev = rowOf(body, 4000), ins = rowOf(body, 5100);
  assert.strictEqual(rev.fy2_actual_cents, 900000, 'FY2025 real value');
  assert.strictEqual(rev.fy1_actual_cents, 950000, 'FY2026 real value');
  assert.deepStrictEqual([ins.fy2_actual_cents, ins.fy1_actual_cents], [0, 0], 'budget-only in available years: real zeros');
});

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const origErr = console.error, origWarn = console.warn; console.error = () => {}; console.warn = () => {};
  let passed = 0, failed = 0;
  for (const { name, fn } of results) {
    try { await fn(); origWarn('  ✓', name); passed++; } catch (e) { origErr('  ✗', name, '\n      ', e && e.message); failed++; }
  }
  console.error = origErr; console.warn = origWarn;
  server.close();
  console.log(`\nliving_budget_prior_year: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
