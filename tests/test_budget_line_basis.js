// tests/test_budget_line_basis.js  (Ed 2026-10-14, migration 521)
// ----------------------------------------------------------------------------
// Each budget line records WHY its amount is what it is, and a contract prices a
// line through ONE engine:
//   1. lib/accounting/budget_line_basis.js reads the basis off the working-forecast
//      bridge: contract (with the contract + document), transfer, assessment,
//      reserve projects, history; needs_review for an unverified contract, an
//      estimate / pending notice, or a saved amount the forecast does not explain.
//   2. GET /api/books/budgets/living-lines (REAL route, in-memory ledger): a verified
//      contract bound to the line is priced at the working forecast's amount
//      (contractCostForYear), never by vendor-name matching or a +4% renewal; an
//      unverified contract is flagged and never applied; a saved draft's recorded
//      basis rides along.
//   3. POST /api/working-forecast/:cid/draft-budget (REAL route): creates the draft
//      with every line's basis; on an existing draft writes the basis only, never an
//      amount; an approved budget is refused.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');
const http = require('http');
const LB = require('../lib/accounting/budget_line_basis');
const { applySavedDraft } = require('../lib/accounting/budget_merge');
const { buildLine } = require('../lib/forecast/working_forecast');
const { contractCostForYear } = require('../lib/contracts/contract_terms');

const results = [];
const t = (name, fn) => results.push({ name, fn });

// ------------------------------------------------------------------ 1) pure basis
const FY = new Date().getUTCFullYear();   // target year; the base year (FY-1) is a full year, so the cutoff is stable
const BY = FY - 1;
const ctx = { as_of_month: 12, as_of: `${BY}-12-31`, base_year: BY, target_year: FY, policy: { expense_inflation_pct: 3, inflation_source: 'policy', inflation_confidence: 'low' }, post_cutover_months: [] };
const even = (c) => { const m = Array(12).fill(Math.floor(c / 12)); m[11] += c - m.reduce((a, b) => a + b, 0); return m; };
const UPS = { id: 'vc-ups', vendor_name: 'United Protective Services', vendor_name_raw: 'United Protective Services', status: 'active', execution_status: 'verified_executed', verified_by: 'ed@example.test', verified_at: `${BY}-10-10`,
  effective_date: `${BY}-01-01`, end_date: null, periodic_amount: 5200, periodic_frequency: 'monthly', escalator_kind: 'none', file_path: 'contracts/ups.pdf', file_hash: 'a'.repeat(64), source_document_id: 'doc-ups' };
const line = (o) => ({ account_id: 'a1', account_number: '5810', account_name: 'Management Fee', account_type: 'expense', fund_id: 'f-opr', fund_code: 'OPR', fund_type: 'operating', budget_months: even(6000000), ytd_actual: 6000000, month_actuals: {}, actual_months: even(6000000), ...o });

t('contract line: basis contract, its contract and document, the arithmetic, at the contract amount', () => {
  const l = buildLine(line({ contracts: [UPS] }), ctx);
  const cost = contractCostForYear(UPS, FY);
  assert.strictEqual(l.recommendation_cents, cost.annual_cents, 'the forecast prices the line at the contract');
  const b = LB.basisFromForecastLine(l, ctx);
  assert.strictEqual(b.amount_basis, 'contract');
  assert.strictEqual(b.vendor_contract_id, 'vc-ups');
  assert.strictEqual(b.source_document_id, 'doc-ups');
  assert.ok(/United Protective Services: Jan-Dec: \$5,200\.00 monthly/.test(b.amount_calc), b.amount_calc);
  assert.strictEqual(b.needs_review, false, b.review_note);
  const c = LB.contractFromForecastLine(l);
  assert.deepStrictEqual([c.status, c.proposed_cents], ['applied', 6240000], 'the screen reads the same amount');
});

t('unverified contract (Ed 2026-10-14): priced from its terms, basis Contract with the contract, and the line needs review', () => {
  const l = buildLine(line({ contracts: [{ ...UPS, execution_status: 'likely_executed' }] }), ctx);
  assert.strictEqual(l.recommendation_cents, 6240000, 'priced from its terms, never a percentage');
  const b = LB.basisFromForecastLine(l, ctx);
  assert.deepStrictEqual([b.amount_basis, b.vendor_contract_id, b.needs_review], ['contract', 'vc-ups', true]);
  assert.ok(/not verified as executed/.test(b.review_note), b.review_note);
  const c = LB.contractFromForecastLine(l);
  assert.deepStrictEqual([c.status, c.unverified, c.proposed_cents], ['applied', true, 6240000]);
});

t('a set amount on a contract line stays basis Contract, shows the contract pricing, and needs review when they differ', () => {
  const l = buildLine(line({ contracts: [UPS] }), ctx, {}, { override_cents: 6500000, model_recommendation_cents: 6240000, reason: 'Board approved a sixth guard shift.', actor: 'ed@example.test', created_at: 'x' });
  const b = LB.basisFromForecastLine(l, ctx);
  assert.deepStrictEqual([b.amount_basis, b.vendor_contract_id, b.needs_review], ['contract', 'vc-ups', true]);
  assert.ok(b.amount_calc.startsWith('Set at $65,000.00 by ed@example.test: Board approved a sixth guard shift') && b.amount_calc.includes('Contract pricing $62,400.00'), b.amount_calc);
  assert.ok(b.review_note.includes('price this line at $62,400.00; the amount was set at $65,000.00'), b.review_note);
});

t('an inflation percentage nobody confirmed is flagged as an unverified assumption', () => {
  const b = LB.basisFromForecastLine(buildLine(line({}), ctx), ctx);
  assert.strictEqual(b.needs_review, true);
  assert.ok((b.review_note || '').includes('unconfirmed default assumption (3%'), b.review_note);
  const set = LB.basisFromForecastLine(buildLine(line({}), { ...ctx, policy: { ...ctx.policy, inflation_confidence: 'medium', inflation_source: 'CPI-U Houston, set by ed' } }), ctx);
  assert.ok(!/unconfirmed default/.test(set.review_note || ''), set.review_note);
});

t('an override whose reason is an estimate or a pending notice needs review; a settled one does not', () => {
  const est = buildLine(line({ account_number: '5890', account_name: 'CLMA Assessment' }), ctx, {}, { override_cents: 18250700, model_recommendation_cents: 6180000, reason: 'The 2027 notice has not arrived: estimate at the 2026 billing.', actor: 'ed@example.test', created_at: 'x' });
  const b = LB.basisFromForecastLine(est, ctx);
  assert.strictEqual(b.amount_basis, 'historical_forecast');
  assert.ok(/Set at \$182,507\.00 by ed@example\.test: The 2027 notice has not arrived/.test(b.amount_calc), b.amount_calc);
  assert.strictEqual(b.needs_review, true);
  const ok = buildLine(line({ account_number: '5857', account_name: 'Porter' }), ctx, {}, { override_cents: 5200000, model_recommendation_cents: 6180000, reason: 'Porter services continue: $1,000/week x 52 (confirmed by the board).', actor: 'ed@example.test', created_at: 'x' });
  const b2 = LB.basisFromForecastLine(ok, ctx);
  assert.strictEqual(b2.needs_review, false, b2.review_note);
  assert.ok(/\$1,000\/week x 52/.test(b2.amount_calc));
});

t('transfer: basis transfer, needs a board decision until one is recorded', () => {
  const l = buildLine(line({ account_number: '4010', account_name: 'Reserve Contribution', account_type: 'revenue', budget_months: even(-16400000), ytd_actual: 0, transfer: { from_fund_code: 'OPR', to_fund_code: 'RES', from_fund_type: 'operating', to_fund_type: 'reserve' } }), ctx);
  const b = LB.basisFromForecastLine(l, ctx);
  assert.deepStrictEqual([b.amount_basis, b.needs_review], ['transfer', true]);
  assert.ok(/OPR -> RES \$164,000\.00/.test(b.amount_calc), b.amount_calc);
});

t('assessment revenue and reserve expenditures take their own basis', () => {
  const a = LB.basisFromForecastLine(buildLine(line({ account_number: '4000', account_name: 'Assessment Income', account_type: 'revenue', budget_months: even(102742500), ytd_actual: 102742500, actual_months: even(102742500) }), ctx), ctx);
  assert.strictEqual(a.amount_basis, 'assessment');
  const r = LB.basisFromForecastLine(buildLine(line({ account_number: '6100', account_name: 'Reserve - Pool', fund_type: 'reserve', fund_code: 'RES' }), ctx), ctx);
  assert.strictEqual(r.amount_basis, 'board_project');
});

t('a saved amount the forecast does not explain records no basis and needs review (both amounts named)', () => {
  const l = buildLine(line({ contracts: [UPS] }), ctx);
  const same = LB.basisForSavedLine({ annual_amount_cents: 6240000 }, [l], ctx);
  assert.strictEqual(same.amount_basis, 'contract');
  const diff = LB.basisForSavedLine({ annual_amount_cents: 6500000 }, [l], ctx);
  assert.deepStrictEqual([diff.amount_basis, diff.amount_calc, diff.vendor_contract_id, diff.needs_review], [null, null, null, true]);
  assert.ok(/saved amount \$65,000\.00 is not the working forecast's \$62,400\.00/.test(diff.review_note), diff.review_note);
  const none = LB.basisForSavedLine({ annual_amount_cents: 100 }, [], ctx);
  assert.strictEqual(none.needs_review, true);
});

t('applySavedDraft: the saved basis rides along with the saved amount', () => {
  const rows = applySavedDraft([{ account_id: 'a1', proposed_cents: 1 }, { account_id: 'a2', proposed_cents: 2 }], { lines: [
    { account_id: 'a1', annual_amount_cents: 6240000, amount_basis: 'contract', amount_calc: 'x', vendor_contract_id: 'vc', needs_review: false },
    { account_id: 'a2', annual_amount_cents: 5, amount_basis: null, needs_review: false }] });
  assert.deepStrictEqual([rows[0].proposed_cents, rows[0].saved_basis.amount_basis, rows[0].saved_basis.vendor_contract_id], [6240000, 'contract', 'vc']);
  assert.strictEqual(rows[1].saved_basis, null);
  assert.ok(LB.basisText(rows[0].saved_basis).startsWith('Contract: x'));
});

// ------------------------------------------------------------------ 2+3) the real routes, in-memory ledger
let db; let seq = 0;
const get = (row, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
function enrich(table, r) {
  if (table !== 'journal_entry_lines') return r;
  return { ...r, journal_entries: db.journal_entries.find((j) => j.id === r.journal_entry_id) || null };
}
function fakeClient() {
  return {
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not in fake' } }),
    storage: { from() { return { createSignedUrl: async (p) => ({ data: { signedUrl: `https://signed/${p}` }, error: null }) }; } },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from(table) {
      const st = { f: [], order: null, range: null, limit: null, head: false, op: 'select', payload: null, single: false };
      const match = () => (db[table] || []).filter((r) => st.f.every((fn) => fn(enrich(table, r))));
      const rows = () => {
        let out = (db[table] || []).map((r) => enrich(table, r)).filter((r) => st.f.every((fn) => fn(r)));
        if (table === 'journal_entry_lines') out = out.filter((r) => r.journal_entries);
        if (st.order) out.sort((a, b) => (a[st.order] > b[st.order] ? 1 : a[st.order] < b[st.order] ? -1 : 0));
        if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
        if (st.limit != null) out = out.slice(0, st.limit);
        return out;
      };
      const run = () => {
        if (st.op === 'insert') { const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({ id: r.id || `${table}-${++seq}`, needs_review: false, ...r })); (db[table] = db[table] || []).push(...list); return { data: list, error: null }; }
        if (st.op === 'update') { const hit = match(); for (const r of hit) Object.assign(r, st.payload); return { data: hit, error: null }; }
        if (st.op === 'delete') { const hit = new Set(match()); db[table] = (db[table] || []).filter((r) => !hit.has(r)); return { data: [...hit], error: null }; }
        const r = rows(); return st.head ? { data: null, count: r.length, error: null } : { data: r, error: null };
      };
      const q = {
        select(_c, o) { if (o && o.head) st.head = true; return q; },
        insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
        eq(c, v) { st.f.push((r) => get(r, c) === v); return q; },
        in(c, vs) { st.f.push((r) => vs.includes(get(r, c))); return q; },
        gte(c, v) { st.f.push((r) => get(r, c) >= v); return q; },
        lte(c, v) { st.f.push((r) => get(r, c) <= v); return q; },
        order(c) { st.order = c; return q; }, range(a, b) { st.range = [a, b]; return q; }, limit(n) { st.limit = n; return q; },
        neq() { return q; }, not() { return q; }, is() { return q; }, or() { return q; }, ilike() { return q; }, gt() { return q; }, lt() { return q; },
        async maybeSingle() { const r = run(); return { data: (r.data || [])[0] || null, error: null }; },
        async single() { const r = run(); return (r.data || []).length ? { data: r.data[0], error: null } : { data: null, error: { message: 'no rows' } }; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
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
  if (request === './_require_admin') return { requireAdmin: async () => ({ email: 'owner@example.test', role: 'admin' }) };
  return realLoad.apply(this, arguments);
};
const express = require('express');
const { router: books } = require('../api/books');
const wfRouter = require('../api/working_forecast');
const app = express(); app.use(express.json()); app.use('/api/books', books); app.use('/api/working-forecast', wfRouter);

const CID = 'cg';
const acct = (n, type, name) => ({ id: `a${n}`, community_id: CID, account_number: String(n), account_name: name, account_type: type, normal_balance: type === 'revenue' ? 'credit' : 'debit', is_active: true, is_summary: false, fund_id: 'f-opr', account_funds: { fund_code: 'OPR', fund_name: 'Operating', fund_type: 'operating' } });
function je(ref, date, lines) {
  const id = `je-${++seq}`;
  db.journal_entries.push({ id, community_id: CID, reference: ref, posting_date: date, source_module: 'ap_invoice', status: 'posted', void_reversal_je_id: null });
  lines.forEach(([n, d, c, vendor]) => db.journal_entry_lines.push({ id: `jl-${++seq}`, journal_entry_id: id, account_id: `a${n}`, fund_id: 'f-opr', debit_cents: d, credit_cents: c, vendor_id: vendor || null }));
}
function world() {
  seq = 0;
  db = { communities: [{ id: CID, name: 'Canyon Gate', legal_name: 'Canyon Gate' }], journal_entries: [], journal_entry_lines: [], account_funds: [{ id: 'f-opr', community_id: CID, fund_code: 'OPR', fund_name: 'Operating', fund_type: 'operating', is_active: true }],
    chart_of_accounts: [acct(1000, 'asset', 'Operating Cash'), acct(4000, 'revenue', 'Assessment Income'), acct(5810, 'expense', 'Management Fee'), acct(5200, 'expense', 'Landscape Maintenance'), acct(5300, 'expense', 'Pool Maintenance')],
    community_budgets: [{ id: 'b-base', community_id: CID, fiscal_year: BY, status: 'approved', approved_at: `${BY - 1}-12-01` }], budget_line_items: [],
    vendors: [{ id: 'v-earth', name: 'Earthcare Landscaping' }], amenities: [], properties: [], library_documents: [{ id: 'doc-ups', title: 'Management agreement', file_path: 'contracts/ups.pdf' }],
    vendor_contracts: [
      { ...UPS, community_id: CID, forecast_account_id: 'a5810', forecast_fund_id: null },
      // NOT bound to any line: the old route matched it to 5200 by the vendor name and added 4%.
      { id: 'vc-earth', community_id: CID, vendor_name_raw: 'Earthcare Landscaping', status: 'active', execution_status: 'detected', annualized_amount: 100000, escalator_kind: 'none', periodic_amount: 8333.33, periodic_frequency: 'monthly', effective_date: `${BY}-01-01`, forecast_account_id: null, file_path: 'contracts/earth.pdf' },
      // Bound but not verified: shown, never applied.
      { id: 'vc-pool', community_id: CID, vendor_name_raw: 'Aegis Aquatics', status: 'active', execution_status: 'likely_executed', periodic_amount: 5000, periodic_frequency: 'monthly', effective_date: `${BY}-01-01`, forecast_account_id: 'a5300', file_path: 'contracts/pool.pdf' },
    ] };
  for (const [n, c] of [[4000, 12000000], [5810, 6000000], [5200, 9000000], [5300, 5500000]]) db.budget_line_items.push({ id: `bl-${n}`, budget_id: 'b-base', account_id: `a${n}`, fund_id: null, annual_amount_cents: c, monthly_amounts_cents: even(c) });
  for (let m = 1; m <= 12; m++) {
    const d = `${BY}-${String(m).padStart(2, '0')}-15`;
    je(`ASM-${m}`, d, [[1000, 1000000, 0], [4000, 0, 1000000]]);
    je(`MGT-${m}`, d, [[5810, 500000, 0], [1000, 0, 500000]]);
    je(`LAND-${m}`, d, [[5200, 750000, 0, 'v-earth'], [1000, 0, 750000]]);
    je(`POOL-${m}`, d, [[5300, 450000, 0], [1000, 0, 450000]]);
  }
}
let base;
const call = async (method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); assert.ok(!/NaN/.test(text), `no NaN: ${text.slice(0, 300)}`); return { status: r.status, body: JSON.parse(text) }; };
const living = () => call('GET', `/api/books/budgets/living-lines?community_id=${CID}&fiscal_year=${FY}`);
const rowOf = (j, n) => j.rows.find((x) => x.account_number === String(n));

t('living-lines: the verified contract line is priced at the working forecast\'s contract amount (no +4%, no name match)', async () => {
  world();
  const { status, body } = await living();
  assert.strictEqual(status, 200, JSON.stringify(body).slice(0, 400));
  assert.strictEqual(body.forecast_basis.basis, 'working_forecast', JSON.stringify(body.forecast_basis));
  const mgt = rowOf(body, 5810);
  assert.deepStrictEqual([mgt.source_type, mgt.proposed_cents], ['contract', contractCostForYear(UPS, FY).annual_cents]);
  assert.strictEqual(mgt.proposed_cents, 6240000);
  assert.ok(/United Protective Services: Jan-Dec: \$5,200\.00 monthly/.test(mgt.built_from), mgt.built_from);
  assert.ok(mgt.evidence.some((e) => /contracts\/ups\.pdf/.test(e.url)), 'the contract document is linked');
  // The same number the working forecast carries for that line.
  const wf = await call('GET', `/api/working-forecast/${CID}?year=${FY}&as_of=${BY}-12-31`);
  const wl = wf.body.lines.find((l) => l.account_number === '5810');
  assert.strictEqual(mgt.proposed_cents, wl.recommendation_cents, 'one contract engine: screen = forecast');
});

t('living-lines: a contract NOT bound to the line never prices it by vendor name; the recurring vendor is flagged as a missing contract', async () => {
  world();
  const { body } = await living();
  const land = rowOf(body, 5200);
  assert.notStrictEqual(land.source_type, 'contract', land.built_from);
  assert.notStrictEqual(land.proposed_cents, Math.round(100000 * 100 * 1.04), 'the old name match + 4% is gone');
  assert.strictEqual(land.contract, null);
  const f = land.flags.find((x) => x.type === 'contract_missing');
  assert.ok(f && f.msg.includes('Earthcare Landscaping ($90,000 over 12 months)'), JSON.stringify(land.flags));
});

t('living-lines: ONE engine: every line suggestion is the working forecast final amount (no planner percentage)', async () => {
  world();
  const { body } = await living();
  const wf = await call('GET', `/api/working-forecast/${CID}?year=${FY}&as_of=${BY}-12-31`);
  for (const n of ['4000', '5810', '5200', '5300']) {
    const r = rowOf(body, n); const w = wf.body.lines.find((l) => l.account_number === n);
    assert.strictEqual(r.proposed_cents, w.final_cents, `${n}: planner ${r.proposed_cents} vs forecast ${w.final_cents}`);
  }
  const land = rowOf(body, 5200);
  assert.ok(land.flags.some((f) => f.type === 'needs_review' && /unconfirmed default assumption/.test(f.msg)), 'the default inflation is flagged, never silent');
});

t('living-lines: a bound but unverified contract is priced from its terms and flagged (never dropped to a percentage)', async () => {
  world();
  const { body } = await living();
  const pool = rowOf(body, 5300);
  assert.deepStrictEqual([pool.source_type, pool.proposed_cents, pool.contract.unverified], ['contract', 6000000, true]);
  const f = pool.flags.find((x) => x.type === 'needs_review');
  assert.ok(f && f.severity === 'high' && /Aegis Aquatics is priced from its terms but is likely executed, not verified/.test(f.msg), JSON.stringify(pool.flags));
  assert.ok(pool.evidence.some((e) => /not verified/.test(e.label) && e.url.includes('pool.pdf')));
});

t('draft-budget: creates the draft with each line\'s basis; the contract line carries its contract and document', async () => {
  world();
  const r = await call('POST', `/api/working-forecast/${CID}/draft-budget`, { year: FY, as_of: `${BY}-12-31` });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'draft_created');
  const lines = db.budget_line_items.filter((l) => l.budget_id === r.body.budget_id);
  const mgt = lines.find((l) => l.account_id === 'a5810');
  assert.deepStrictEqual([mgt.annual_amount_cents, mgt.amount_basis, mgt.vendor_contract_id, mgt.source_document_id, mgt.needs_review], [6240000, 'contract', 'vc-ups', 'doc-ups', false]);
  assert.strictEqual(mgt.monthly_amounts_cents.reduce((a, b) => a + b, 0), mgt.annual_amount_cents);
  assert.strictEqual(lines.find((l) => l.account_id === 'a4000').amount_basis, 'assessment');
  const pool = lines.find((l) => l.account_id === 'a5300');
  assert.deepStrictEqual([pool.amount_basis, pool.vendor_contract_id, pool.needs_review, pool.annual_amount_cents], ['contract', 'vc-pool', true, 6000000]);
  // The planner then shows the recorded basis with the saved amount.
  const { body } = await living();
  assert.deepStrictEqual([rowOf(body, 5810).proposed_source, rowOf(body, 5810).saved_basis.amount_basis], ['saved_draft', 'contract']);
  assert.strictEqual(rowOf(body, 5810).saved_basis.source_document.url, 'https://signed/contracts/ups.pdf');
});

t('draft-budget on an existing draft: writes the basis only; no amount changes; an unexplained amount needs review', async () => {
  world();
  db.community_budgets.push({ id: 'b-draft', community_id: CID, fiscal_year: FY, status: 'draft', created_at: 'x' });
  db.budget_line_items.push({ id: 'd-5810', budget_id: 'b-draft', account_id: 'a5810', annual_amount_cents: 6240000, monthly_amounts_cents: even(6240000), notes: 'kept', needs_review: false },
    { id: 'd-5200', budget_id: 'b-draft', account_id: 'a5200', annual_amount_cents: 10611600, monthly_amounts_cents: even(10611600), notes: 'kept', needs_review: false });
  const before = JSON.stringify(db.budget_line_items.filter((l) => l.budget_id === 'b-draft').map((l) => [l.annual_amount_cents, l.monthly_amounts_cents, l.notes]));
  const r = await call('POST', `/api/working-forecast/${CID}/draft-budget`, { year: FY, as_of: `${BY}-12-31` });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.mode, r.body.amounts_changed], ['basis_refreshed', 0]);
  const after = db.budget_line_items.filter((l) => l.budget_id === 'b-draft');
  assert.strictEqual(JSON.stringify(after.map((l) => [l.annual_amount_cents, l.monthly_amounts_cents, l.notes])), before, 'amounts, months and notes unchanged');
  assert.strictEqual(after.find((l) => l.id === 'd-5810').amount_basis, 'contract');
  const land = after.find((l) => l.id === 'd-5200');
  assert.deepStrictEqual([land.amount_basis, land.needs_review], [null, true]);
  assert.ok(/saved amount \$106,116\.00 is not the working forecast's/.test(land.review_note), land.review_note);
  assert.strictEqual(db.community_budgets.filter((b) => b.fiscal_year === FY).length, 1, 'no second budget');
});

t('draft-budget: an approved budget for the year is refused and untouched', async () => {
  world();
  db.community_budgets.push({ id: 'b-appr', community_id: CID, fiscal_year: FY, status: 'approved', created_at: 'x' });
  db.budget_line_items.push({ id: 'ap-1', budget_id: 'b-appr', account_id: 'a5810', annual_amount_cents: 1, monthly_amounts_cents: even(1), needs_review: false });
  const r = await call('POST', `/api/working-forecast/${CID}/draft-budget`, { year: FY, as_of: `${BY}-12-31` });
  assert.deepStrictEqual([r.status, r.body.error], [409, 'budget_locked']);
  assert.strictEqual(db.budget_line_items.find((l) => l.id === 'ap-1').amount_basis, undefined);
});

t('static: living-lines no longer matches contracts by vendor name or applies a renewal escalation to them', () => {
  const src = require('fs').readFileSync(require.resolve('../api/books.js'), 'utf8');
  const ll = src.slice(src.indexOf("router.get('/budgets/living-lines'"), src.indexOf('// Undeposited Funds workflow'));
  assert.ok(!/management_vendor_name|vendorMatches|contract\.cents \* \(1 \+ escP\)/.test(ll), 'no name matching / +ESC on contracts');
});

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const origErr = console.error, origWarn = console.warn; console.error = () => {}; console.warn = () => {};
  let passed = 0, failed = 0;
  for (const { name, fn } of results) {
    try { await fn(); origWarn('  ✓', name); passed++; } catch (e) { origErr('  ✗', name, '\n      ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e); failed++; }
  }
  console.error = origErr; console.warn = origWarn;
  server.close();
  console.log(`\nbudget_line_basis: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
