#!/usr/bin/env node
// ============================================================================
// tests/test_data_readiness.js  (Issue #6, Communities + Data Readiness)
// ----------------------------------------------------------------------------
// Locks the readiness rules in lib/community/data_readiness.js evaluate():
//   - a failed read is "error", never "not imported";
//   - lifecycle decides not_applicable (leaving / prospect / financials off /
//     books in Vantaca / enforcement off);
//   - "ready" only where a stored control proves it; presence alone is
//     "imported · not verified";
//   - owner ledger conversion and GL are separate (GL cutover ≠ conversion);
//   - an unconverted community's AR is never compared to the GL.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { S, evaluate } = require('../lib/community/data_readiness');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const ok = (value) => ({ ok: true, value });
const NOW = '2026-09-29T15:00:00Z';
const community = (over) => Object.assign({
  id: 'c1', name: 'Test', legal_name: 'Test HOA', ein: '12-3456789', county: 'Harris', vantaca_code: 'TST', total_lots: 100,
  management_status: 'active', financials_active: true, enforcement_active: true, books_of_record: 'trusted', gl_cutover_date: '2026-08-01',
}, over);
const facts = (over) => Object.assign({
  propertyCount: ok(100), ownedProperties: ok(100),
  conversion: ok({ batches: [{ id: 'b1', batch_code: 'CONV-1', as_of_date: '2026-07-31', status: 'posted' }], latestRun: { all_pass: true }, openExceptions: 0 }),
  ar: ok({ accounts: 90, subledger_cents: 500000, gl_1300_2400_net_cents: 500000, diff_cents: 0, conversion: { ready: true }, ties: true }),
  arLatestImport: ok('2026-08-31'),
  gl: ok({ coa: 60, je: 300, debits: 1000, credits: 1000 }),
  budget: ok({ status: 'approved', lines: 40 }),
  bank: ok({ accounts: [{ id: 'a1', name: 'Operating', latest: { period_end: '2026-08-31', status: 'reconciled', difference_cents: 0 } }] }),
  violations: ok({ total: 500, vantaca: 200 }),
  vendors: ok(12),
  documents: ok({ current: [{ category: 'declaration_ccrs', index_status: 'indexed' }], required: [{ category: 'declaration_ccrs', display_name: 'Declaration' }], failedIndex: 0, pendingIndex: 0 }),
  board: ok({ members: 5, contacts: 8 }),
  insurance: ok([{ expiration_date: '2027-03-01' }]),
}, over);
const area = (r, key) => r.areas.find((a) => a.key === key);

console.log('test_data_readiness');

t('fully proven community: ready where controls exist, not_verified where they cannot', () => {
  const r = evaluate(community(), facts(), NOW);
  for (const k of ['profile', 'properties', 'ledger', 'ar', 'budget', 'bank', 'insurance']) assert.strictEqual(area(r, k).status, S.READY, k);
  for (const k of ['gl', 'violations', 'vendors', 'board', 'documents']) assert.strictEqual(area(r, k).status, S.NOT_VERIFIED, k + ' must never be green without a stored control');
  assert.strictEqual(r.needs_action, 0);
});

t('a failed read is error, never not_imported', () => {
  const r = evaluate(community(), facts({ violations: { ok: false, error: 'permission denied' }, propertyCount: { ok: false, error: 'timeout' } }), NOW);
  assert.strictEqual(area(r, 'violations').status, S.ERROR);
  assert.strictEqual(area(r, 'properties').status, S.ERROR);
});

t('leaving community (Eaglewood): every area not applicable, nothing needs action', () => {
  const r = evaluate(community({ management_status: 'terminating', management_end_date: '2026-09-30', books_of_record: 'vantaca', financials_active: false }), facts({ propertyCount: ok(0) }), NOW);
  assert.ok(r.areas.every((a) => a.status === S.NA));
  assert.strictEqual(r.needs_action, 0);
  assert.ok(/Leaving Bedrock \(last day 2026-09-30\)/.test(area(r, 'violations').summary));
});

t('prospect: not applicable, not "not imported"', () => {
  const r = evaluate(community({ management_status: 'prospect' }), facts({ propertyCount: ok(0) }), NOW);
  assert.ok(r.areas.every((a) => a.status === S.NA));
});

t('books in Vantaca: financial areas not applicable, operations still evaluated', () => {
  const r = evaluate(community({ books_of_record: 'vantaca' }), facts(), NOW);
  for (const k of ['ledger', 'ar', 'gl', 'budget', 'bank']) assert.strictEqual(area(r, k).status, S.NA, k);
  assert.strictEqual(area(r, 'violations').status, S.NOT_VERIFIED);
});

t('enforcement off: violations not applicable only', () => {
  const r = evaluate(community({ enforcement_active: false }), facts(), NOW);
  assert.strictEqual(area(r, 'violations').status, S.NA);
  assert.strictEqual(area(r, 'budget').status, S.READY);
});

t('GL cutover without a posted conversion: ledger not_imported, AR never compared', () => {
  const r = evaluate(community(), facts({
    conversion: ok({ batches: [], latestRun: null, openExceptions: 0 }),
    ar: ok({ accounts: 90, subledger_cents: 500000, gl_1300_2400_net_cents: 900000, diff_cents: -400000, conversion: { ready: false }, ties: false }),
  }), NOW);
  assert.strictEqual(area(r, 'ledger').status, S.NOT_IMPORTED);
  assert.strictEqual(area(r, 'ar').status, S.NOT_RECONCILED);
  assert.ok(!/difference/.test(area(r, 'ar').summary), 'unconverted AR must not show a GL difference');
  assert.strictEqual(area(r, 'gl').status, S.NOT_VERIFIED, 'GL stands on its own');
});

t('posted conversion + 0 open exceptions → ready, no action', () => {
  const r = evaluate(community(), facts(), NOW);
  assert.strictEqual(area(r, 'ledger').status, S.READY);
  assert.strictEqual(r.needs_action, 0);
});

t('posted conversion + open exceptions → partial and counted in needs_action (never quiet ready)', () => {
  const r = evaluate(community(), facts({ conversion: ok({ batches: [{ batch_code: 'CONV-1', as_of_date: '2026-07-31', status: 'posted' }], latestRun: { all_pass: true }, openExceptions: 2 }) }), NOW);
  assert.strictEqual(area(r, 'ledger').status, S.PARTIAL);
  assert.strictEqual(r.needs_action, 1);
  assert.ok(/2 conversion exceptions still open/.test(area(r, 'ledger').summary));
});

t('documents: full required set present + indexed is not_verified, not ready (no Vantaca manifest)', () => {
  const d = area(evaluate(community(), facts(), NOW), 'documents');
  assert.strictEqual(d.status, S.NOT_VERIFIED);
  assert.ok(d.missing.some((m) => /Vantaca document list/.test(m)));
});

t('posted conversion + AR difference → error with the difference', () => {
  const r = evaluate(community(), facts({ ar: ok({ accounts: 90, subledger_cents: 500001, gl_1300_2400_net_cents: 500000, diff_cents: 1, conversion: { ready: true }, ties: false }) }), NOW);
  assert.strictEqual(area(r, 'ar').status, S.ERROR);
  assert.ok(/difference \$0\.01/.test(area(r, 'ar').summary));
});

t('conversion staged with a failing control run → imported_not_reconciled', () => {
  const r = evaluate(community(), facts({ conversion: ok({ batches: [{ batch_code: 'C', status: 'staged' }], latestRun: { all_pass: false }, openExceptions: 3 }) }), NOW);
  assert.strictEqual(area(r, 'ledger').status, S.NOT_RECONCILED);
  assert.deepStrictEqual(area(r, 'ledger').missing, ['3 open exceptions']);
});

t('lot count unknown → properties not verified, never ready', () => {
  const r = evaluate(community({ total_lots: null }), facts(), NOW);
  assert.strictEqual(area(r, 'properties').status, S.NOT_VERIFIED);
  assert.ok(area(r, 'profile').missing.includes('Lot count'));
});

t('properties without a current owner → partial', () => {
  const r = evaluate(community(), facts({ ownedProperties: ok(97) }), NOW);
  assert.strictEqual(area(r, 'properties').status, S.PARTIAL);
});

t('trial balance out of balance → error; no cutover date → partial', () => {
  assert.strictEqual(area(evaluate(community(), facts({ gl: ok({ coa: 1, je: 1, debits: 100, credits: 99 }) }), NOW), 'gl').status, S.ERROR);
  assert.strictEqual(area(evaluate(community({ gl_cutover_date: null }), facts(), NOW), 'gl').status, S.PARTIAL);
});

t('bank: in-progress rec is partial with its date; unbalanced is error with the amount', () => {
  const partial = evaluate(community(), facts({ bank: ok({ accounts: [{ name: 'Op', latest: { period_end: '2026-05-29', status: 'in_progress', difference_cents: null } }] }) }), NOW);
  assert.strictEqual(area(partial, 'bank').status, S.PARTIAL);
  assert.ok(/in progress \(latest 2026-05-29\)/.test(area(partial, 'bank').missing[0]));
  const bad = evaluate(community(), facts({ bank: ok({ accounts: [{ name: 'Op', latest: { period_end: '2026-04-30', status: 'unbalanced', difference_cents: 42812 } }] }) }), NOW);
  assert.strictEqual(area(bad, 'bank').status, S.ERROR);
  assert.ok(/off \$428\.12/.test(area(bad, 'bank').missing[0]));
});

t('violations: native only is not_imported for Vantaca history', () => {
  assert.strictEqual(area(evaluate(community(), facts({ violations: ok({ total: 20, vantaca: 0 }) }), NOW), 'violations').status, S.NOT_IMPORTED);
});

t('documents: missing required category → partial; failed index → error', () => {
  const missing = evaluate(community(), facts({ documents: ok({ current: [{ category: 'bylaws', index_status: 'indexed' }], required: [{ category: 'declaration_ccrs', display_name: 'Declaration' }], failedIndex: 0, pendingIndex: 0 }) }), NOW);
  assert.strictEqual(area(missing, 'documents').status, S.PARTIAL);
  assert.deepStrictEqual(area(missing, 'documents').missing, ['Declaration']);
  assert.strictEqual(area(evaluate(community(), facts({ documents: ok({ current: [{ category: 'x' }], required: [], failedIndex: 1, pendingIndex: 0 }) }), NOW), 'documents').status, S.ERROR);
});

t('insurance: all expired → error', () => {
  assert.strictEqual(area(evaluate(community(), facts({ insurance: ok([{ expiration_date: '2026-01-01' }]) }), NOW), 'insurance').status, S.ERROR);
});

t('budget draft → in progress; none → not imported', () => {
  assert.strictEqual(area(evaluate(community(), facts({ budget: ok({ status: 'draft', lines: 10 }) }), NOW), 'budget').status, S.IN_PROGRESS);
  assert.strictEqual(area(evaluate(community(), facts({ budget: ok(null) }), NOW), 'budget').status, S.NOT_IMPORTED);
});

t('worst status and needs_action roll up', () => {
  const r = evaluate(community(), facts({ gl: ok({ coa: 1, je: 1, debits: 2, credits: 1 }), vendors: ok(0) }), NOW);
  assert.strictEqual(r.worst, S.ERROR);
  assert.strictEqual(r.needs_action, 2);
});

// ---- fetchFacts bank read: latest rec per active account, no shared cap ----
// Generic in-memory PostgREST fake: eq / in / order / range / limit / head count.
function fakeDb(tables) {
  return {
    from(table) {
      const st = { eq: [], inF: [], order: [], from: 0, to: Infinity, head: false };
      const rows = () => {
        let r = (tables[table] || []).filter((x) => st.eq.every(([k, v]) => x[k] === v) && st.inF.every(([k, vs]) => vs.includes(x[k])));
        for (const [k, asc] of st.order.slice().reverse()) r = r.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1));
        return r;
      };
      const q = {
        select(_c, opts) { if (opts && opts.head) st.head = true; return q; },
        eq(k, v) { st.eq.push([k, v]); return q; }, in(k, vs) { st.inF.push([k, vs]); return q; },
        not() { return q; }, is() { return q; }, gte() { return q; },
        order(k, o) { st.order.push([k, !o || o.ascending !== false]); return q; },
        range(a, b) { st.from = a; st.to = b; return q; }, limit(n) { st.to = st.from + n - 1; return q; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        then(res, rej) {
          const all = rows();
          const out = st.head ? { data: null, count: all.length, error: null } : { data: all.slice(st.from, st.to + 1), error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
}

(async () => {
  const { fetchFacts } = require('../lib/community/data_readiness');
  const busy = Array.from({ length: 600 }, (_, i) => ({ community_id: 'c1', bank_account_id: 'A', period_end: `20${10 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-28`, status: 'reconciled', difference_cents: 0 }));
  const db = fakeDb({
    bank_accounts: [{ id: 'A', community_id: 'c1', account_nickname: 'Busy', is_active: true }, { id: 'B', community_id: 'c1', account_nickname: 'Quiet', is_active: true }],
    bank_reconciliations: busy.concat([{ community_id: 'c1', bank_account_id: 'B', period_end: '2009-01-31', status: 'unbalanced', difference_cents: 500 }]),
  });
  const f = await fetchFacts(db, community(), NOW);
  t('bank: every active account gets its own latest rec, even behind 600 rows of another account', () => {
    assert.ok(f.bank.ok, f.bank.error);
    const quiet = f.bank.value.accounts.find((a) => a.name === 'Quiet');
    assert.ok(quiet && quiet.latest, 'Quiet account latest rec must not be dropped by a shared cap');
    assert.strictEqual(quiet.latest.status, 'unbalanced');
    assert.strictEqual(area(evaluate(community(), facts({ bank: f.bank }), NOW), 'bank').status, S.ERROR);
  });
  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
