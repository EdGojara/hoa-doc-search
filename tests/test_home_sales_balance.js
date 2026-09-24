#!/usr/bin/env node
// Home Sales seller balance: a missing balance is UNKNOWN, never $0.
// Covers api/home_sales.js balanceFromAR and the resolveCurrentAR "only an
// enforcement state on file" path (it used to throw on a null snapshot).
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
const { balanceFromAR } = require('../api/home_sales')._test;
const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

// Minimal PostgREST stand-in: each table returns fixed rows for any filter chain.
function fakeSupabase(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const q = {
        select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
        lte() { return q; }, gt() { return q; },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

(async () => {
  await t('no AR on file is UNKNOWN, not $0, and not cleared', () => {
    const b = balanceFromAR(null);
    assert.strictEqual(b.balance_status, 'UNKNOWN');
    assert.strictEqual(b.balance_cents, null);
    assert.strictEqual(b.balance_is_zero, false);
  });
  await t('a null balance from the resolver is UNKNOWN', () => {
    const b = balanceFromAR({ balance_cents: null, source: 'none' });
    assert.strictEqual(b.balance_status, 'UNKNOWN');
    assert.strictEqual(b.balance_is_zero, false);
  });
  await t('a KNOWN $0 is cleared', () => {
    const b = balanceFromAR({ balance_cents: 0, as_of: '2026-09-01', source: 'transactions' });
    assert.deepStrictEqual([b.balance_status, b.balance_cents, b.balance_is_zero, b.balance_as_of], ['KNOWN', 0, true, '2026-09-01']);
  });
  await t('a KNOWN balance owed is not cleared', () => {
    const b = balanceFromAR({ balance_cents: 21600, source: 'transactions' });
    assert.deepStrictEqual([b.balance_status, b.balance_cents, b.balance_is_zero], ['KNOWN', 21600, false]);
  });
  await t('a credit balance is KNOWN and not "cleared"', () => {
    const b = balanceFromAR({ balance_cents: -5000, source: 'transactions' });
    assert.strictEqual(b.balance_is_zero, false);
  });
  await t('resolver: a property reads the CURRENT OWNER tenure balance', async () => {
    const sb = fakeSupabase({
      properties: [{ vantaca_account_id: '2012345', community_id: 'c1' }],
      v_current_owner_balance: [{ property_id: 'p1', tenure_id: 't1', balance_cents: 7500, most_recent_txn_date: '2026-08-15', txn_count: 2 }],
      // the account-keyed view must NOT be consulted when a property is given
      v_homeowner_current_balance: [{ balance_cents: 999999, most_recent_txn_date: '2026-01-01' }],
    });
    const ar = await resolveCurrentAR(sb, { propertyId: 'p1' });
    assert.deepStrictEqual([ar.balance_cents, ar.source, ar.as_of], [7500, 'transactions', '2026-08-15']);
    assert.strictEqual(balanceFromAR(ar).balance_status, 'KNOWN');
  });
  await t('resolver: account-only lookup still sums the account view rows', async () => {
    const sb = fakeSupabase({
      v_homeowner_current_balance: [{ balance_cents: 10000, most_recent_txn_date: '2026-08-01' }, { balance_cents: -2500, most_recent_txn_date: '2026-08-15' }],
    });
    const ar = await resolveCurrentAR(sb, { vantacaAccountId: '2012345', communityId: 'c1' });
    assert.deepStrictEqual([ar.balance_cents, ar.source], [7500, 'transactions']);
  });
  await t('resolver: nothing on file returns null -> UNKNOWN', async () => {
    const sb = fakeSupabase({ properties: [{ vantaca_account_id: null, community_id: 'c1' }] });
    const ar = await resolveCurrentAR(sb, { propertyId: 'p1' });
    assert.strictEqual(ar, null);
    assert.strictEqual(balanceFromAR(ar).balance_status, 'UNKNOWN');
  });
  await t('resolver: only an enforcement state on file -> balance UNKNOWN (used to throw)', async () => {
    const sb = fakeSupabase({
      properties: [{ vantaca_account_id: null, community_id: 'c1' }],
      v_current_enforcement_state: [{ state: 'lien_filed' }],
    });
    const ar = await resolveCurrentAR(sb, { propertyId: 'p1' });
    assert.strictEqual(ar.balance_cents, null);
    assert.strictEqual(ar.lien_filed, true);
    assert.strictEqual(balanceFromAR(ar).balance_status, 'UNKNOWN');
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
