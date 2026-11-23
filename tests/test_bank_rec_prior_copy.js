// A re-run never silently overwrites a saved reconciliation (Ed 2026-11-21):
// the prior header and EVERY prior item go into the run's event log first, and if
// that record can't be written, nothing is replaced.
const assert = require('assert');
const { storeReconciliation } = require('../lib/banking/monthly_rec');

function fakeDb(tables, { failEventInsert = false } = {}) {
  const log = [];
  const db = {
    log,
    from(table) {
      const st = { op: 'select', eq: [], neq: [], inF: [], from: 0, to: Infinity, payload: null };
      const rows = () => (tables[table] || []).filter((x) => st.eq.every(([k, v]) => x[k] === v) && st.neq.every(([k, v]) => x[k] !== v) && st.inF.every(([k, vs]) => vs.includes(x[k])));
      const run = () => {
        if (st.op === 'insert') {
          log.push({ table, op: 'insert', payload: st.payload });
          if (table === 'accounting_run_events' && failEventInsert) return { data: null, error: { message: 'events table down' } };
          const list = Array.isArray(st.payload) ? st.payload : [st.payload];
          const made = list.map((p, i) => ({ id: p.id || `${table}-new-${(tables[table] || []).length + i}`, ...p }));
          tables[table] = (tables[table] || []).concat(made);
          return { data: Array.isArray(st.payload) ? made : made[0], error: null };
        }
        if (st.op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, st.payload)); log.push({ table, op: 'update', payload: st.payload, n: hit.length }); return { data: hit, error: null }; }
        if (st.op === 'delete') { const hit = rows(); tables[table] = (tables[table] || []).filter((r) => !hit.includes(r)); log.push({ table, op: 'delete', n: hit.length }); return { data: hit, error: null }; }
        return { data: rows().slice(st.from, st.to + 1), error: null };
      };
      const q = {
        select() { return q; }, insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
        eq(k, v) { st.eq.push([k, v]); return q; }, neq(k, v) { st.neq.push([k, v]); return q; }, in(k, vs) { st.inF.push([k, vs]); return q; },
        lte() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; }, range(a, b) { st.from = a; st.to = b; return q; },
        single() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }); },
        maybeSingle() { return q.single(); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
  return db;
}

const priorItems = Array.from({ length: 1205 }, (_, i) => ({ id: `it${i}`, reconciliation_id: 'rec1', category: i % 2 ? 'outstanding_check' : 'matched', amount_cents: -100 - i, description: `line ${i}` }));
const world = () => ({
  communities: [{ id: 'C', management_company_id: 'M' }],
  bank_accounts: [{ id: 'BA', community_id: 'C', gl_account_number: '1000' }],
  bank_reconciliations: [{ id: 'rec1', community_id: 'C', bank_account_id: 'BA', period_end: '2026-08-31', status: 'reconciled', difference_cents: 0, gl_ending_balance_cents: 500, bank_ending_balance_cents: 500, prepared_at: '2026-10-14T00:00:00Z', notes: 'approved workpaper' }],
  bank_reconciliation_items: priorItems.map((x) => ({ ...x })),
});
const r = {
  account: { id: 'BA' }, period_start: '2026-08-01', period_end: '2026-08-31', statement: { id: 'S' }, status: 'in_progress',
  totals: { bank_ending_cents: 500, gl_ending_cents: 900, outstanding_checks_cents: 0, deposits_in_transit_cents: 0, bank_only_cents: 400, manual_adjustments_cents: 0, adjusted_bank_cents: 500, difference_cents: 0 },
  exceptions: [{ severity: 'open', text: 'x' }], items: [{ category: 'bank_only', amount_cents: 400, description: 'new' }], proposals: [], cleared_since_prior: [], voided_since_prior: [],
};

(async () => {
  // 1) prior kept whole, then replaced
  const t1 = world(); const db = fakeDb(t1);
  const out = await storeReconciliation(db, { community_id: 'C', r, run_id: 'RUN', actor: 'test' });
  const ev = db.log.find((l) => l.table === 'accounting_run_events');
  assert.ok(ev, 'an event records the prior copy');
  assert.strictEqual(ev.payload.event, 'note');
  assert.strictEqual(ev.payload.detail.kind, 'reconciliation_replaced');
  assert.strictEqual(ev.payload.detail.prior.notes, 'approved workpaper', 'the whole prior header is kept');
  assert.strictEqual(ev.payload.detail.prior_item_rows.length, 1205, 'every prior item is kept (no 1,000-row cap)');
  assert.ok(ev.payload.detail.changes.some((c) => c.field === 'gl_ending_balance_cents' && c.was === 500 && c.now === 900));
  const evIdx = db.log.indexOf(ev), upIdx = db.log.findIndex((l) => l.table === 'bank_reconciliations' && l.op === 'update');
  assert.ok(evIdx >= 0 && upIdx > evIdx, 'the prior copy is recorded BEFORE the reconciliation is replaced');
  assert.strictEqual(out.replaced, true);

  // 2) prior copy can't be written -> nothing replaced
  const t2 = world(); const db2 = fakeDb(t2, { failEventInsert: true });
  await assert.rejects(() => storeReconciliation(db2, { community_id: 'C', r, run_id: 'RUN', actor: 'test' }), /record the prior reconciliation/);
  assert.ok(!db2.log.some((l) => l.table === 'bank_reconciliations' && l.op === 'update'), 'no update when the prior copy failed');
  assert.ok(!db2.log.some((l) => l.table === 'bank_reconciliation_items' && l.op === 'delete'), 'no item delete when the prior copy failed');
  assert.strictEqual(t2.bank_reconciliation_items.length, 1205, 'prior items untouched');

  console.log('test_bank_rec_prior_copy: ok');
})().catch((e) => { console.error(e); process.exit(1); });
