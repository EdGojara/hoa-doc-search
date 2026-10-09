#!/usr/bin/env node
// ============================================================================
// tests/test_clear_posted_entry.js
// ----------------------------------------------------------------------------
// A posted journal entry is never left with its lines gone and its header
// still standing, and an entry another entry reverses is never deleted.
//
// THE SCAR (2026-09-28/29, Lakes of Pine Forest). Re-coding four UNPAID Barker
// Cypress MUD bills (5205 -> 5120) ran, in api/ap.js:
//     try { delete journal_entry_lines; delete journal_entries } catch { stop }
// supabase-js returns { error } instead of throwing. The lines went; the header
// delete was refused by the FK from CONV-LPF-20260731-NEUT-JE-2026-0017x
// (reverses_je_id, ON DELETE RESTRICT); nobody looked at the error; the bills
// were re-posted. JE-2026-00169..00172 have had no lines since, while their
// NEUT reversals still count: July expense understated by $3,409.50 and a stray
// debit in AP 2000.
//
// This test drives the REAL routes (POST /invoices/:id/code, line code,
// hold-prior-periods) against an in-memory database that enforces the same
// foreign keys as migration 170. The first case is JE-2026-00169 exactly as it
// stood before the re-code; on the old code it fails (lines gone).
// Offline: no network, no real database.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

// ---------------------------------------------------------------- fake database
let db;
let seq = 0;
const nid = (p) => `${p}-${++seq}`;
const faults = {};   // e.g. faults.lines_delete = true, faults.lines_restore = true
const FK_RESTRICT = [   // child table, column -> journal_entries.id (migration 170 + later)
  ['journal_entry_lines', 'journal_entry_id'],
  ['journal_entries', 'reverses_je_id'],
  ['journal_entries', 'void_reversal_je_id'],
  ['assessment_prorations', 'journal_entry_id'],
];
const FK_SET_NULL = [['ap_invoices', 'posting_journal_entry_id'], ['ar_charges', 'posting_journal_entry_id']];

function fakeClient() {
  return {
    rpc: async (fn, args) => {
      if (fn === 'next_je_reference') return { data: `JE-${args.p_fiscal_year}-T${String(++seq).padStart(4, '0')}`, error: null };
      return { data: null, error: { message: `rpc ${fn} not faked` } };
    },
    from(table) {
      if (!db[table]) db[table] = [];
      const st = { op: 'select', f: [], order: null, limit: null, patch: null, rows: null, wantRows: false };
      const match = (r) => st.f.every((fn) => fn(r));
      const run = () => {
        const all = db[table];
        if (st.op === 'insert') {
          if (table === 'journal_entry_lines' && faults.lines_restore && st.rows.some((r) => r.id)) return { data: null, error: { message: 'injected: restore failed' } };
          const out = st.rows.map((r) => ({ id: r.id || nid(table), created_at: r.created_at || new Date().toISOString(), ...r }));
          all.push(...out);
          return { data: st.wantRows ? out : null, error: null };
        }
        if (st.op === 'update') {
          const hit = all.filter(match);
          hit.forEach((r) => Object.assign(r, st.patch));
          return { data: st.wantRows ? hit : null, error: null };
        }
        if (st.op === 'delete') {
          if (table === 'journal_entry_lines' && faults.lines_delete) return { data: null, error: { message: 'injected: lines delete failed' } };
          const hit = all.filter(match);
          if (table === 'journal_entries') {
            for (const h of hit) {
              for (const [ct, col] of FK_RESTRICT) {
                if ((db[ct] || []).some((c) => c[col] === h.id && !hit.includes(c))) {
                  return { data: null, error: { code: '23503', message: `update or delete on table "journal_entries" violates foreign key constraint on table "${ct}"` } };
                }
              }
            }
            for (const h of hit) for (const [ct, col] of FK_SET_NULL) (db[ct] || []).forEach((c) => { if (c[col] === h.id) c[col] = null; });
          }
          db[table] = all.filter((r) => !hit.includes(r));
          return { data: st.wantRows ? hit : null, error: null };
        }
        let rows = all.filter(match).map((r) => ({ ...r }));
        if (table === 'ap_invoices') rows = rows.map((r) => ({ vendors: { name: 'BARKER CYPRESS M.U.D.' }, ...r }));
        if (st.order) rows.sort((a, b) => (a[st.order] > b[st.order] ? 1 : a[st.order] < b[st.order] ? -1 : 0));
        if (st.limit != null) rows = rows.slice(0, st.limit);
        return { data: rows, error: null };
      };
      const q = {
        select() { st.wantRows = true; return q; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return q; },
        update(p) { st.op = 'update'; st.patch = p; return q; },
        upsert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return q; },
        delete() { st.op = 'delete'; return q; },
        eq(c, v) { st.f.push((r) => r[c] === v); return q; },
        neq(c, v) { st.f.push((r) => r[c] !== v); return q; },
        is(c, v) { st.f.push((r) => (r[c] == null ? null : r[c]) === v); return q; },
        in(c, vs) { st.f.push((r) => vs.includes(r[c])); return q; },
        lte(c, v) { st.f.push((r) => r[c] <= v); return q; },
        gte(c, v) { st.f.push((r) => r[c] >= v); return q; },
        lt(c, v) { st.f.push((r) => r[c] < v); return q; },
        gt(c, v) { st.f.push((r) => r[c] > v); return q; },
        ilike(c, p) { const re = new RegExp('^' + String(p).replace(/%/g, '.*') + '$', 'i'); st.f.push((r) => re.test(String(r[c] || ''))); return q; },
        not() { return q; }, or() { return q; }, filter() { return q; },
        order(c) { st.order = c; return q; },
        limit(n) { st.limit = n; return q; },
        range(a, b) { st.limit = b - a + 1; return q; },
        maybeSingle: async () => { const r = run(); if (r.error) return r; const d = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []); return { data: d[0] || null, error: null }; },
        single: async () => { const r = run(); if (r.error) return r; const d = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []); return d.length ? { data: d[0], error: null } : { data: null, error: { message: 'no rows' } }; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

// ---------------------------------------------------------------- fixtures
// Lakes of Pine Forest, as of 2026-09-28: cutover 8/1, July still OPEN.
const C = 'c-lopf';
const A = { x5205: 'a-5205', x5120: 'a-5120', x5890: 'a-5890', x2000: 'a-2000' };
const V = 'v-barker';
function seed() {
  seq = 0;
  Object.keys(faults).forEach((k) => delete faults[k]);
  db = {
    communities: [{ id: C, name: 'Lakes of Pine Forest', gl_cutover_date: '2026-08-01' }],
    accounting_periods: ['07', '08', '09', '10'].map((m) => ({ id: `p-${m}`, community_id: C, fiscal_year: 2026, period_number: Number(m), period_start: `2026-${m}-01`, period_end: `2026-${m}-${m === '09' ? '30' : '31'}`, status: 'open' })),
    chart_of_accounts: [
      { id: A.x5205, community_id: C, account_number: '5205', account_name: 'Landscaping Maintenance (Lakes - MUD)', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x5120, community_id: C, account_number: '5120', account_name: 'Water', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x5890, community_id: C, account_number: '5890', account_name: 'Other Taxes & Fees', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x2000, community_id: C, account_number: '2000', account_name: 'Accounts Payable', is_active: true, is_summary: false, fund_id: 'f-opr' },
    ],
    account_funds: [],
    journal_entries: [], journal_entry_lines: [], ap_invoices: [], ap_invoice_lines: [], ap_invoice_approvals: [],
    ar_charges: [], homeowner_ledger_entries: [], assessment_prorations: [],
  };
}
const je = (id, o) => db.journal_entries.push({ id, community_id: C, status: 'posted', reverses_je_id: null, void_reversal_je_id: null, source_module: 'ap_invoice', ...o });
const jl = (jeId, n, acct, d, c, memo) => db.journal_entry_lines.push({ id: `${jeId}-L${n}`, journal_entry_id: jeId, line_number: n, account_id: acct, fund_id: 'f-opr', debit_cents: d, credit_cents: c, memo, vendor_id: V });
// JE-2026-00169 exactly (reconstructed from CONV-LPF-20260731-NEUT-JE-2026-00169).
const JE169_LINES = [[A.x5205, 40725, 0, 'Previous Balance'], [A.x5205, 0, 40725, 'Payment Received'], [A.x5205, 17525, 0, 'Water Charges'], [A.x5205, 29500, 0, 'WHCRWA Fee'], [A.x2000, 0, 47025, 'AP — BARKER CYPRESS M.U.D.']];
// The conversion (CONV-LPF-20260731, posted 9/24) neutralized it on 7/28 and
// re-posted the same lines on the 8/1 cutover: the RE-POST was the live accrual.
function seedLopfBill({ neut = true, repost = true, paid = false, period = 'p-07', date = '2026-07-28' } = {}) {
  je('je-169', { reference: 'JE-2026-00169', period_id: period, posting_date: date, total_debits_cents: 87750, total_credits_cents: 87750, source_reference: 'inv-1' });
  JE169_LINES.forEach(([a, d, c, m], i) => jl('je-169', i + 1, a, d, c, m));
  if (neut) {
    je('je-neut', { reference: 'CONV-LPF-20260731-NEUT-JE-2026-00169', period_id: period, posting_date: date, total_debits_cents: 87750, total_credits_cents: 87750, source_module: 'reversal', reverses_je_id: 'je-169' });
    JE169_LINES.forEach(([a, d, c, m], i) => jl('je-neut', i + 1, a, c, d, m));
    if (repost) {
      je('je-repost', { reference: 'CONV-LPF-20260731-REPOST-JE-2026-00169', period_id: 'p-08', posting_date: '2026-08-01', total_debits_cents: 87750, total_credits_cents: 87750, source_module: 'manual', source_reference: 'je-169' });
      JE169_LINES.forEach(([a, d, c, m], i) => jl('je-repost', i + 1, a, d, c, m));
    }
  }
  db.ap_invoices.push({ id: 'inv-1', community_id: C, vendor_id: V, vendor_invoice_number: '29354487', invoice_date: '2026-07-28', total_cents: 47025, tax_cents: 0, status: paid ? 'paid' : 'approved', paid_at: paid ? '2026-09-28T21:21:24Z' : null, posting_journal_entry_id: 'je-169', coded_gl_account_id: A.x5205, cutover_review: 'NOT_IN_CONVERTED_BOOKS' });
  [['Previous Balance', 40725], ['Payment Received', -40725], ['Water Charges', 17525], ['WHCRWA Fee', 29500]].forEach(([d, c], i) => db.ap_invoice_lines.push({ id: `il-${i + 1}`, invoice_id: 'inv-1', line_number: i + 1, description: d, amount_cents: c, gl_account_id: A.x5205 }));
}
const linesOf = (id) => db.journal_entry_lines.filter((l) => l.journal_entry_id === id);
const counted = () => { const ok = new Set(db.journal_entries.filter((j) => j.status === 'posted' || (j.status === 'voided' && j.void_reversal_je_id)).map((j) => j.id)); return db.journal_entry_lines.filter((l) => ok.has(l.journal_entry_id)); };
// Net (debit - credit) by account number, optionally by month, over every counted line.
function net({ month } = {}) {
  const out = {};
  for (const l of counted()) {
    const h = db.journal_entries.find((j) => j.id === l.journal_entry_id);
    if (month && String(h.posting_date).slice(0, 7) !== month) continue;
    const n = db.chart_of_accounts.find((a) => a.id === l.account_id).account_number;
    out[n] = (out[n] || 0) + l.debit_cents - l.credit_cents;
  }
  Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
  return out;
}
const noOrphans = () => db.journal_entries.filter((j) => j.status !== 'draft' && !linesOf(j.id).length).map((j) => j.reference);

// ---------------------------------------------------------------- boot the real router
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
const realLoad = Module._load;
Module._load = function (request, parent) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  if (request === '@anthropic-ai/sdk') { const B = function () { this.messages = { create: async () => { throw new Error('network blocked in test'); } }; }; B.default = B; return B; }
  if (request === './users' && parent && /[\\/]api[\\/]ap\.js$/.test(parent.filename)) {
    return { resolveUserRole: async () => ({ supabaseUserId: 'u-1', user: { id: 'u-1', full_name: 'Test Staff', is_active: true } }) };
  }
  return realLoad.apply(this, arguments);
};
seed();
const express = require('express');
const { router } = require('../api/ap');
const { clearPostedEntry } = require('../lib/accounting/clear_entry');
const app = express();
app.use('/api/ap', router);

let server; let base;
async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let failed = 0; let passed = 0;
const realError = console.error;   // the routes log loudly on purpose; silenced below, but never our FAILs
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; realError('  FAIL', name, '\n       ', e.message); }
}

(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const origWarn = console.warn; const origErr = console.error;
  console.warn = () => {}; console.error = () => {};
  const restoreConsole = () => { console.warn = origWarn; console.error = origErr; };
  const log = (...a) => origErr(...a);
  console.log('test_clear_posted_entry');

  // -------------------------------------------------------------- the scar
  await t('LOPF scar: re-coding an UNPAID bill whose accrual a conversion NEUT reverses never strips its lines', async () => {
    seed(); seedLopfBill();
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(linesOf('je-169').length, 5, `JE-2026-00169 lost its lines (has ${linesOf('je-169').length}): the LOPF scar is back. Response ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(db.journal_entries.find((j) => j.id === 'je-169'), 'header still there');
    assert.strictEqual(linesOf('je-neut').length, 5, 'NEUT untouched');
    assert.deepStrictEqual(noOrphans(), [], 'no posted header without lines');
  });

  await t('...the original is not reversed twice; the live conversion RE-POST is what gets voided, on its own date', async () => {
    // continues from the case above
    assert.strictEqual(db.journal_entries.filter((j) => j.reverses_je_id === 'je-169').length, 1, 'only the conversion NEUT reverses the original');
    const rp = db.journal_entries.find((j) => j.id === 'je-repost');
    assert.strictEqual(rp.status, 'voided', 'the re-post (the live accrual) is voided');
    assert.strictEqual(linesOf('je-repost').length, 5, 'and keeps its lines');
    const rev = db.journal_entries.find((j) => j.id === rp.void_reversal_je_id);
    assert.strictEqual(rev.posting_date, '2026-08-01', 'reversed on its own date so August carries the bill once');
  });

  await t('...July nets to zero and August carries the bill exactly once, in the new account', async () => {
    assert.deepStrictEqual(net({ month: '2026-07' }), {}, `July: ${JSON.stringify(net({ month: '2026-07' }))}`);
    assert.deepStrictEqual(net({ month: '2026-08' }), { 5120: 47025, 2000: -47025 }, `August: ${JSON.stringify(net({ month: '2026-08' }))}`);
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 }, `whole GL: ${JSON.stringify(net())}`);
    const inv = db.ap_invoices.find((i) => i.id === 'inv-1');
    const nj = db.journal_entries.find((j) => j.id === inv.posting_journal_entry_id);
    assert.ok(nj && nj.posting_date === '2026-08-01', 'new accrual posted at the GL cutover');
    const note = db.ap_invoice_approvals.find((a) => a.invoice_id === 'inv-1');
    assert.ok(note && /CONV-LPF-20260731-REPOST-JE-2026-00169 voided by reversal/.test(note.notes), `audit note says what happened: ${note && note.notes}`);
  });

  await t('neutralized with NO re-post (bill not live): nothing to clear, original untouched, bill posted once', async () => {
    seed(); seedLopfBill({ repost: false });
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(linesOf('je-169').length, 5);
    assert.strictEqual(db.journal_entries.filter((j) => j.source_module === 'reversal').length, 1, 'no new reversal');
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
    assert.ok(/already reversed by CONV-LPF-20260731-NEUT-JE-2026-00169/.test(db.ap_invoice_approvals[0].notes), db.ap_invoice_approvals[0].notes);
  });

  await t('same through the LINE re-code route', async () => {
    seed(); seedLopfBill();
    const r = await post('/api/ap/invoices/inv-1/lines/il-3/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(linesOf('je-169').length, 5, `lines stripped via line code (${r.status} ${JSON.stringify(r.body)})`);
    assert.strictEqual(db.journal_entries.filter((j) => j.reverses_je_id === 'je-169').length, 1);
    assert.deepStrictEqual(net({ month: '2026-07' }), {});
    assert.deepStrictEqual(noOrphans(), []);
  });

  await t('a PAID bill whose accrual is NEUT-reversed is not voided a second time', async () => {
    seed(); seedLopfBill({ paid: true });
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: 'water, not landscaping' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(db.journal_entries.filter((j) => j.reverses_je_id === 'je-169').length, 1, 'a second reversal would take July negative');
    assert.deepStrictEqual(net({ month: '2026-07' }), {});
    assert.strictEqual(db.journal_entries.find((j) => j.id === 'je-repost').status, 'voided', 'paid: the live re-post is reversed (audit trail)');
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
  });

  // -------------------------------------------------------------- the rules
  await t('unreferenced, unpaid, open period, after cutover: deleted cleanly and re-posted (no reversal litter)', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!db.journal_entries.find((j) => j.id === 'je-169'), 'old accrual deleted');
    assert.strictEqual(db.journal_entries.filter((j) => j.source_module === 'reversal').length, 0, 'no reversal');
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
    assert.deepStrictEqual(noOrphans(), []);
  });

  await t('pre-cutover entry (converted books) is voided by reversal, never deleted, even with the period open', async () => {
    seed(); seedLopfBill({ neut: false });
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const h = db.journal_entries.find((j) => j.id === 'je-169');
    assert.ok(h && h.status === 'voided' && h.void_reversal_je_id, 'voided with a reversal');
    assert.strictEqual(linesOf('je-169').length, 5, 'lines kept');
    assert.deepStrictEqual(noOrphans(), []);
  });

  await t('closed period: voided by reversal, never deleted', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-08', date: '2026-08-15' });
    db.accounting_periods.find((p) => p.id === 'p-08').status = 'closed';
    await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    const h = db.journal_entries.find((j) => j.id === 'je-169');
    assert.ok(h && h.status === 'voided', 'voided');
    assert.strictEqual(linesOf('je-169').length, 5);
  });

  await t('header delete refused by an unforeseen reference: lines put back, then voided by reversal', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    db.assessment_prorations.push({ id: 'ap-1', journal_entry_id: 'je-169' });
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(linesOf('je-169').length, 5, 'lines restored');
    assert.strictEqual(db.journal_entries.find((j) => j.id === 'je-169').status, 'voided');
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
    assert.deepStrictEqual(noOrphans(), []);
  });

  await t('a failed lines delete stops the re-code: nothing changed, nothing re-posted, clear message', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    faults.lines_delete = true;
    const before = JSON.stringify(net());
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'lines_delete_failed');
    assert.ok(/Nothing was changed/.test(r.body.detail) && /not changed/.test(r.body.detail), r.body.detail);
    assert.strictEqual(JSON.stringify(net()), before, 'GL unchanged');
    assert.strictEqual(db.ap_invoices[0].posting_journal_entry_id, 'je-169');
    assert.strictEqual(db.ap_invoices[0].coded_gl_account_id, A.x5205);
  });

  await t('if lines were removed and cannot be put back, it fails LOUD (500, names the entry), never silent', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    db.assessment_prorations.push({ id: 'ap-1', journal_entry_id: 'je-169' });
    faults.lines_restore = true;
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.body.error, 'lines_restore_failed');
    assert.ok(/JE-2026-00169/.test(r.body.detail) && /tell Ed/i.test(r.body.detail), r.body.detail);
    assert.strictEqual(db.ap_invoices[0].posting_journal_entry_id, 'je-169', 'no re-post on top of a broken entry');
  });

  await t('hold-prior-periods uses the same rule (NEUT-reversed accrual keeps its lines)', async () => {
    seed(); seedLopfBill();
    db.ap_invoice_lines = [
      { id: 'h1', invoice_id: 'inv-1', line_number: 1, description: 'August Contract Deputy Service', amount_cents: 1423000, gl_account_id: A.x5205 },
      { id: 'h2', invoice_id: 'inv-1', line_number: 2, description: '2610S - Outstanding Invoice - July', amount_cents: 1423000, gl_account_id: A.x5205 },
    ];
    const r = await post('/api/ap/invoices/inv-1/hold-prior-periods', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(linesOf('je-169').length, 5);
    assert.strictEqual(db.journal_entries.filter((j) => j.reverses_je_id === 'je-169').length, 1);
    assert.deepStrictEqual(noOrphans(), []);
  });

  await t('the entry is itself a reversal: refused', async () => {
    seed(); seedLopfBill();
    await assert.rejects(() => clearPostedEntry({ supabase: fakeClient(), journal_entry_id: 'je-neut', allow_delete: true, void_reason: 'x' }), (e) => e.code === 'entry_is_a_reversal');
    assert.strictEqual(linesOf('je-neut').length, 5);
  });

  await t('a partial reversal is refused (what remains is unknowable)', async () => {
    seed(); seedLopfBill({ neut: false });
    je('je-part', { reference: 'JE-PART', period_id: 'p-07', posting_date: '2026-07-31', total_debits_cents: 100, total_credits_cents: 100, source_module: 'reversal', reverses_je_id: 'je-169' });
    await assert.rejects(() => clearPostedEntry({ supabase: fakeClient(), journal_entry_id: 'je-169', allow_delete: true, void_reason: 'x' }), (e) => e.code === 'entry_partially_reversed');
    assert.strictEqual(linesOf('je-169').length, 5);
  });

  await t('editJournalEntry refuses to rewrite the lines of an entry a reversal mirrors', async () => {
    seed(); seedLopfBill();
    const { editJournalEntry } = require('../lib/accounting/posting');
    await assert.rejects(() => editJournalEntry({ journal_entry_id: 'je-169', lines: [{ account_id: A.x5120, debit_cents: 47025 }, { account_id: A.x2000, credit_cents: 47025 }] }), (e) => e.code === 'invalid_state');
    assert.strictEqual(linesOf('je-169').length, 5);
  });

  const seedLateFeeRun = () => {
    seed();
    db.community_billing_policies = [{ id: 'pol', community_id: C, effective_end_date: null }];
    je('je-lf', { reference: 'JE-2026-09-FEES', period_id: 'p-09', posting_date: '2026-09-01', total_debits_cents: 2500, total_credits_cents: 2500, source_module: 'system' });
    jl('je-lf', 1, A.x2000, 2500, 0, 'AR'); jl('je-lf', 2, A.x5890, 0, 2500, 'income');
    db.ar_charges.push({ id: 'ch-1', community_id: C, posting_journal_entry_id: 'je-lf', source_module: 'late_fee_run' });
  };
  await t('late-fee run reversal: deletable run is removed whole (GL entry + AR charge), no orphan header', async () => {
    seedLateFeeRun();
    const { reverseLateFeesAndInterest } = require('../lib/accounting/late_fee_interest');
    const r = await reverseLateFeesAndInterest({ supabase: fakeClient(), communityId: C, runMonth: '2026-09' });
    assert.strictEqual(r.gl, 'deleted');
    assert.ok(!db.journal_entries.find((j) => j.id === 'je-lf') && !linesOf('je-lf').length, 'entry and lines gone together');
    assert.strictEqual(db.ar_charges.length, 0);
    assert.deepStrictEqual(noOrphans(), []);
  });
  await t('late-fee run reversal: a failed GL clear touches nothing (charges stay, lines stay)', async () => {
    seedLateFeeRun();
    faults.lines_delete = true;
    const { reverseLateFeesAndInterest } = require('../lib/accounting/late_fee_interest');
    await assert.rejects(() => reverseLateFeesAndInterest({ supabase: fakeClient(), communityId: C, runMonth: '2026-09' }), (e) => e.code === 'lines_delete_failed' && /Nothing was changed/.test(e.detail));
    assert.strictEqual(linesOf('je-lf').length, 2);
    assert.strictEqual(db.ar_charges.length, 1);
  });

  // -------------------------------------------------------------- the control
  await t('CHECK: no runtime code deletes journal entries or their lines except the sanctioned helpers', () => {
    const ALLOW = {
      'lib/accounting/clear_entry.js': 'the helper',
      'lib/accounting/posting.js': 'failed-insert rollback + editJournalEntry line replacement (both restore on failure)',
    };
    const roots = ['api', 'lib'];
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.js$/.test(e.name) || ALLOW[rel]) continue;
        const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        const re = /from\(\s*['"`]journal_entr(?:y_lines|ies)['"`]\s*\)\s*\.delete\(/g;
        let m;
        while ((m = re.exec(src))) bad.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    };
    roots.forEach(walk);
    assert.deepStrictEqual(bad, [], `raw journal-entry deletes outside lib/accounting/clear_entry.js (use clearPostedEntry):\n  ${bad.join('\n  ')}`);
  });

  restoreConsole();
  server.close();
  Module._load = realLoad;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { log('test_clear_posted_entry FAILED'); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
