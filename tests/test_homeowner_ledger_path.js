#!/usr/bin/env node
// ============================================================================
// A converted opening balance must be the SAME balance every surface uses, and
// the normal charge + payment paths must change it. Runs the real
// resolveCurrentAR, postHomeownerCharge and the online-payment subledger writer
// against an in-memory database whose v_homeowner_current_balance is computed
// exactly like the SQL view (committed batches only, grouped by account +
// property + contact). No network.
// Live guard (when SUPABASE_URL is set): LOPF cannot be flipped onto ar_charges.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
const { postHomeownerCharge } = require('../lib/accounting/homeowner_charge');
const { _test: { upsertSubledgerPayment } } = require('../lib/payments/assessment_posting');

let failed = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- fake db
function makeDb(seed) {
  const db = JSON.parse(JSON.stringify(seed));
  let seq = 1000;
  const views = {
    v_homeowner_current_balance: () => {
      const committed = new Set(db.transaction_upload_batches.filter((b) => b.status === 'committed').map((b) => b.id));
      const g = new Map();
      for (const r of db.homeowner_transactions) {
        if (!committed.has(r.source_batch_id)) continue;
        const k = [r.community_id, r.vantaca_account_id, r.property_id, r.contact_id].join('|');
        const x = g.get(k) || { community_id: r.community_id, vantaca_account_id: r.vantaca_account_id, property_id: r.property_id, contact_id: r.contact_id, balance_cents: 0, most_recent_txn_date: null, txn_count: 0 };
        x.balance_cents += r.amount_cents; x.txn_count++;
        if (!x.most_recent_txn_date || r.transaction_date > x.most_recent_txn_date) x.most_recent_txn_date = r.transaction_date;
        g.set(k, x);
      }
      return [...g.values()];
    },
    // real column names of the SQL view (owner_contact_id, not contact_id)
    v_current_property_owners: () => db.property_ownerships.filter((o) => !o.end_date && o.is_primary).map((o) => ({ property_id: o.property_id, owner_contact_id: o.contact_id })),
    // mig 457, computed exactly like the SQL: committed rows on the lot's
    // current tenure still on the lot's current account (stamped), plus
    // unstamped rows on the lot's current account (writers not switched yet).
    v_current_owner_ledger: () => currentLedger(),
    v_current_owner_balance: () => {
      const g = new Map();
      for (const r of currentLedger()) {
        const x = g.get(r.property_id) || { community_id: r.community_id, property_id: r.property_id, tenure_id: r.tenure_id, balance_cents: 0, most_recent_txn_date: null, txn_count: 0, unstamped_count: 0 };
        x.balance_cents += r.amount_cents; x.txn_count++; if (!r.stamped) x.unstamped_count++;
        if (!x.most_recent_txn_date || r.transaction_date > x.most_recent_txn_date) x.most_recent_txn_date = r.transaction_date;
        g.set(r.property_id, x);
      }
      return [...g.values()];
    },
    v_current_owner_balance_composition: () => {
      const g = new Map();
      for (const r of currentLedger()) {
        const cat = r.charge_category || 'other'; const k = r.property_id + '|' + cat;
        const x = g.get(k) || { community_id: r.community_id, property_id: r.property_id, tenure_id: r.tenure_id, charge_category: cat, amount_cents: 0 };
        x.amount_cents += r.amount_cents; g.set(k, x);
      }
      return [...g.values()];
    },
    v_former_owner_ledger_balances: () => {
      const cur = new Set(currentLedger().map((r) => r.id));
      const committed = new Set(db.transaction_upload_batches.filter((b) => b.status === 'committed').map((b) => b.id));
      const g = new Map();
      for (const r of db.homeowner_transactions) {
        if (!committed.has(r.source_batch_id) || cur.has(r.id)) continue;
        const k = [r.community_id, r.tenure_id, r.vantaca_account_id].join('|');
        const x = g.get(k) || { community_id: r.community_id, tenure_id: r.tenure_id || null, vantaca_account_id: r.vantaca_account_id, balance_cents: 0, txn_count: 0 };
        x.balance_cents += r.amount_cents; x.txn_count++; g.set(k, x);
      }
      return [...g.values()];
    },
  };
  function currentLedger() {
    const committed = new Set(db.transaction_upload_batches.filter((b) => b.status === 'committed').map((b) => b.id));
    const tenures = db.ownership_tenures || [];
    const curT = (pid) => tenures.find((t) => t.property_id === pid && t.kind === 'owner' && !t.end_date);
    const out = [];
    for (const h of db.homeowner_transactions) {
      if (!committed.has(h.source_batch_id)) continue;
      if (h.tenure_id) {
        const t = tenures.find((x) => x.id === h.tenure_id);
        if (!t || t.kind !== 'owner' || t.end_date) continue;
        const p = db.properties.find((x) => x.id === t.property_id);
        if (h.vantaca_account_id == null || h.vantaca_account_id === p.vantaca_account_id) out.push({ ...h, property_id: t.property_id, tenure_id: t.id, stamped: true });
      } else if (h.vantaca_account_id) {
        const ps = db.properties.filter((x) => x.community_id === h.community_id && x.vantaca_account_id === h.vantaca_account_id);
        const t = ps.length === 1 ? curT(ps[0].id) : null;
        if (t) out.push({ ...h, property_id: t.property_id, tenure_id: t.id, stamped: false });
      }
    }
    return out;
  }
  const rowsOf = (t) => (views[t] ? views[t]() : (db[t] = db[t] || []));
  function builder(table) {
    const f = []; let order = null; let lim = null; let ins = null; let single = null;
    const api = {
      select() { return api; },
      eq(c, v) { f.push((r) => r[c] === v); return api; },
      in(c, vs) { f.push((r) => vs.includes(r[c])); return api; },
      gt(c, v) { f.push((r) => r[c] > v); return api; },
      gte(c, v) { f.push((r) => r[c] >= v); return api; },
      lt(c, v) { f.push((r) => r[c] < v); return api; },
      lte(c, v) { f.push((r) => r[c] <= v); return api; },
      not(c, op, v) { f.push((r) => (op === 'is' ? r[c] !== v : true)); return api; },
      range(a, b) { lim = b + 1; return api; },
      is(c, v) { f.push((r) => r[c] === v); return api; },
      contains(c, obj) { f.push((r) => r[c] && Object.entries(obj).every(([k, v]) => r[c][k] === v)); return api; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return api; },
      limit(n) { lim = n; return api; },
      insert(obj) { ins = obj; return api; },
      maybeSingle() { single = 'maybe'; return api; },
      single() { single = 'one'; return api; },
      then(res, rej) {
        try {
          if (ins) {
            const row = { id: `id${seq++}`, ...ins };
            if (table === 'homeowner_transactions' && db.homeowner_transactions.some((x) => x.source_batch_id === row.source_batch_id && x.source_row_index === row.source_row_index)) return res({ data: null, error: { code: '23505' } });
            rowsOf(table).push(row);
            return res({ data: row, error: null });
          }
          let rows = rowsOf(table).filter((r) => f.every((fn) => fn(r)));
          if (order) rows = rows.slice().sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : a[order[0]] > b[order[0]] ? 1 : 0) * (order[1] ? 1 : -1));
          if (lim != null) rows = rows.slice(0, lim);
          if (single === 'maybe') return res(rows.length > 1 ? { data: null, error: { message: 'multiple rows' } } : { data: rows[0] || null, error: null });
          if (single === 'one') return res(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'not one row' } });
          return res({ data: rows, error: null });
        } catch (e) { return rej(e); }
      },
    };
    return api;
  }
  return { db, client: { from: builder } };
}

// A lot sold to a new owner: seller account S1 has history on the lot in a prior
// (now retired) import; buyer account B2 is the property's current account and
// carries the converted opening balance. A former owner F9 has no lot at all.
const C = 'comm-lpf';
const P = 'prop-1';
const seed = () => ({
  properties: [{ id: P, community_id: C, vantaca_account_id: 'B2', trusted_account_number: 'LPF-0001', street_address: '1 Test Ln' }],
  property_ownerships: [
    { id: 'o-s', property_id: P, contact_id: 'c-seller', start_date: '2026-05-19', end_date: '2026-06-01', is_primary: true },
    { id: 'o-b', property_id: P, contact_id: 'c-buyer', start_date: '2026-06-02', end_date: null, is_primary: true },
  ],
  communities: [{ id: C, management_company_id: 'mgmt' }],
  contacts: [{ id: 'c-buyer', vantaca_account_id: 'B2' }],
  // mig 456 backfill: buyer's current tenure (xref B2), seller's ended tenure,
  // legacy tenure for the no-lot former owner F9. Committed rows are stamped;
  // retired-import rows are not.
  ownership_tenures: [
    { id: 't-buyer', community_id: C, property_id: P, kind: 'owner', start_date: '2026-06-02', end_date: null, vantaca_account_id: 'B2' },
    { id: 't-seller', community_id: C, property_id: P, kind: 'owner', start_date: '2026-05-19', end_date: '2026-06-01', vantaca_account_id: null },
    { id: 't-f9', community_id: C, property_id: null, kind: 'legacy', start_date: null, end_date: null, vantaca_account_id: 'F9' },
  ],
  owner_ar_snapshots: [], v_current_enforcement_state: [],
  transaction_upload_batches: [
    { id: 'b-prior', community_id: C, status: 'reverted' },     // retired prior source import
    { id: 'b-conv', community_id: C, status: 'committed' },     // conversion opening balances
  ],
  homeowner_transactions: [
    { id: 'h1', source_batch_id: 'b-prior', source_row_index: 1, community_id: C, vantaca_account_id: 'S1', property_id: P, contact_id: 'c-seller', transaction_date: '2026-07-17', txn_type: 'balance_brought_forward', amount_cents: 76895 },
    { id: 'h2', source_batch_id: 'b-prior', source_row_index: 2, community_id: C, vantaca_account_id: 'B2', property_id: P, contact_id: 'c-buyer', transaction_date: '2026-07-17', txn_type: 'balance_brought_forward', amount_cents: 99999 },
    { tenure_id: 't-buyer', id: 'h3', source_batch_id: 'b-conv', source_row_index: 1, community_id: C, vantaca_account_id: 'B2', property_id: P, contact_id: 'c-buyer', transaction_date: '2026-07-31', txn_type: 'balance_brought_forward', charge_category: 'assessment', amount_cents: 26000 },
    { tenure_id: 't-buyer', id: 'h4', source_batch_id: 'b-conv', source_row_index: 2, community_id: C, vantaca_account_id: 'B2', property_id: P, contact_id: 'c-buyer', transaction_date: '2026-07-31', txn_type: 'balance_brought_forward', charge_category: 'late_fee', amount_cents: 1500 },
    { tenure_id: 't-buyer', id: 'h5', source_batch_id: 'b-conv', source_row_index: 3, community_id: C, vantaca_account_id: 'B2', property_id: P, contact_id: 'c-buyer', transaction_date: '2026-07-31', txn_type: 'credit', charge_category: 'other', amount_cents: -5000 },
    { tenure_id: 't-f9', id: 'h6', source_batch_id: 'b-conv', source_row_index: 4, community_id: C, vantaca_account_id: 'F9', property_id: null, contact_id: null, transaction_date: '2026-07-31', txn_type: 'credit', charge_category: 'other', amount_cents: -31377 },
  ],
});

t('converted opening balance is what the shared resolver returns (current tenure only)', async () => {
  const { client } = makeDb(seed());
  const ar = await resolveCurrentAR(client, { propertyId: P });
  assert.strictEqual(ar.balance_cents, 22500); // 26000 + 1500 - 5000; not the seller, not the retired import, not F9
  assert.strictEqual(ar.source, 'transactions');
});

t('a normal charge posts to the CURRENT account and changes that balance', async () => {
  const { client, db } = makeDb(seed());
  const r = await postHomeownerCharge(client, { communityId: C, propertyId: P, transactionDate: '2026-08-05', description: 'Certified letter fee', chargeCategory: 'certified_letter', amountCents: 1000 });
  assert.strictEqual(r.newBalanceCents, 23500);
  const row = db.homeowner_transactions.find((x) => x.id === r.chargeId);
  assert.strictEqual(row.vantaca_account_id, 'B2', 'charge landed on a non-current account');
  assert.strictEqual(row.running_balance_cents, 23500, 'running balance included retired or other-owner rows');
  assert.strictEqual((await resolveCurrentAR(client, { propertyId: P })).balance_cents, 23500);
});

t('an online payment reduces the same balance', async () => {
  const { client } = makeDb(seed());
  await upsertSubledgerPayment(client, { communityId: C, propertyId: P, vantacaAccountId: 'B2', amountCents: 3500, sessionId: 'cs_1', paymentIntentId: 'pi_1', propLabel: '1 Test Ln' });
  assert.strictEqual((await resolveCurrentAR(client, { propertyId: P })).balance_cents, 19000);
});

t('charge then payment: the portal/Claire/autopay balance tracks both', async () => {
  const { client } = makeDb(seed());
  await postHomeownerCharge(client, { communityId: C, propertyId: P, transactionDate: '2026-08-05', description: 'Late fee', chargeCategory: 'late_fee', amountCents: 2500 });
  await upsertSubledgerPayment(client, { communityId: C, propertyId: P, vantacaAccountId: 'B2', amountCents: 25000, sessionId: 'cs_2', paymentIntentId: 'pi_2', propLabel: '1 Test Ln' });
  assert.strictEqual((await resolveCurrentAR(client, { propertyId: P })).balance_cents, 0);
});

t('an account split across several view rows is summed, not dropped to "none"', async () => {
  const s = seed();
  s.homeowner_transactions.push({ id: 'h7', source_batch_id: 'b-conv', source_row_index: 9, community_id: C, vantaca_account_id: 'B2', property_id: P, contact_id: 'c-other', transaction_date: '2026-08-01', txn_type: 'payment', amount_cents: -2500 });
  const { client } = makeDb(s);
  const ar = await resolveCurrentAR(client, { propertyId: P });
  assert.ok(ar && ar.source === 'transactions', 'balance fell through to none');
  assert.strictEqual(ar.balance_cents, 20000);
});

t('a legacy unresolved former-owner credit never reaches a current owner', async () => {
  const { client } = makeDb(seed());
  const ar = await resolveCurrentAR(client, { propertyId: P });
  assert.strictEqual(ar.balance_cents, 22500);
  const view = await client.from('v_homeowner_current_balance').select('*').eq('community_id', C);
  const roster = view.data.filter((b) => b.property_id); // board-portal / staff roster rule
  assert.ok(!roster.some((b) => b.vantaca_account_id === 'F9'));
  assert.ok(view.data.some((b) => b.vantaca_account_id === 'F9' && b.balance_cents === -31377), 'legacy credit must still exist in the ledger total');
});

t('a new row a writer posts WITHOUT tenure_id still reaches the current owner (writers not switched yet)', async () => {
  const { client, db } = makeDb(seed());
  await postHomeownerCharge(client, { communityId: C, propertyId: P, transactionDate: '2026-08-05', description: 'Late fee', chargeCategory: 'late_fee', amountCents: 2500 });
  const row = db.homeowner_transactions[db.homeowner_transactions.length - 1];
  assert.ok(!row.tenure_id, 'writer is not switched: it must not be stamping tenure_id yet');
  const bal = (await client.from('v_current_owner_balance').select('*').eq('property_id', P)).data[0];
  assert.deepStrictEqual([bal.balance_cents, bal.unstamped_count], [25000, 1]);
});

t('a Vantaca account change: the new owner does not inherit the prior account; it moves to former-owner money', async () => {
  const s = seed();
  s.properties[0].vantaca_account_id = 'B3';   // Vantaca issued a new number (sale seen via import)
  s.homeowner_transactions.push({ id: 'h8', source_batch_id: 'b-conv', source_row_index: 10, community_id: C, vantaca_account_id: 'B3', property_id: P, contact_id: 'c-new', transaction_date: '2026-08-10', txn_type: 'charge', charge_category: 'assessment', amount_cents: 4000 });
  const { client } = makeDb(s);
  const ar = await resolveCurrentAR(client, { propertyId: P });
  assert.strictEqual(ar.balance_cents, 4000, 'new owner saw the prior account');
  const former = (await client.from('v_former_owner_ledger_balances').select('*').eq('community_id', C)).data;
  assert.ok(former.some((f) => f.vantaca_account_id === 'B2' && f.balance_cents === 22500), 'prior account balance must stay visible as former-owner money');
});

t('both native charge paths use the shared identity helper', () => {
  for (const f of ['lib/accounting/homeowner_charge.js', 'lib/accounting/assessment_proration.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(src.includes('currentLedgerIdentity') && src.includes('committedAccountBalance'), f);
    assert.ok(!/from\('homeowner_transactions'\)\.select\('amount_cents'\)\.eq\('property_id'/.test(src), `${f} still sums every row on the property`);
  }
});

t('LIVE: LOPF cannot be flipped onto ar_charges (no charge types, no charges, certified autopost off)', async () => {
  if (!process.env.SUPABASE_URL) return console.log('      (skipped: no SUPABASE_URL)');
  const s = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const LPF = 'a0000000-0000-4000-8000-000000000002';
  const [types, charges, com] = await Promise.all([
    s.from('ar_charge_types').select('id', { count: 'exact', head: true }).eq('community_id', LPF),
    s.from('ar_charges').select('id', { count: 'exact', head: true }).eq('community_id', LPF),
    s.from('communities').select('certified_fee_autopost').eq('id', LPF).single(),
  ]);
  for (const r of [types, charges, com]) if (r.error) throw new Error(r.error.message);
  assert.strictEqual(types.count, 0, 'LOPF has ar_charge_types: native charges would move to ar_charges and hide the ledger');
  assert.strictEqual(charges.count, 0, 'LOPF has ar_charges: staff screens would switch source');
  assert.notStrictEqual(com.data.certified_fee_autopost, true, 'certified fee autopost would create ar_charges for LOPF');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
  }
  console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
  process.exitCode = failed ? 1 : 0; // no process.exit(): lets the live client close cleanly on Windows
})();
