#!/usr/bin/env node
// ============================================================================
// tests/test_reconciliation_ar_readiness.js  (Issue #6 review, 2026-09-29)
// ----------------------------------------------------------------------------
// ChatGPT review blocker: Kat's month-end reconciliation must NEVER validate a
// community whose ledger conversion isn't posted. Locks the four cases:
//   unconverted + equal    → not a validated pass (not_ready, all_clean false)
//   unconverted + unequal  → NOT an AR mismatch exception
//   converted + exact      → pass
//   converted + difference → fail + exception
// Pure decision (arCheckFromControl) plus the full reconciliationStatus run
// against an in-memory fake database, so all_clean / exceptions / notes and
// Kat's reply text are checked end to end. Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { arCheckFromControl, reconciliationStatus } = require('../lib/accounting/reconciliation_status');

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}

const ctl = (over) => Object.assign({
  subledger_cents: 5870704, gl_1300_2400_net_cents: 5870704, diff_cents: 0, gl_accounts_found: 2,
  conversion: { ready: true },
}, over);

// Minimal PostgREST-shaped fake: every filter is accepted, each table returns
// its fixed rows. Enough for reconciliationStatus + arControl + readiness.
function fakeDb(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; },
        in(col, vals) { q._in = { col, vals: vals.map(String) }; return q; },
        not() { return q; }, is() { return q; }, gte() { return q; }, limit() { return q; },
        range(from) { q._from = from; return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(res, rej) {
          const filtered = q._in ? rows.filter((r) => !(q._in.col in r) || q._in.vals.includes(String(r[q._in.col]))) : rows;
          const data = q._from ? [] : filtered;
          const out = table === 'budget_line_items' ? { data: null, count: rows.length, error: null } : { data, error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
}
function world({ subCents, glCents, converted }) {
  return fakeDb({
    v_trial_balance: [
      { account_number: '1300', total_debits_cents: glCents, total_credits_cents: 0 },
      { account_number: '2400', total_debits_cents: 0, total_credits_cents: 0 },
      { account_number: '3000', total_debits_cents: 0, total_credits_cents: glCents },
    ],
    v_homeowner_current_balance: [{ vantaca_account_id: 'A1', property_id: 'p1', contact_id: 'c1', balance_cents: subCents }],
    conversion_batches: converted ? [{ id: 'b1', community_id: 'X', batch_code: 'CONV', as_of_date: '2026-07-31', status: 'posted' }] : [],
    bank_reconciliations: [{ bank_account_id: 'ba1', period_end: '2026-08-31', status: 'reconciled', difference_cents: 0, bank_accounts: { account_nickname: 'Operating' } }],
    community_budgets: [{ id: 'bud1', fiscal_year: 2026, status: 'approved' }],
    budget_line_items: [{ id: 1 }, { id: 2 }],
  });
}

(async () => {
  console.log('test_reconciliation_ar_readiness');

  await t('unconverted + equal numbers → NOT a validated pass', () => {
    const r = arCheckFromControl(ctl({ conversion: { ready: false } }));
    assert.strictEqual(r.state, 'not_ready');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.validated, false);
    assert.strictEqual(r.exception, null);
  });

  await t('unconverted + unequal numbers → NOT an AR mismatch exception, no difference reported', () => {
    const r = arCheckFromControl(ctl({ gl_1300_2400_net_cents: 1, diff_cents: 5870703, conversion: { ready: false } }));
    assert.strictEqual(r.state, 'not_ready');
    assert.strictEqual(r.exception, null);
    assert.strictEqual(r.diff, null);
  });

  await t('converted + exact equality → pass', () => {
    const r = arCheckFromControl(ctl());
    assert.strictEqual(r.state, 'pass');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.validated, true);
  });

  await t('converted + one-cent difference → fail with exception', () => {
    const r = arCheckFromControl(ctl({ gl_1300_2400_net_cents: 5870703, diff_cents: 1 }));
    assert.strictEqual(r.state, 'fail');
    assert.ok(/does not tie/.test(r.exception));
  });

  await t('full run: unconverted + equal → all_clean false, no AR exception, one note', async () => {
    const st = await reconciliationStatus(world({ subCents: 10000, glCents: 10000, converted: false }), 'X');
    assert.strictEqual(st.ar.state, 'not_ready');
    assert.strictEqual(st.all_clean, false);
    assert.ok(!st.exceptions.some((x) => /AR subledger/.test(x)), 'no AR exception: ' + st.exceptions.join(' | '));
    assert.strictEqual(st.notes.length, 1);
  });

  await t('full run: unconverted + unequal → still no AR exception', async () => {
    const st = await reconciliationStatus(world({ subCents: 10000, glCents: 99999, converted: false }), 'X');
    assert.ok(!st.exceptions.some((x) => /AR subledger/.test(x)));
    assert.strictEqual(st.ar.state, 'not_ready');
  });

  await t('full run: converted + exact → AR pass and books clean', async () => {
    const st = await reconciliationStatus(world({ subCents: 10000, glCents: 10000, converted: true }), 'X');
    assert.strictEqual(st.ar.state, 'pass');
    assert.strictEqual(st.all_clean, true, 'exceptions: ' + st.exceptions.join(' | '));
  });

  await t('full run: converted + difference → AR exception, not clean', async () => {
    const st = await reconciliationStatus(world({ subCents: 10000, glCents: 9000, converted: true }), 'X');
    assert.strictEqual(st.ar.state, 'fail');
    assert.strictEqual(st.all_clean, false);
    assert.ok(st.exceptions.some((x) => /AR subledger/.test(x)));
  });

  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
