// tests/test_opening_ap_guard.js  (Ed 2026-10-09)
// ----------------------------------------------------------------------------
// SCAR LOCK: conversion opening AP is a liability carried through the cutoff,
// not a payment instruction.
//
// The Canyon Gate conversion (CONV-CGACR-20260731) wrote the 12 invoices open on
// Vantaca's 7/31 AP aging as 'approved', unpaid, not ACH. Bills ready to pay
// listed all 12 ($7,992.75) pre-ticked; 9 ($2,134.19, CINCO MUD 8 + Gexa) had
// already been paid by bank draft in March-May. Lakes of Pine Forest (executed
// before the conversion write log existed) and Quail Ridge had the same exposure.
//
// Runs the REAL listPayableInvoices / createCheckRun / recordPayment /
// approveInvoice against an in-memory Supabase fake. Proves:
//   - opening AP (by its opening-entry posting JE, or by the conversion write
//     log) is off the list, and the list says how many are held and for how much;
//   - a check run that includes one is refused before any number is reserved or
//     anything is written, even when the request bypasses the list;
//   - recordPayment (checks, ACH mark-paid, /payments) refuses it, writing nothing;
//   - only an explicit clearance releases it; a later revocation re-holds it;
//   - provenance read failures refuse (fail closed); a missing clearance table
//     means nothing is cleared;
//   - ordinary current AP is untouched;
//   - approval is not a release path for 'conversion_review'.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');

// ---- in-memory fake: eq / in / is filters; order by one column ----------------
let db, writes, failRead;
function reset() {
  writes = [];
  failRead = {};      // table -> {code,message} returned as the read error
  db = {
    journal_entries: [
      { id: 'je-open-cg', reference: 'CONV-CGACR-20260731-OPEN-OPR', source_module: 'opening_entry' },
      { id: 'je-open-lpf', reference: 'CONV-LPF-20260731-OPEN-OPR', source_module: 'opening_entry' },
      { id: 'je-bill-1', reference: 'AP-2610CG', source_module: 'ap_invoice' },
      { id: 'je-bill-2', reference: 'AP-GYM', source_module: 'ap_invoice' },
    ],
    onboarding_execution_writes: [],
    opening_ap_payment_clearances: [],
    ap_invoices: [],
    vendors: [
      { id: 'v-mud', name: 'CINCO M.U.D. No. 8', remit_address_line1: 'PO BOX 3264', remit_city: 'HOUSTON', remit_state: 'TX', remit_zip: '77253' },
      { id: 'v-bam', name: 'Bedrock Association Management, LLC', remit_address_line1: '12808 W Airport Blvd', remit_city: 'Sugar Land', remit_state: 'TX', remit_zip: '77478' },
      { id: 'v-gym', name: 'GymTech360', remit_address_line1: null, remit_city: null, remit_state: null, remit_zip: null },
    ],
    bank_accounts: [{ id: 'ba-1', community_id: 'c-cg', is_check_disbursement: true, gl_account_number: '1000', next_check_number: 1052 }],
  };
  const CG = 'c-cg';
  const inv = (id, vendor_id, number, date, cents, je, extra = {}) => ({ id, community_id: CG, vendor_id, vendor_invoice_number: number, invoice_date: date, due_date: null,
    total_cents: cents, amount_paid_cents: 0, status: 'approved', is_ach_autopay: false, notes: null, posting_journal_entry_id: je, source_storage_path: null, ap_invoice_lines: [], ...extra });
  // Canyon Gate's opening AP (a representative three of the twelve) + ordinary current bills.
  db.ap_invoices.push(
    inv('op-mud-1', 'v-mud', null, '2026-03-17', 3718, 'je-open-cg'),
    inv('op-mud-2', 'v-mud', null, '2026-03-17', 3718, 'je-open-cg'),
    inv('op-bam-jul', 'v-bam', '2607CG', '2026-07-01', 535000, 'je-open-cg'),
    inv('cur-bam-oct', 'v-bam', '2610CG', '2026-10-01', 535000, 'je-bill-1'),
    inv('cur-gym', 'v-gym', 'GYM-9', '2026-10-02', 12824, 'je-bill-2'),
    inv('cur-mud-ach', 'v-mud', '30582402', '2026-09-23', 81879, 'je-bill-1', { is_ach_autopay: true }),
    // Write-log provenance only (posting entry not an opening entry): still opening AP.
    inv('op-logged', 'v-bam', '2606CG2', '2026-06-30', 21000, 'je-bill-2'),
  );
  db.onboarding_execution_writes.push({ row_id: 'op-logged', table_name: 'ap_invoices', write_kind: 'ap_opening_invoice' });
}
function fakeClient() {
  return {
    from(table) {
      const st = { table, filters: [], op: 'select', order: null };
      const rows = () => (db[table] || []).filter((r) => st.filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? r[c] === v : true)));
      const q = {
        select() { return q; }, limit() { return q; }, range() { return q; }, neq() { return q; }, ilike() { return q; }, or() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; },
        order(c, o) { st.order = [c, !(o && o.ascending === false)]; return q; },
        eq(c, v) { st.filters.push(['eq', c, v]); return q; }, in(c, v) { st.filters.push(['in', c, v]); return q; }, is(c, v) { st.filters.push(['is', c, v]); return q; },
        insert(p) { st.op = 'insert'; writes.push({ table, op: 'insert', p }); st.inserted = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${table}-${i}`, ...r })); return q; },
        update(p) { st.op = 'update'; st.payload = p; writes.push({ table, op: 'update', p }); return q; },
        delete() { st.op = 'delete'; writes.push({ table, op: 'delete' }); return q; },
        async single() { return { data: st.inserted ? st.inserted[0] : (rows()[0] || null), error: null }; },
        async maybeSingle() { if (failRead[table]) return { data: null, error: failRead[table] }; return { data: st.inserted ? st.inserted[0] : (rows()[0] || null), error: null }; },
        then(res, rej) {
          if (st.op !== 'select') return Promise.resolve({ data: st.inserted || null, error: null }).then(res, rej);
          if (failRead[table]) return Promise.resolve({ data: null, error: failRead[table] }).then(res, rej);
          let out = rows().slice();
          if (st.order) { const [c, asc] = st.order; out.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1)); }
          return Promise.resolve({ data: out, error: null }).then(res, rej);
        },
      };
      return q;
    },
    rpc: async (...a) => { writes.push({ table: 'rpc', op: 'rpc', p: a }); return { data: null, error: { message: 'rpc not available in fake' } }; },
    storage: { from() { return { createSignedUrl: async () => ({ data: null, error: null }) }; } },
  };
}
// The W-9 projection is informational and reads its own tables; stub it here.
const taxStub = { projectBills: async () => new Map(), checkRunW9Status: async () => ({ needs_w9: [], byVendor: new Map() }), evaluateRecordedPayment: async () => ({ decision: 'not_reportable' }), auditNote: () => null, FLAG: new Set(['w9_needed']) };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  if (/tax\/payment_gate$/.test(request)) return taxStub;
  return realLoad.apply(this, arguments);
};
const { listPayableInvoices, createCheckRun } = require('../lib/accounting/check_run');
const { recordPayment, approveInvoice } = require('../lib/accounting/ap_engine');
const guard = require('../lib/accounting/opening_ap_guard');
const sb = fakeClient();
// keep the stub for lazy requires inside the modules; restore at exit

const results = [];
const t = (name, fn) => results.push({ name, fn });
const clear = (invoice_id, decision = 'cleared_for_payment', at = '2026-10-10T10:00:00Z') => db.opening_ap_payment_clearances.push({ invoice_id, community_id: 'c-cg', decision, created_at: at, payment_method: decision === 'cleared_for_payment' ? 'check' : null });
const snapshot = () => JSON.stringify(db.ap_invoices);

// ---- the list --------------------------------------------------------------
t('Bills ready to pay: opening AP is off the list (opening entry AND write-log provenance); held count and dollars are returned; ordinary bills stay', async () => {
  const before = snapshot();
  const r = await listPayableInvoices({ community_id: 'c-cg' });
  assert.deepStrictEqual(r.invoices.map((i) => i.id).sort(), ['cur-bam-oct', 'cur-gym'], 'only current, non-ACH bills');
  assert.deepStrictEqual(r.held_opening_ap, { count: 4, total_cents: 3718 + 3718 + 535000 + 21000 });
  assert.strictEqual(snapshot(), before, 'listing changes no invoice');
  assert.strictEqual(writes.length, 0);
});

t('a cleared opening item returns to the list; a later revocation takes it off again (latest decision wins)', async () => {
  clear('op-bam-jul');
  let r = await listPayableInvoices({ community_id: 'c-cg' });
  assert.ok(r.invoices.some((i) => i.id === 'op-bam-jul'), 'cleared -> payable');
  assert.strictEqual(r.held_opening_ap.count, 3);
  clear('op-bam-jul', 'revoked', '2026-10-11T10:00:00Z');
  r = await listPayableInvoices({ community_id: 'c-cg' });
  assert.ok(!r.invoices.some((i) => i.id === 'op-bam-jul'), 'revoked -> held again');
  assert.strictEqual(r.held_opening_ap.count, 4);
});

t('no clearance table yet (before migration 504) or a clearance read error: nothing is cleared, opening AP stays held', async () => {
  clear('op-bam-jul');
  failRead.opening_ap_payment_clearances = { code: 'PGRST205', message: "Could not find the table 'public.opening_ap_payment_clearances' in the schema cache" };
  let r = await listPayableInvoices({ community_id: 'c-cg' });
  assert.strictEqual(r.held_opening_ap.count, 4);
  failRead.opening_ap_payment_clearances = { code: '57014', message: 'canceling statement due to statement timeout' };
  r = await listPayableInvoices({ community_id: 'c-cg' });
  assert.strictEqual(r.held_opening_ap.count, 4);
});

t('provenance cannot be read -> the list REFUSES (never an unguarded list)', async () => {
  failRead.journal_entries = { code: '57014', message: 'timeout' };
  await assert.rejects(listPayableInvoices({ community_id: 'c-cg' }), (e) => e.code === 'opening_ap_guard_unavailable');
  reset(); failRead.onboarding_execution_writes = { code: '57014', message: 'timeout' };
  await assert.rejects(listPayableInvoices({ community_id: 'c-cg' }), (e) => e.code === 'opening_ap_guard_unavailable');
});

// ---- the check run (server side; the UI can be bypassed) --------------------
t('createCheckRun with a held opening invoice (bypassing the list) is REFUSED before any check number or write; the bill is named', async () => {
  const before = snapshot();
  await assert.rejects(
    createCheckRun({ community_id: 'c-cg', bank_account_id: 'ba-1', payment_date: '2026-10-10', invoice_ids: ['cur-bam-oct', 'op-bam-jul'] }),
    (e) => e.code === 'opening_ap_not_cleared' && /2607CG/.test(e.message) && e.invoices.length === 1 && e.invoices[0].invoice_id === 'op-bam-jul');
  assert.strictEqual(writes.length, 0, 'no rpc (check number), no insert, no update');
  assert.strictEqual(snapshot(), before, 'the liability is exactly as converted');
});

t('every one of Canyon Gate\'s held kinds is refused: the two no-invoice MUD bills, and the write-log-only item', async () => {
  for (const id of ['op-mud-1', 'op-mud-2', 'op-logged']) {
    await assert.rejects(createCheckRun({ community_id: 'c-cg', bank_account_id: 'ba-1', payment_date: '2026-10-10', invoice_ids: [id] }), (e) => e.code === 'opening_ap_not_cleared', id);
  }
  assert.strictEqual(writes.length, 0);
});

t('after an explicit clearance the run passes the opening-AP guard (and meets the next existing control: no-address)', async () => {
  // GymTech360 has no address on file: the run's next control refuses it, proving the guard let the cleared bill through.
  db.ap_invoices.push({ ...db.ap_invoices.find((i) => i.id === 'op-bam-jul'), id: 'op-gym-open', vendor_id: 'v-gym', vendor_invoice_number: 'GYM-OPEN' });
  clear('op-gym-open');
  await assert.rejects(createCheckRun({ community_id: 'c-cg', bank_account_id: 'ba-1', payment_date: '2026-10-10', invoice_ids: ['op-gym-open'] }), (e) => e.code === 'vendor_no_address');
});

t('ordinary current AP is not affected by the guard (reaches the same next control)', async () => {
  await assert.rejects(createCheckRun({ community_id: 'c-cg', bank_account_id: 'ba-1', payment_date: '2026-10-10', invoice_ids: ['cur-gym'] }), (e) => e.code === 'vendor_no_address');
});

// ---- recordPayment: the chokepoint behind checks, ACH mark-paid and /payments --
t('recordPayment refuses a held opening invoice by ACH and by check, writing nothing (the 9 drafted items can\'t be "marked paid" into a second cash outflow)', async () => {
  const before = snapshot();
  for (const payment_method of ['ach', 'check']) {
    await assert.rejects(recordPayment({ community_id: 'c-cg', vendor_id: 'v-mud', amount_cents: 3718, payment_date: '2026-10-10', payment_method, applications: [{ invoice_id: 'op-mud-1', applied_cents: 3718 }] }),
      (e) => e.code === 'opening_ap_not_cleared');
  }
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(snapshot(), before);
});

t('recordPayment for ordinary AP is not stopped by the guard', async () => {
  // it goes on to the GL (which this fake does not carry), so it fails LATER, never with the guard's code
  await assert.rejects(recordPayment({ community_id: 'c-cg', vendor_id: 'v-bam', amount_cents: 535000, payment_date: '2026-10-10', payment_method: 'check', applications: [{ invoice_id: 'cur-bam-oct', applied_cents: 535000 }] }),
    (e) => e.code !== 'opening_ap_not_cleared');
});

// ---- approval is not a release path ------------------------------------------
t('a future conversion item in conversion_review cannot be approved into the pay list; only a clearance releases it', async () => {
  db.ap_invoices.push({ ...db.ap_invoices.find((i) => i.id === 'op-mud-1'), id: 'op-future', status: 'conversion_review' });
  await assert.rejects(approveInvoice({ invoice_id: 'op-future', user_id: null }), (e) => e.code === 'invalid_state' && /clearance/.test(e.message));
  assert.strictEqual(db.ap_invoices.find((i) => i.id === 'op-future').status, 'conversion_review');
  const r = await listPayableInvoices({ community_id: 'c-cg' });
  assert.ok(!r.invoices.some((i) => i.id === 'op-future'), 'not in a payable status either');
});

// ---- the guard directly --------------------------------------------------------
t('openingApHolds: no invoices -> nothing; an invoice with no posting entry and no write-log row is not opening AP', async () => {
  assert.strictEqual((await guard.openingApHolds(sb, [])).size, 0);
  db.ap_invoices.push({ id: 'cur-unposted', posting_journal_entry_id: null });
  assert.strictEqual((await guard.openingApHolds(sb, [{ id: 'cur-unposted', posting_journal_entry_id: null }])).size, 0);
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of results) {
    reset();
    try { await fn(); console.log('  ✓', name); passed++; } catch (e) { console.log('  ✗', name, '\n      ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e); failed++; }
  }
  Module._load = realLoad;
  console.log(`\nopening_ap_guard: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
