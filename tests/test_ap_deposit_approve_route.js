// tests/test_ap_deposit_approve_route.js — the REAL Express approval route
// (api/ap.js POST /invoices/:id/approve) against a deposit candidate. ChatGPT's
// review (2026-09-28) asked for a route-level test, not just helper tests, so a
// select-list or wiring mistake in the route can't silently skip the hold.
// Mounts the actual router with a fake Supabase client, a fake session resolver
// and a fake approval engine, then makes real HTTP calls.
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');
const { fakeDb } = require('./_fake_supabase_deposits');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

const DEP = { id: 'dep-1', community_id: 'c1', vendor_id: 'v1', deposit_invoice_id: 'inv-dep', deposit_amount_cents: 334250, remaining_balance_cents: 334250, status: 'outstanding' };
const baseSeed = (over = {}) => ({
  vendor_deposits: [{ ...DEP }],
  ap_invoices: [
    { id: 'inv-dep', community_id: 'c1', vendor_id: 'v1', vendor_invoice_number: '2836', total_cents: 334250, amount_paid_cents: 334250, status: 'paid', posting_journal_entry_id: 'je-dep', notes: 'Emma: DEPOSIT invoice' },
    { id: 'inv-final', community_id: 'c1', vendor_id: 'v1', vendor_invoice_number: '2901', total_cents: 334250, amount_paid_cents: 0, status: 'awaiting_approval', posting_journal_entry_id: 'je-final', notes: '' },
    { id: 'inv-plain', community_id: 'c1', vendor_id: 'v-other', vendor_invoice_number: 'L-9', total_cents: 12000, amount_paid_cents: 0, status: 'awaiting_approval', posting_journal_entry_id: 'je-plain', notes: '' },
  ],
  ap_invoice_approvals: [], ap_invoice_lines: [], ap_invoice_documents: [],
  vendor_deposit_reconciliations: [], vendor_deposit_reconciliation_decisions: [], vendor_deposit_events: [],
  journal_entries: [], ...over,
});

// ---- load the real router with faked collaborators -------------------------
let shared = fakeDb(baseSeed());
const released = [];
let session = { role: 'staff' };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.test';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'fake';
stub('@supabase/supabase-js', { createClient: () => new Proxy({}, { get: (_, k) => (typeof shared[k] === 'function' ? shared[k].bind(shared) : shared[k]) }) });
stub(path.join(__dirname, '..', 'api', 'users.js'), {
  resolveUserRole: async () => ({ supabaseUserId: 'sb-' + session.role, role: session.role, user: { id: 'u-' + session.role, full_name: session.role === 'admin' ? 'Ed' : 'Martha', is_active: true } }),
});
stub(path.join(__dirname, '..', 'lib', 'accounting', 'ap_engine.js'), {
  approveInvoice: async (a) => { released.push(a); return { ok: true, invoice_id: a.invoice_id }; },
  createInvoice: async () => ({}), attachSourceAndRecode: async () => ({}), recordPayment: async () => ({}), autoCodeGlAccount: async () => null,
});
stub(path.join(__dirname, '..', 'lib', 'ap', 'recurring.js'), { getRecurrenceProfile: async () => null });
const { router } = require('../api/ap');
const app = express();
app.use('/api/ap', router);
const server = app.listen(0);
const port = () => server.address().port;
function post(url, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: port(), path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const reset = (over) => { shared = fakeDb(baseSeed(over)); released.length = 0; };
const approvals = () => shared._db.ap_invoice_approvals;

t('manager (key 1) cannot approve a final bill from a vendor with an outstanding deposit (no proposal yet)', async () => {
  reset(); session = { role: 'staff' };
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'deposit_reconciliation_missing');
  assert.strictEqual(approvals().length, 0, 'no approval row written');
});
t('admin release (key 2) is refused too; nothing is released', async () => {
  reset(); session = { role: 'admin' };
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.strictEqual(r.status, 409); assert.strictEqual(released.length, 0);
});
t('a pending (confirmed) reconciliation still refuses release: Emma cannot release it', async () => {
  reset(); session = { role: 'admin' };
  shared._db.vendor_deposit_reconciliations.push({ id: 'rec-1', deposit_id: 'dep-1', incoming_invoice_id: 'inv-final', form: 'balance_only', net_due_cents: 334250, created_at: '2026-09-28T12:00:00Z' });
  shared._db.vendor_deposit_reconciliation_decisions.push({ id: 'd1', reconciliation_id: 'rec-1', decision: 'confirmed_match', created_at: '2026-09-28T12:01:00Z' });
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.deepStrictEqual([r.status, r.body.error], [409, 'deposit_accounting_pending']);
  assert.ok(/Emma cannot release/.test(r.body.detail));
});
t('missing migration 471 ledger: the route holds (fails closed), never releases', async () => {
  reset({ _missing: ['vendor_deposit_reconciliations'] }); session = { role: 'admin' };
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.deepStrictEqual([r.status, r.body.error], [409, 'deposit_check_unavailable']); assert.strictEqual(released.length, 0);
});
t('multiple outstanding deposits: resolving one is not enough', async () => {
  reset({ vendor_deposits: [{ ...DEP }, { ...DEP, id: 'dep-2', deposit_invoice_id: 'inv-dep2' }] }); session = { role: 'admin' };
  shared._db.vendor_deposit_reconciliations.push({ id: 'rec-1', deposit_id: 'dep-1', incoming_invoice_id: 'inv-final', form: 'balance_only', net_due_cents: 334250, created_at: '2026-09-28T12:00:00Z' });
  shared._db.vendor_deposit_reconciliation_decisions.push({ id: 'd1', reconciliation_id: 'rec-1', decision: 'unrelated', created_at: '2026-09-28T12:01:00Z' });
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.deposit_id, 'dep-2');
});
t('recorded deposit accounting at the net due releases through the normal route; a changed bill is re-held', async () => {
  reset(); session = { role: 'admin' };
  shared._db.vendor_deposit_reconciliations.push({ id: 'rec-1', deposit_id: 'dep-1', incoming_invoice_id: 'inv-final', form: 'balance_only', net_due_cents: 334250, created_at: '2026-09-28T12:00:00Z' });
  shared._db.journal_entries.push({ id: 'je-final', community_id: 'c1', status: 'posted' });
  shared._db.vendor_deposit_reconciliation_decisions.push({ id: 'd1', reconciliation_id: 'rec-1', decision: 'manual_accounting_recorded', verified_invoice_total_cents: 334250,
    verified_deposit_paid_cents: 334250, verified_bill_posting_je_id: 'je-final', verified_bill_lines: [], created_at: '2026-09-28T12:01:00Z' });
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(released.length, 1);
  shared._db.ap_invoices.find((i) => i.id === 'inv-final').total_cents = 668500; released.length = 0;
  const r2 = await post('/api/ap/invoices/inv-final/approve');
  assert.deepStrictEqual([r2.status, r2.body.error], [409, 'invoice_changed_after_accounting']); assert.strictEqual(released.length, 0);
});
t('bills that are NOT deposit candidates keep working: other vendors, and the deposit bill itself', async () => {
  reset(); session = { role: 'staff' };
  const m = await post('/api/ap/invoices/inv-plain/approve');
  assert.strictEqual(m.status, 200, JSON.stringify(m.body)); assert.strictEqual(approvals().length, 1, 'manager key recorded as usual');
  session = { role: 'admin' };
  const a = await post('/api/ap/invoices/inv-plain/approve');
  assert.strictEqual(a.status, 200); assert.strictEqual(released.length, 1);
  shared._db.ap_invoices.find((i) => i.id === 'inv-dep').status = 'awaiting_approval';
  const d = await post('/api/ap/invoices/inv-dep/approve');
  assert.strictEqual(d.status, 200, 'the deposit bill is not held by its own deposit');
});


// ---- a recorded attestation is re-validated on EVERY approval and payment ----
function attest() {
  reset({ vendor_deposits: [{ ...DEP, gl_account_id: 'acct-1430' }] });
  const db = shared._db;
  db.ap_invoice_lines.push({ id: 'l1', invoice_id: 'inv-final', gl_account_id: 'acct-5900', amount_cents: 334250 });
  db.journal_entries.push({ id: 'je-final', community_id: 'c1', status: 'posted', voided_at: null }, { id: 'je-rel', community_id: 'c1', status: 'posted', voided_at: null });
  db.journal_entry_lines = [{ journal_entry_id: 'je-rel', account_id: 'acct-5900', debit_cents: 334250, credit_cents: 0 }, { journal_entry_id: 'je-rel', account_id: 'acct-1430', debit_cents: 0, credit_cents: 334250 }];
  db.vendor_deposit_reconciliations.push({ id: 'rec-1', deposit_id: 'dep-1', incoming_invoice_id: 'inv-final', form: 'balance_only', net_due_cents: 334250, deposit_billed_cents: 334250, created_at: '2026-09-28T12:00:00Z' });
  db.vendor_deposit_reconciliation_decisions.push({ id: 'd1', reconciliation_id: 'rec-1', decision: 'manual_accounting_recorded', accounting_je_id: 'je-rel', deposit_accounting_state: 'prepaid',
    verified_invoice_total_cents: 334250, verified_deposit_paid_cents: 334250, verified_bill_posting_je_id: 'je-final',
    verified_bill_lines: [{ gl_account_id: 'acct-5900', amount_cents: 334250 }], created_at: '2026-09-28T12:01:00Z' });
  return db;
}
const mutations = [
  ['the relief JE is voided', (db) => { db.journal_entries.find((j) => j.id === 'je-rel').voided_at = '2026-09-29T00:00:00Z'; }, 'relief_entry_no_longer_valid'],
  ['the relief JE is no longer posted', (db) => { db.journal_entries.find((j) => j.id === 'je-rel').status = 'draft'; }, 'relief_entry_no_longer_valid'],
  ['the relief JE no longer credits 1430 for the deposit', (db) => { db.journal_entry_lines.find((l) => l.account_id === 'acct-1430').credit_cents = 300000; }, 'relief_entry_no_longer_valid'],
  ["the bill is RECODED at the same total", (db) => { db.ap_invoice_lines.find((l) => l.id === 'l1').gl_account_id = 'acct-5100'; }, 'bill_coding_changed_after_accounting'],
  ["the bill's posting JE is voided", (db) => { db.journal_entries.find((j) => j.id === 'je-final').voided_at = '2026-09-29T00:00:00Z'; }, 'bill_posting_changed_after_accounting'],
  ["the bill is re-posted under a new JE", (db) => { db.ap_invoices.find((i) => i.id === 'inv-final').posting_journal_entry_id = 'je-new'; db.journal_entries.push({ id: 'je-new', community_id: 'c1', status: 'posted' }); }, 'bill_posting_changed_after_accounting'],
  ["the deposit's payment changes (refund/reversal)", (db) => { db.ap_invoices.find((i) => i.id === 'inv-dep').amount_paid_cents = 0; }, 'deposit_payment_changed_after_accounting'],
];
t('baseline: a valid, unchanged attestation releases (admin) through the route', async () => {
  attest(); session = { role: 'admin' };
  const r = await post('/api/ap/invoices/inv-final/approve');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});
for (const [what, mutate, reason] of mutations) {
  t(`after attestation, ${what}: BOTH approval keys are refused again (${reason})`, async () => {
    const db = attest(); mutate(db);
    session = { role: 'staff' };
    const m = await post('/api/ap/invoices/inv-final/approve');
    assert.deepStrictEqual([m.status, m.body && m.body.error], [409, reason]);
    session = { role: 'admin' };
    const a = await post('/api/ap/invoices/inv-final/approve');
    assert.deepStrictEqual([a.status, a.body && a.body.error], [409, reason]); assert.strictEqual(released.length, 0);
  });
}
t('payment surfaces re-check too: mark-paid and /payments refuse a bill whose attestation went stale', async () => {
  const db = attest(); db.ap_invoices.find((i) => i.id === 'inv-final').status = 'approved';
  db.journal_entries.find((j) => j.id === 'je-rel').voided_at = '2026-09-29T00:00:00Z';
  session = { role: 'admin' };
  const mp = await post('/api/ap/invoices/inv-final/mark-paid', { method: 'ach' });
  assert.deepStrictEqual([mp.status, mp.body.error], [409, 'relief_entry_no_longer_valid']);
  const pay = await post('/api/ap/payments', { community_id: 'c1', vendor_id: 'v1', amount_cents: 334250, applications: [{ invoice_id: 'inv-final', applied_cents: 334250 }] });
  assert.strictEqual(pay.status, 409);
});
t('check run: a held bill is not listed as payable and cannot be put in a run; other bills still pay', async () => {
  const db = attest(); db.journal_entries.find((j) => j.id === 'je-rel').voided_at = '2026-09-29T00:00:00Z';
  db.ap_invoices.find((i) => i.id === 'inv-final').status = 'approved';
  db.ap_invoices.find((i) => i.id === 'inv-plain').status = 'approved';
  db.bank_accounts = [{ id: 'bank-1', community_id: 'c1' }];
  const cr = require('../lib/accounting/check_run');
  const list = await cr.listPayableInvoices({ community_id: 'c1' });
  assert.deepStrictEqual(list.map((i) => i.id).sort(), ['inv-plain']);
  await assert.rejects(() => cr.createCheckRun({ community_id: 'c1', bank_account_id: 'bank-1', payment_date: '2026-10-10', invoice_ids: ['inv-final'], user: {} }), /Held for a vendor deposit: 2901/);
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  server.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall approval-route deposit checks passed');
  process.exitCode = failed ? 1 : 0;
})();
