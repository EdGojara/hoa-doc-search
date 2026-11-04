#!/usr/bin/env node
// ============================================================================
// THE homeowner balance (lib/ar/owner_balance.js, Ed 2026-10-21): one
// calculation for every screen and API that shows what a current owner owes.
//
// Found 2026-10-21: owner search and collections switched a WHOLE community to
// native ar_charges once one certified-letter fee existed (every other owner
// showed $0 in Waterview, Still Creek and Canyon Gate); Homeowner 360, the
// portal, statements and collections notices left native fees out; Quail
// Ridge's staff screens aged a superseded 6/20/2026 snapshot instead of the
// 7/31 conversion balances posted to the GL.
//
// Part 1 (always): account-level fixtures for every case: ledger charges,
// payments, credits, prepayments, native fees, a native fee paid through the
// ledger, §209.0063 order, ownership history, the superseded snapshot.
// Part 2 (SUPABASE_URL set; read-only): every current account in every active
// community, through the real endpoints and readers, must show one balance.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { allocateOwner, ownerBalancesDetailed, mergeNativeActivity } = require('../lib/ar/owner_balance');
const { reconcileAgingToGl } = require('../lib/ar/aging_reconciliation');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const L = (type, cents, desc = 'Assessment', date = '2026-07-31') => ({ property_id: 'p', txn_type: type, amount_cents: cents, description: desc, transaction_date: date });
const N = (cents, date = '2026-09-15', extra = {}) => ({ id: `n${date}${cents}`, property_id: 'p', balance_remaining_cents: cents, charge_date: date, due_date: date, description: 'Certified letter (violation)', source_module: 'certified_letter_fee', ar_charge_types: { category: 'certified', display_name: 'Certified Letter Fee - Violation' }, ...extra });
const ident = (b) => b.open_charges_cents - b.credit_cents === b.net_due_cents && !(b.open_charges_cents > 0 && b.credit_cents > 0);

console.log('account cases (pure)');
let b = allocateOwner([L('balance_brought_forward', 142500), L('payment', -40000, 'Payment', '2026-08-10')]);
check('ledger charge and a payment: net = open = $1,025, no credit', b.net_due_cents === 102500 && b.open_charges_cents === 102500 && b.credit_cents === 0 && ident(b));
b = allocateOwner([L('credit', -50000, 'Prepaid')]);
check('prepaid owner: net -$500, nothing open, $500 credit (shown as credit, never $0 owed)', b.net_due_cents === -50000 && b.open_charges_cents === 0 && b.credit_cents === 50000 && ident(b));
b = allocateOwner([L('balance_brought_forward', 10000)], [N(3500)]);
check('ledger + native fee: both counted once (net $135)', b.net_due_cents === 13500 && b.open_charges_cents === 13500 && b.native_open_cents === 3500 && ident(b));
b = allocateOwner([L('payment', -2500, 'Payment', '2026-08-20')], [N(2500, '2026-08-18')]);
check('native fee paid through the ledger (7919 Caribou Valley): net $0, nothing open, no credit', b.net_due_cents === 0 && b.open_charges_cents === 0 && b.credit_cents === 0 && ident(b));
b = allocateOwner([L('credit', -10000, 'Prepaid')], [N(3500)]);
check('prepaid owner with a native fee: the credit absorbs the fee (net -$65)', b.net_due_cents === -6500 && b.open_charges_cents === 0 && b.credit_cents === 6500 && ident(b));
b = allocateOwner([L('balance_brought_forward', 10000, 'Opening balance (Assessment)'), L('payment', -10000, 'Payment', '2026-08-01')], [N(3500, '2026-07-01')]);
check('§209.0063 order: a payment applies to the assessment before an older certified fee', b.open_charges.length === 1 && b.open_charges[0].source === 'native' && b.open_charges_cents === 3500);
b = allocateOwner([], [N(3500), N(0, '2026-10-01')]);
check('native-only owner (no ledger rows): the fee is the balance; a $0 native row adds nothing', b.net_due_cents === 3500 && b.open_charges.length === 1);
let fuzzOk = true;
for (let i = 0; i < 500; i++) {
  const rows = Array.from({ length: 1 + (i % 7) }, (_, k) => L(['balance_brought_forward', 'charge', 'payment', 'credit', 'adjustment'][(i + k) % 5], ((i * 37 + k * 101) % 900 - 450) * 100, ['Assessment', 'Late Fee', 'Legal Fees', 'Fine', 'Interest'][k % 5], `2026-0${1 + (k % 9)}-15`));
  const nat = (i % 3) ? [N(((i * 13) % 50) * 100)] : [];
  const r = allocateOwner(rows, nat);
  const sum = rows.reduce((s, x) => s + x.amount_cents, 0) + nat.reduce((s, x) => s + x.balance_remaining_cents, 0);
  if (!ident(r) || r.net_due_cents !== sum) { fuzzOk = false; break; }
}
check('500 mixed accounts: net = sum of every row; open - credit = net; never both open and credit', fuzzOk);

console.log('statement activity ties to the balance');
const act = mergeNativeActivity([{ ...L('balance_brought_forward', 10000), running_balance_cents: 10000 }, { ...L('payment', -4000, 'Payment', '2026-10-01'), running_balance_cents: 6000 }], [N(3500, '2026-09-15')]);
check('native fee merged by date; running balances include it; last line = THE balance ($95)',
  act.length === 3 && act[1].source === 'native' && act[1].running_balance_cents === 13500 && act[2].running_balance_cents === 9500);

console.log('aging reconciliation nets native fees per owner');
const rec = reconcileAgingToGl({ rows: [L('credit', -2500, 'Prepaid'), { ...L('balance_brought_forward', 10000), property_id: 'q' }], nativeCharges: [N(2500)], agingOpenCents: 10000, glArCents: 12500, glPrepaidCents: 2500 });
check('a fee absorbed by the same owner\'s credit is not aged twice; GL 1300 basis still includes it; ties', rec.tied && rec.aging_matches_ledger && rec.lines.find((l) => l.key === 'receivable_rows').cents === 12500);

console.log('ownership history, superseded snapshot, current tenure (fake database)');
function fakeDb(tables) {
  const q = (rows) => {
    let r = rows.slice();
    const api = {
      select: () => api, eq: (k, v) => { r = r.filter((x) => x[k] === v); return api; }, in: (k, vs) => { r = r.filter((x) => vs.includes(x[k])); return api; },
      order: () => api, range: (a, z) => Promise.resolve({ data: r.slice(a, z + 1), error: null }), limit: (n) => { r = r.slice(0, n); return api; },
      maybeSingle: () => Promise.resolve({ data: r[0] || null, error: null }), then: (res, rej) => Promise.resolve({ data: r, error: null }).then(res, rej),
    };
    return api;
  };
  return { from: (t) => q(tables[t] || []) };
}
const db = fakeDb({
  v_current_property_owners: [{ community_id: 'c', property_id: 'sold', tenure_id: 'buyer' }, { community_id: 'c', property_id: 'qr', tenure_id: 't2' }],
  // v_current_owner_ledger already holds the CURRENT tenure's rows only (the seller's $900 is in v_former_owner_ledger_balances).
  v_current_owner_ledger: [{ ...L('charge', 35000), community_id: 'c', property_id: 'sold', id: 'l1' }, { ...L('balance_brought_forward', 52000, 'Opening balance 2026-07-31 (Annual Assessment)'), community_id: 'c', property_id: 'qr', id: 'l2' }],
  ar_charges: [
    { ...N(3500), id: 'n-seller', community_id: 'c', property_id: 'sold', tenure_id: 'seller', status: 'open' },
    { ...N(2500), id: 'n-buyer', community_id: 'c', property_id: 'sold', tenure_id: null, status: 'open' },
    { ...N(58898, '2025-08-01'), id: 'n-snap', community_id: 'c', property_id: 'qr', tenure_id: null, status: 'open', source_module: 'vantaca_migration' },
    { ...N(3000, '2026-09-03'), id: 'n-qr', community_id: 'c', property_id: 'qr', tenure_id: null, status: 'open' },
    { ...N(9900, '2026-09-03'), id: 'n-paid', community_id: 'c', property_id: 'qr', tenure_id: null, status: 'paid' },
  ],
});
ownerBalancesDetailed(db, 'c').then(({ balances }) => {
  check('a native fee stamped to the SELLER never reaches the buyer; an unstamped one does', balances.sold.net_due_cents === 37500 && balances.sold.native_open_cents === 2500);
  check('Quail Ridge shape: the superseded 6/20 snapshot is excluded; the 7/31 opening + a 9/3 fee count ($550)', balances.qr.net_due_cents === 55000);
  check('closed native rows never count', !balances.qr.native_charges.some((c) => c.id === 'n-paid'));
  return live();
}).catch((e) => { fail++; console.log(`  ✗ threw: ${e.stack}`); })
  .finally(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); });

// --------------------------------------------------------------------------- live
async function live() {
  if (!process.env.SUPABASE_URL) { console.log('live check skipped (no SUPABASE_URL)'); return; }
  console.log('live (read-only): every current account, every active community');
  const { createClient } = require('@supabase/supabase-js');
  const { fetchAllQuery } = require('../lib/db/fetch_all');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const express = require('express');
  const gl = require('../api/gl');
  const app = express(); app.use('/gl', gl);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/gl`;
  const get = async (u) => { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} -> ${r.status}`); return r.json(); };
  try {
    const { data: comms, error } = await sb.from('communities').select('id, name, management_status').eq('management_status', 'active');
    if (error) throw error;
    for (const c of comms) {
      const { balances, nativeCharges } = await ownerBalancesDetailed(sb, c.id);
      const pids = Object.keys(balances);
      // Independent sources: the subledger view + native rows queried directly.
      const view = await fetchAllQuery(() => sb.from('v_current_owner_balance').select('property_id, tenure_id, balance_cents').eq('community_id', c.id), { orderBy: 'property_id' });
      const V = Object.fromEntries(view.map((v) => [v.property_id, Number(v.balance_cents)]));
      const owners = await fetchAllQuery(() => sb.from('v_current_property_owners').select('property_id, tenure_id').eq('community_id', c.id), { orderBy: 'property_id' });
      const T = Object.fromEntries(owners.map((o) => [o.property_id, o.tenure_id]));
      const nat = await fetchAllQuery(() => sb.from('ar_charges').select('id, property_id, tenure_id, balance_remaining_cents, source_module, status, charge_date, description').eq('community_id', c.id).eq('status', 'open'), { orderBy: 'id' });
      const NN = {}; for (const x of nat) if (x.source_module !== 'vantaca_migration' && Number(x.balance_remaining_cents) > 0 && (!x.tenure_id || x.tenure_id === T[x.property_id])) NN[x.property_id] = (NN[x.property_id] || 0) + Number(x.balance_remaining_cents);
      const bad = pids.filter((p) => balances[p].net_due_cents !== (V[p] || 0) + (NN[p] || 0));
      const missing = [...new Set([...Object.keys(V).filter((p) => V[p] !== 0), ...Object.keys(NN)])].filter((p) => !balances[p]);
      if (!pids.length && !view.length) { console.log(`  · ${c.name}: no ledger or native AR (skipped)`); continue; }
      check(`${c.name}: ${pids.length} accounts, net = subledger (v_current_owner_balance) + native, account by account`, !bad.length && !missing.length, `${bad.length} differ, ${missing.length} missing: ${bad.concat(missing).slice(0, 5).join(', ')}`);
      check(`${c.name}: open charges - credit = net on every account; never both`, pids.every((p) => ident(balances[p])));
      // No native fee is also on the ledger (double count).
      const ledgerFees = await fetchAllQuery(() => sb.from('v_current_owner_ledger').select('id, property_id, transaction_date, amount_cents, description').eq('community_id', c.id).ilike('description', '%certified%'), { orderBy: 'id' });
      const dup = nativeCharges.filter((n) => ledgerFees.some((l) => l.property_id === n.property_id && String(l.transaction_date).slice(0, 10) === String(n.charge_date).slice(0, 10) && Number(l.amount_cents) === Number(n.balance_remaining_cents)));
      check(`${c.name}: no native fee is also posted on the ledger (no double count)`, !dup.length, dup.map((d) => d.id).join(', '));
      // AR aging = the same open charges, owner by owner.
      const aging = await get(`/${c.id}/ar-aging`);
      const A = Object.fromEntries(aging.homeowners.map((h) => [h.property_id, h.total]));
      const agingBad = pids.filter((p) => (A[p] || 0) !== balances[p].open_charges_cents);
      check(`${c.name}: AR aging per owner = open charges (total ${(aging.summary.total_cents / 100).toFixed(2)})`, !agingBad.length && aging.reconciliation.aging_matches_ledger !== false, agingBad.slice(0, 5).join(', '));
      check(`${c.name}: aging reconciliation net position = sum of every owner's net balance`, aging.reconciliation.lines.find((l) => l.key === 'net_position').cents === pids.reduce((s, p) => s + balances[p].net_due_cents, 0));
      console.log(`      GL 1300 tie: ${aging.reconciliation.difference_cents == null ? 'no GL 1300 on file' : aging.reconciliation.tied ? 'tied' : `difference ${(aging.reconciliation.difference_cents / 100).toFixed(2)} (shown on the aging; pre-existing GL item)`}`);
      // Owner search + collections list.
      const search = await get(`/${c.id}/owners/search?q=`);
      check(`${c.name}: owner search shows the net balance (first ${search.owners.length}, the screen's cap)`, search.owners.every((o) => o.balance_cents === ((balances[o.property_id] || {}).net_due_cents || 0)));
      const coll = await get(`/${c.id}/collections`);
      check(`${c.name}: collections list shows the net balance (${coll.accounts.length} accounts)`, coll.accounts.every((a) => a.balance_cents === ((balances[a.property_id] || {}).net_due_cents || 0)));
      // Account page, drill-down, resolver (portal/Claire/resale), payment identity: on the hard cases.
      const pick = (f) => pids.filter(f).slice(0, 3);
      const sample = [...new Set([...pick((p) => balances[p].native_open_cents > 0), ...pick((p) => balances[p].credit_cents > 0), ...pick((p) => balances[p].net_due_cents > 0), ...pick((p) => balances[p].net_due_cents === 0)])];
      let ok = true; const why = [];
      for (const p of sample) {
        const B = balances[p];
        const acct = await get(`/${c.id}/owners/${p}/account`);
        const drill = await get(`/${c.id}/ar-aging/property/${p}`);
        const vals = { account: acct.total_cents, account_open: acct.open_charges_cents, account_credit: acct.credit_cents, drill_open: drill.total_cents, drill_net: drill.net_due_cents };
        const good = vals.account === B.net_due_cents && vals.account_open === B.open_charges_cents && vals.account_credit === B.credit_cents && vals.drill_open === B.open_charges_cents && vals.drill_net === B.net_due_cents;
        if (!good) { ok = false; why.push(`${p.slice(0, 8)} ${JSON.stringify(vals)} vs net ${B.net_due_cents} open ${B.open_charges_cents}`); }
      }
      check(`${c.name}: account page and AR drill-down agree (${sample.length} hard-case accounts)`, ok, why.join(' | '));
      // Ownership history: lots with a former owner's money show only the current owner's.
      const former = await fetchAllQuery(() => sb.from('v_former_owner_ledger_balances').select('property_id, balance_cents').eq('community_id', c.id).not('property_id', 'is', null).neq('balance_cents', 0), { orderBy: 'property_id' });
      const fb = former.filter((f) => balances[f.property_id]).filter((f) => balances[f.property_id].ledger_net_cents !== (V[f.property_id] || 0));
      check(`${c.name}: ${former.length} lots with former-owner balances: none leak into the current owner`, !fb.length);
    }
  } finally { server.close(); }
}
