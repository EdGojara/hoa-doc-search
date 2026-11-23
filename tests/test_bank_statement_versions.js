// Bank statements are evidence (Ed 2026-11-21). Through the real upload routes:
//   1. a corrected statement supersedes the original (voided, kept with all its lines);
//   2. a failed replacement leaves the original active and unchanged;
//   3. the identical file is a duplicate and writes nothing;
//   4. an approved reconciliation still opens the exact original statement and lines,
//      and reads Stale, without its own record being changed.
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

let tables, failTxInsert = false;
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

function fakeClient() {
  return {
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) },
    from(table) {
      const st = { op: 'select', eq: [], neq: [], inF: [], from: 0, to: Infinity, payload: null, head: false };
      const match = (x) => st.eq.every(([k, v]) => x[k] === v) && st.neq.every(([k, v]) => x[k] !== v) && st.inF.every(([k, vs]) => vs.includes(x[k]));
      const run = () => {
        const all = tables[table] || (tables[table] = []);
        if (st.op === 'insert') {
          if (table === 'bank_statement_transactions' && failTxInsert) return { data: null, error: { message: 'simulated write failure' } };
          const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p, i) => ({ id: p.id || `${table}-${all.length + i + 1}`, ...JSON.parse(JSON.stringify(p)) }));
          all.push(...list);
          return { data: Array.isArray(st.payload) ? list : list[0], error: null };
        }
        if (st.op === 'update') { const hit = all.filter(match); hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(st.payload)))); return { data: hit, error: null }; }
        if (st.op === 'delete') { const hit = all.filter(match); tables[table] = all.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
        const rows = all.filter(match);
        if (st.head) return { data: null, count: rows.length, error: null };
        return { data: rows.slice(st.from, st.to + 1), error: null };
      };
      const q = {
        select(_c, o) { if (o && o.head) st.head = true; return q; },
        insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
        eq(k, v) { st.eq.push([k, v]); return q; }, neq(k, v) { st.neq.push([k, v]); return q; }, in(k, vs) { st.inF.push([k, vs]); return q; },
        lte() { return q; }, gte() { return q; }, gt() { return q; }, lt() { return q; }, order() { return q; }, limit(n) { st.to = st.from + n - 1; return q; }, range(a, b) { st.from = a; st.to = b; return q; },
        single() { const r = run(); const d = Array.isArray(r.data) ? r.data[0] : r.data; return Promise.resolve({ data: d || null, error: r.error || (d ? null : { message: 'no rows' }) }); },
        maybeSingle() { const r = run(); return Promise.resolve({ data: (Array.isArray(r.data) ? r.data[0] : r.data) || null, error: r.error }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

// Stub the database client, the PDF extractor and the post-import hooks before the router loads.
const stub = (rel, exports) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
const sbPath = require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '..')] });
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => fakeClient() } };
let nextExtraction = null;
stub('lib/banking/extractors/bank_statement.js', { extract: async () => nextExtraction });
stub('lib/banking/positive_pay_watch.js', { tick: async () => ({}) });
const realRuns = require('../lib/accounting/monthly_runs');
realRuns.onStatementImported = async () => ({ stubbed: true });
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake';
const { router } = require('../api/bank_rec');
const handler = (method, p) => { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods[method]); return l.route.stack[l.route.stack.length - 1].handle; };
const call = (method, p, req) => new Promise((done) => handler(method, p)({ query: {}, params: {}, ...req }, { _s: 200, status(c) { this._s = c; return this; }, json(d) { done({ status: this._s, body: d }); }, send(d) { done({ status: this._s, body: d }); } }));
const upload = (bytes) => call('post', '/accounts/:accountId/bank-statement', { params: { accountId: 'BA' }, file: { buffer: Buffer.from(bytes), mimetype: 'application/pdf', originalname: 'oct.pdf', size: bytes.length } });

function world() {
  return {
    communities: [{ id: 'C', management_company_id: 'M', gl_cutover_date: '2026-08-01' }],
    bank_accounts: [{ id: 'BA', community_id: 'C', account_nickname: 'Operating', account_last4: '0001', gl_account_number: '1000' }],
    bank_statement_imports: [{ id: 'P', community_id: 'C', bank_account_id: 'BA', statement_period_start: '2026-10-01', statement_period_end: '2026-10-30', ending_balance_cents: 100000, source_sha256: sha('ORIGINAL'), source_filename: 'oct-original.pdf', status: 'completed', extraction_warnings: [] }],
    bank_statement_transactions: [1, 2, 3].map((i) => ({ id: `PL${i}`, bank_statement_import_id: 'P', posting_date: `2026-10-0${i}`, amount_cents: 1000 * i, description: `original line ${i}` })),
    bank_reconciliations: [{ id: 'R', community_id: 'C', bank_account_id: 'BA', period_end: '2026-10-31', status: 'reconciled', difference_cents: 0, gl_ending_balance_cents: 100000, bank_ending_balance_cents: 100000, bank_statement_import_id: 'P', prepared_at: '2026-11-10T00:00:00Z' }],
    bank_reconciliation_items: [{ id: 'I1', reconciliation_id: 'R', category: 'matched', amount_cents: 1000, bank_transaction_id: 'PL1' }],
    accounting_runs: [{ id: 'RUN', process: 'bank_reconciliation', status: 'posted', subject_id: 'BA', period_month: '2026-10-01' }],
    chart_of_accounts: [], journal_entry_lines: [],
  };
}
const corrected = { period_start: '2026-10-01', period_end: '2026-10-30', ending_balance_cents: 100500, transactions: [{ posting_date: '2026-10-01', amount_cents: 1000, description: 'corrected 1' }, { posting_date: '2026-10-02', amount_cents: 2500, description: 'corrected 2' }], warnings: [] };
const active = () => tables.bank_statement_imports.filter((x) => x.bank_account_id === 'BA' && x.statement_period_end === '2026-10-30' && x.status === 'completed');

(async () => {
  // 1) successful replacement
  tables = world(); nextExtraction = corrected; failTxInsert = false;
  let r = await upload('CORRECTED');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const newId = r.body.bank_statement_import.id;
  assert.deepStrictEqual(r.body.superseded_statement_ids, ['P']);
  const P = tables.bank_statement_imports.find((x) => x.id === 'P');
  assert.strictEqual(P.status, 'voided', 'original superseded, not deleted');
  assert.ok(P.extraction_warnings.some((w) => w.includes(newId)), 'original names the statement that replaced it');
  assert.strictEqual(tables.bank_statement_transactions.filter((x) => x.bank_statement_import_id === 'P').length, 3, 'every original line kept');
  assert.strictEqual(tables.bank_statement_transactions.filter((x) => x.bank_statement_import_id === newId).length, 2);
  assert.deepStrictEqual(active().map((x) => x.id), [newId], 'only the corrected statement is active');
  const R = tables.bank_reconciliations.find((x) => x.id === 'R');
  assert.strictEqual(R.bank_statement_import_id, 'P', 'approved reconciliation still points at the original');
  assert.strictEqual(R.status, 'reconciled', 'its stored record is not altered');

  // 4) the approved reconciliation still opens the exact original statement + lines, and reads Stale
  r = await call('get', '/reconciliations/:id', { params: { id: 'R' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.sources.bank_statement.id, 'P');
  assert.strictEqual(r.body.sources.bank_statement.status, 'voided');
  assert.deepStrictEqual(r.body.sources.bank_statement_lines.map((x) => x.id).sort(), ['PL1', 'PL2', 'PL3']);
  assert.strictEqual(r.body.reconciliation.standing, 'stale', JSON.stringify(r.body.reconciliation.standing_reasons));
  assert.ok(r.body.reconciliation.standing_reasons.some((x) => /superseded by a corrected statement/.test(x)));

  // 2) failed replacement: original stays active and unchanged
  tables = world(); nextExtraction = corrected; failTxInsert = true;
  const before = JSON.stringify(tables.bank_statement_imports.find((x) => x.id === 'P'));
  r = await upload('CORRECTED');
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.error, 'statement_not_saved');
  assert.strictEqual(JSON.stringify(tables.bank_statement_imports.find((x) => x.id === 'P')), before, 'original unchanged');
  assert.deepStrictEqual(active().map((x) => x.id), ['P'], 'the original is still the only active statement');
  assert.ok(tables.bank_statement_imports.some((x) => x.id !== 'P' && x.status === 'failed'), 'half-written correction marked failed');
  assert.strictEqual(tables.bank_statement_transactions.filter((x) => x.bank_statement_import_id === 'P').length, 3);
  assert.strictEqual(tables.bank_reconciliations.find((x) => x.id === 'R').bank_statement_import_id, 'P');

  // 3) duplicate upload of the identical file writes nothing
  tables = world(); nextExtraction = corrected; failTxInsert = false;
  const counts = () => [tables.bank_statement_imports.length, tables.bank_statement_transactions.length];
  const c0 = counts();
  r = await upload('ORIGINAL');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.duplicate, true);
  assert.deepStrictEqual(counts(), c0, 'no rows written');
  assert.strictEqual(tables.bank_statement_imports.find((x) => x.id === 'P').status, 'completed');

  // per-reconciliation upload: supersedes too, and never repoints an approved reconciliation
  tables = world(); nextExtraction = corrected; failTxInsert = false;
  r = await call('post', '/reconciliations/:id/bank-statement', { params: { id: 'R' }, file: { buffer: Buffer.from('CORRECTED-2'), mimetype: 'application/pdf', originalname: 'oct2.pdf', size: 11 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.linked_to_reconciliation, false);
  assert.strictEqual(tables.bank_reconciliations.find((x) => x.id === 'R').bank_statement_import_id, 'P');
  assert.strictEqual(tables.bank_statement_imports.find((x) => x.id === 'P').status, 'voided');
  assert.strictEqual(active().length, 1, 'never two active statements for one month');

  console.log('test_bank_statement_versions: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
