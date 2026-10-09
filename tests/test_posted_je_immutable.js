#!/usr/bin/env node
// ============================================================================
// tests/test_posted_je_immutable.js
// ----------------------------------------------------------------------------
// Once a journal entry is posted, its lines are never deleted or rewritten by
// an application workflow, in an open period or a closed one (Ed 2026-10-09).
// Re-coding a posted AP invoice posts an explicit correcting entry and records
// the link (invoice, original entry, correcting entry, actor, time, reason).
//
// THE SCAR (2026-09-28/29, Lakes of Pine Forest). Re-coding four UNPAID Barker
// Cypress MUD bills (5205 -> 5120) ran, in api/ap.js:
//     try { delete journal_entry_lines; delete journal_entries } catch { stop }
// supabase-js returns { error } instead of throwing. The lines went; the header
// delete was refused by the FK from CONV-LPF-20260731-NEUT-JE-2026-0017x
// (reverses_je_id, ON DELETE RESTRICT); nobody looked; the bills were
// re-posted. JE-2026-00169..00172 have had no lines since.
//
// This test drives the REAL routes against an in-memory database that enforces
// migration 170's foreign keys AND records every attempt to delete or update
// a posted entry's lines (the invariant). The first case is JE-2026-00169
// exactly as it stood on 9/28; on the old code it fails (lines gone).
// Offline: no network, no real database.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');
const { execSync } = require('child_process');

// ---------------------------------------------------------------- fake database
let db;
let seq = 0;
const nid = (p) => `${p}-${++seq}`;
const faults = {};
let violations = [];   // every DELETE/UPDATE that touched a posted entry's lines, or deleted a posted header
const FK_RESTRICT = [
  ['journal_entry_lines', 'journal_entry_id'],
  ['journal_entries', 'reverses_je_id'],
  ['journal_entries', 'void_reversal_je_id'],
  ['journal_entry_corrections', 'original_je_id'],
  ['journal_entry_corrections', 'corrected_je_id'],
  ['journal_entry_corrections', 'correcting_je_id'],
  ['journal_entry_corrections', 'replacement_je_id'],
];
const FK_SET_NULL = [['ap_invoices', 'posting_journal_entry_id'], ['ar_charges', 'posting_journal_entry_id']];
const headerOf = (id) => db.journal_entries.find((j) => j.id === id);

function fakeClient() {
  return {
    rpc: async (fn, args) => {
      if (faults.no_reference) return { data: null, error: { message: 'injected: reference sequence unavailable' } };
      if (fn === 'next_je_reference') return { data: `JE-${args.p_fiscal_year}-T${String(++seq).padStart(4, '0')}`, error: null };
      return { data: null, error: { message: `rpc ${fn} not faked` } };
    },
    from(table) {
      if (table === 'journal_entry_corrections' && faults.no_corrections_table) {
        const err = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.journal_entry_corrections' in the schema cache" } };
        const q = { select: () => q, insert: () => q, eq: () => q, limit: () => q, then: (res, rej) => Promise.resolve(err).then(res, rej), maybeSingle: async () => err };
        return q;
      }
      if (!db[table]) db[table] = [];
      const st = { op: 'select', f: [], order: null, limit: null, patch: null, rows: null, wantRows: false };
      const match = (r) => st.f.every((fn) => fn(r));
      const run = () => {
        const all = db[table];
        if (st.op === 'insert') {
          if (table === 'journal_entry_corrections' && faults.correction_insert) return { data: null, error: { message: 'injected: link insert failed' } };
          const out = st.rows.map((r) => ({ id: r.id || nid(table), created_at: r.created_at || new Date().toISOString(), ...r }));
          all.push(...out);
          return { data: st.wantRows ? out : null, error: null };
        }
        if (st.op === 'update' || st.op === 'delete') {
          const hit = all.filter(match);
          if (table === 'journal_entry_corrections') return { data: null, error: { message: 'journal_entry_corrections is append-only' } };
          if (table === 'journal_entry_lines') {
            for (const l of hit) { const h = headerOf(l.journal_entry_id); if (h && h.status !== 'draft') violations.push(`${st.op} lines of posted ${h.reference}`); }
          }
          if (table === 'journal_entries' && st.op === 'delete') {
            for (const h of hit) if (h.status !== 'draft') violations.push(`delete posted header ${h.reference}`);
            for (const h of hit) for (const [ct, col] of FK_RESTRICT) {
              if ((db[ct] || []).some((c) => c[col] === h.id && !hit.includes(c))) return { data: null, error: { code: '23503', message: `violates foreign key constraint on table "${ct}"` } };
            }
            for (const h of hit) for (const [ct, col] of FK_SET_NULL) (db[ct] || []).forEach((c) => { if (c[col] === h.id) c[col] = null; });
          }
          if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.patch)); return { data: st.wantRows ? hit : null, error: null }; }
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
        ilike(c, p) { const re = new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); st.f.push((r) => re.test(String(r[c] || ''))); return q; },
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
// Lakes of Pine Forest as of 2026-09-28: cutover 8/1, every month still OPEN.
const C = 'c-lopf';
const A = { x5205: 'a-5205', x5120: 'a-5120', x5890: 'a-5890', x2000: 'a-2000' };
const V = 'v-barker';
const TODAY = new Date().toISOString().slice(0, 10);
function seed() {
  seq = 0; violations = [];
  Object.keys(faults).forEach((k) => delete faults[k]);
  const months = ['07', '08', '09', '10', '11', '12'];
  db = {
    communities: [{ id: C, name: 'Lakes of Pine Forest', gl_cutover_date: '2026-08-01' }],
    accounting_periods: months.map((m) => ({ id: `p-${m}`, community_id: C, fiscal_year: 2026, period_number: Number(m), period_start: `2026-${m}-01`, period_end: `2026-${m}-${['09', '11'].includes(m) ? '30' : '31'}`, status: 'open' })),
    chart_of_accounts: [
      { id: A.x5205, community_id: C, account_number: '5205', account_name: 'Landscaping Maintenance (Lakes - MUD)', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x5120, community_id: C, account_number: '5120', account_name: 'Water', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x5890, community_id: C, account_number: '5890', account_name: 'Other Taxes & Fees', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x2000, community_id: C, account_number: '2000', account_name: 'Accounts Payable', is_active: true, is_summary: false, fund_id: 'f-opr' },
    ],
    account_funds: [],
    journal_entries: [], journal_entry_lines: [], journal_entry_corrections: [], journal_entry_edits: [],
    ap_invoices: [], ap_invoice_lines: [], ap_invoice_approvals: [],
    ar_charges: [], homeowner_ledger_entries: [], ar_charge_types: [], community_billing_policies: [],
  };
}
const je = (id, o) => db.journal_entries.push({ id, community_id: C, status: 'posted', reverses_je_id: null, void_reversal_je_id: null, source_module: 'ap_invoice', ...o });
const jl = (jeId, n, acct, d, c, memo) => db.journal_entry_lines.push({ id: `${jeId}-L${n}`, journal_entry_id: jeId, line_number: n, account_id: acct, fund_id: 'f-opr', debit_cents: d, credit_cents: c, memo, vendor_id: V });
// JE-2026-00169 exactly (reconstructed from CONV-LPF-20260731-NEUT-JE-2026-00169; the REPOST copy agrees).
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
const snapshotLines = () => JSON.stringify(db.journal_entry_lines.filter((l) => (headerOf(l.journal_entry_id) || {}).status !== 'draft' || true).map((l) => [l.id, l.journal_entry_id, l.account_id, l.debit_cents, l.credit_cents]));
const counted = () => { const ok = new Set(db.journal_entries.filter((j) => j.status === 'posted' || (j.status === 'voided' && j.void_reversal_je_id)).map((j) => j.id)); return db.journal_entry_lines.filter((l) => ok.has(l.journal_entry_id)); };
function net({ month } = {}) {
  const out = {};
  for (const l of counted()) {
    const h = headerOf(l.journal_entry_id);
    if (month && String(h.posting_date).slice(0, 7) !== month) continue;
    const n = db.chart_of_accounts.find((a) => a.id === l.account_id).account_number;
    out[n] = (out[n] || 0) + l.debit_cents - l.credit_cents;
  }
  Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
  return out;
}
const orphans = () => db.journal_entries.filter((j) => j.status !== 'draft' && !linesOf(j.id).length).map((j) => j.reference);
// Every existing posted line is still there, unchanged, and nothing tried to touch one.
function assertPostedLinesUntouched(before) {
  assert.deepStrictEqual(violations, [], `application code touched posted lines: ${violations.join('; ')}`);
  const now = JSON.parse(snapshotLines()).map((x) => x.join('|'));
  for (const x of JSON.parse(before)) assert.ok(now.includes(x.join('|')), `a posted line disappeared or changed: ${x.join('|')}`);
  assert.deepStrictEqual(orphans(), [], 'no posted header without lines');
}

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
const app = express();
app.use('/api/ap', router);

let base;
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
const REASON = 'MUD water, not landscaping';
const link = () => db.journal_entry_corrections[db.journal_entry_corrections.length - 1];

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const origWarn = console.warn;
  console.warn = () => {}; console.error = () => {};
  console.log('test_posted_je_immutable');

  // ================================================================ the Barker Cypress MUD scar
  await t('Barker Cypress MUD: re-coding an UNPAID posted bill never deletes or rewrites the original entry or its lines', async () => {
    seed(); seedLopfBill();
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(linesOf('je-169').length, 5, `JE-2026-00169 lost its lines (has ${linesOf('je-169').length}): the LOPF scar is back`);
    assert.ok(headerOf('je-169'), 'original header kept');
    assertPostedLinesUntouched(before);
  });

  await t('...the correction is an explicit entry: the live conversion RE-POST is reversed (on its own date), the original is not reversed twice', async () => {
    assert.strictEqual(db.journal_entries.filter((j) => j.reverses_je_id === 'je-169').length, 1, 'only the conversion NEUT reverses the original');
    const rp = headerOf('je-repost');
    assert.strictEqual(rp.status, 'voided');
    const rev = headerOf(rp.void_reversal_je_id);
    assert.ok(rev && rev.reverses_je_id === 'je-repost' && rev.posting_date === '2026-08-01', 'reversal linked by reverses_je_id, dated 8/1');
  });

  await t('...the link is DATA: invoice, original entry, correcting entry, replacement, actor, timestamp, reason', async () => {
    assert.strictEqual(db.journal_entry_corrections.length, 1);
    const k = link();
    const inv = db.ap_invoices.find((i) => i.id === 'inv-1');
    assert.strictEqual(k.kind, 'ap_recode');
    assert.strictEqual(k.invoice_id, 'inv-1');
    assert.strictEqual(k.original_je_id, 'je-169');
    assert.strictEqual(k.corrected_je_id, 'je-repost');
    assert.strictEqual(k.correcting_je_id, headerOf('je-repost').void_reversal_je_id);
    assert.strictEqual(k.replacement_je_id, inv.posting_journal_entry_id);
    assert.strictEqual(k.actor_user_id, 'u-1');
    assert.strictEqual(k.actor_name, 'Test Staff');
    assert.ok(k.created_at, 'timestamp');
    assert.ok(k.reason.includes(REASON) && k.reason.includes('5205') && k.reason.includes('5120'), k.reason);
  });

  await t('...July nets to zero and August carries the bill exactly once, in the new account', async () => {
    assert.deepStrictEqual(net({ month: '2026-07' }), {}, `July: ${JSON.stringify(net({ month: '2026-07' }))}`);
    assert.deepStrictEqual(net({ month: '2026-08' }), { 5120: 47025, 2000: -47025 }, `August: ${JSON.stringify(net({ month: '2026-08' }))}`);
    const note = db.ap_invoice_approvals.find((a) => a.invoice_id === 'inv-1');
    assert.ok(note && /Original entry kept/.test(note.notes) && note.notes.includes(REASON), note && note.notes);
  });

  await t('same through the LINE re-code route (kind ap_line_recode)', async () => {
    seed(); seedLopfBill();
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/lines/il-3/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assertPostedLinesUntouched(before);
    assert.strictEqual(link().kind, 'ap_line_recode');
    assert.strictEqual(link().original_je_id, 'je-169');
    assert.deepStrictEqual(net({ month: '2026-07' }), {});
  });

  await t('neutralized with no re-post (nothing live): no reversal posted, replacement + link recorded', async () => {
    seed(); seedLopfBill({ repost: false });
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assertPostedLinesUntouched(before);
    assert.strictEqual(db.journal_entries.filter((j) => j.source_module === 'reversal').length, 1, 'no new reversal');
    assert.strictEqual(link().correcting_je_id, null);
    assert.ok(link().replacement_je_id);
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
  });

  // ================================================================ open period is covered too
  await t('OPEN period, unpaid, nothing references it: still never deleted; reversed on its own date + replacement', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assertPostedLinesUntouched(before);
    const h = headerOf('je-169');
    assert.strictEqual(h.status, 'voided');
    assert.strictEqual(headerOf(h.void_reversal_je_id).posting_date, '2026-09-10');
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
    assert.strictEqual(link().corrected_je_id, 'je-169');
  });

  await t('CLOSED period: never deleted; reversed in an open month (today)', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-08', date: '2026-08-15' });
    db.accounting_periods.find((p) => p.id === 'p-08').status = 'closed';
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assertPostedLinesUntouched(before);
    assert.strictEqual(headerOf(headerOf('je-169').void_reversal_je_id).posting_date, TODAY);
  });

  await t('a PAID bill: the same correcting entry + link (the live re-post reversed today, original not reversed twice)', async () => {
    seed(); seedLopfBill({ paid: true });
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assertPostedLinesUntouched(before);
    assert.strictEqual(db.journal_entries.filter((j) => j.reverses_je_id === 'je-169').length, 1);
    assert.strictEqual(headerOf(headerOf('je-repost').void_reversal_je_id).posting_date, TODAY);
    assert.deepStrictEqual(net(), { 5120: 47025, 2000: -47025 });
  });

  // ================================================================ refusals change nothing
  await t('no reason: refused (reason_required), even unpaid; nothing changes', async () => {
    seed(); seedLopfBill();
    const before = JSON.stringify(db);
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'reason_required');
    assert.strictEqual(JSON.stringify(db), before);
    const r2 = await post('/api/ap/invoices/inv-1/lines/il-3/code', { gl_account_id: A.x5120 });
    assert.strictEqual(r2.body.error, 'reason_required');
    assert.strictEqual(JSON.stringify(db), before);
  });

  await t('correction log missing (migration 503 not applied): refused before anything posts', async () => {
    seed(); seedLopfBill();
    faults.no_corrections_table = true;
    const before = JSON.stringify(db);
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'correction_log_unavailable');
    assert.ok(/migration 503/.test(r.body.detail) && /Nothing was changed/.test(r.body.detail), r.body.detail);
    assert.strictEqual(JSON.stringify(db), before);
    const r2 = await post('/api/ap/invoices/inv-1/lines/il-3/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r2.body.error, 'correction_log_unavailable');
    assert.strictEqual(JSON.stringify(db), before, 'line re-code left untouched too');
  });

  await t('the correcting entry cannot post: refused, the coding and the pointer are unchanged', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    faults.no_reference = true;
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'reversal_failed');
    const inv = db.ap_invoices[0];
    assert.strictEqual(inv.posting_journal_entry_id, 'je-169');
    assert.strictEqual(inv.coded_gl_account_id, A.x5205);
    assert.strictEqual(headerOf('je-169').status, 'posted');
    assert.strictEqual(db.journal_entry_corrections.length, 0);
  });

  await t('the link cannot be written after posting: the user is told plainly (never silent)', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    faults.correction_insert = true;
    const r = await post('/api/ap/invoices/inv-1/code', { gl_account_id: A.x5120, reason: REASON });
    assert.strictEqual(r.status, 200);
    assert.ok(/audit link .* could not be saved/.test(r.body.warning || ''), r.body.warning);
  });

  // ================================================================ hold-prior-periods
  await t('hold-prior-periods: the over-stated posted accrual is reversed, never deleted; current month re-posted; link recorded', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    db.ap_invoices[0].total_cents = 2846000;
    db.ap_invoice_lines = [
      { id: 'h1', invoice_id: 'inv-1', line_number: 1, description: 'September Contract Deputy Service', amount_cents: 1423000, gl_account_id: A.x5205 },
      { id: 'h2', invoice_id: 'inv-1', line_number: 2, description: '2610S - Outstanding Invoice - August', amount_cents: 1423000, gl_account_id: A.x5205 },
    ];
    const before = snapshotLines();
    const r = await post('/api/ap/invoices/inv-1/hold-prior-periods', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assertPostedLinesUntouched(before);
    assert.strictEqual(headerOf('je-169').status, 'voided');
    assert.strictEqual(link().kind, 'ap_hold_prior_periods');
    assert.strictEqual(link().replacement_je_id, db.ap_invoices[0].posting_journal_entry_id);
  });

  // ================================================================ late fees + manual edit
  const seedLateFeeRun = () => {
    seed();
    db.community_billing_policies = [{ id: 'pol', community_id: C, effective_end_date: null, late_fee_amount_cents: 2500, interest_apr_pct: 0, grace_period_days: 30 }];
    db.ar_charge_types = [{ id: 'ct-lf', community_id: C, type_code: 'late_fees' }, { id: 'ct-li', community_id: C, type_code: 'late_interest' }];
    db.chart_of_accounts.push({ id: 'a-1300', community_id: C, account_number: '1300', account_name: 'Accounts Receivable', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: 'a-4030', community_id: C, account_number: '4030', account_name: 'Late Fee Income', is_active: true, is_summary: false, fund_id: 'f-opr' });
    je('je-lf', { reference: 'JE-2026-09-FEES', period_id: 'p-09', posting_date: '2026-09-01', total_debits_cents: 2500, total_credits_cents: 2500, source_module: 'system' });
    jl('je-lf', 1, A.x2000, 2500, 0, 'AR'); jl('je-lf', 2, A.x5890, 0, 2500, 'income');
    db.ar_charges.push({ id: 'ch-1', community_id: C, posting_journal_entry_id: 'je-lf', source_module: 'late_fee_run' });
  };
  await t('late-fee run reversal: the run entry is voided by reversal, never deleted; AR rows removed; a re-run is not blocked', async () => {
    seedLateFeeRun();
    const before = snapshotLines();
    const { reverseLateFeesAndInterest, runLateFeesAndInterest } = require('../lib/accounting/late_fee_interest');
    const r = await reverseLateFeesAndInterest({ supabase: fakeClient(), communityId: C, runMonth: '2026-09' });
    assert.strictEqual(r.gl, 'voided');
    assertPostedLinesUntouched(before);
    assert.strictEqual(headerOf('je-lf').status, 'voided');
    assert.strictEqual(headerOf(headerOf('je-lf').void_reversal_je_id).posting_date, '2026-09-01', 'reversed in its own (open) month');
    assert.strictEqual(db.ar_charges.length, 0);
    const again = await runLateFeesAndInterest({ supabase: fakeClient(), communityId: C, runMonth: '2026-09', dryRun: true });
    assert.ok(!again.refused, `re-run blocked by the voided run: ${again.refused}`);
    const twice = await reverseLateFeesAndInterest({ supabase: fakeClient(), communityId: C, runMonth: '2026-09' });
    assert.strictEqual(twice.reversed, 0, 'nothing left to reverse');
  });

  await t('editJournalEntry: rewriting a POSTED entry\'s lines is refused (open period); a draft\'s lines can still change', async () => {
    seed(); seedLopfBill({ neut: false, period: 'p-09', date: '2026-09-10' });
    const before = snapshotLines();
    const { editJournalEntry } = require('../lib/accounting/posting');
    await assert.rejects(() => editJournalEntry({ journal_entry_id: 'je-169', lines: [{ account_id: A.x5120, debit_cents: 47025 }, { account_id: A.x2000, credit_cents: 47025 }] }), (e) => e.code === 'invalid_state' && /posted_entry_lines_are_permanent/.test(e.message));
    assertPostedLinesUntouched(before);
    const ok = await editJournalEntry({ journal_entry_id: 'je-169', description: 'Barker Cypress MUD 29354487' });
    assert.strictEqual(ok.entry.description, 'Barker Cypress MUD 29354487', 'metadata stays editable');
    je('je-draft', { reference: 'JE-DRAFT', status: 'draft', period_id: 'p-09', posting_date: '2026-09-10', total_debits_cents: 100, total_credits_cents: 100 });
    jl('je-draft', 1, A.x5205, 100, 0, 'x'); jl('je-draft', 2, A.x2000, 0, 100, 'y');
    await editJournalEntry({ journal_entry_id: 'je-draft', lines: [{ account_id: A.x5120, debit_cents: 100 }, { account_id: A.x2000, credit_cents: 100 }] });
    assert.strictEqual(linesOf('je-draft')[0].account_id, A.x5120);
  });

  await t('an entry that is itself a reversal, or partly reversed, is refused', async () => {
    seed(); seedLopfBill({ repost: false });
    const { voidLiveEntry } = require('../lib/accounting/correct_entry');
    await assert.rejects(() => voidLiveEntry({ supabase: fakeClient(), journal_entry_id: 'je-neut', void_reason: 'x' }), (e) => e.code === 'entry_is_a_reversal');
    seed(); seedLopfBill({ neut: false });
    je('je-part', { reference: 'JE-PART', period_id: 'p-07', posting_date: '2026-07-31', total_debits_cents: 100, total_credits_cents: 100, source_module: 'reversal', reverses_je_id: 'je-169' });
    await assert.rejects(() => voidLiveEntry({ supabase: fakeClient(), journal_entry_id: 'je-169', void_reason: 'x' }), (e) => e.code === 'entry_partially_reversed');
  });

  // ================================================================ the invariant, statically
  await t('INVARIANT (static): no application code (api/, lib/, server.js) deletes or rewrites journal entry lines', () => {
    const { run } = require('../scripts/check_posted_lines_immutable');
    const v = run();
    assert.deepStrictEqual(v.map((x) => `${x.file}:${x.line} ${x.text}`), []);
  });

  await t('INVARIANT (static): the check catches the code that caused the scar', () => {
    const { scan } = require('../scripts/check_posted_lines_immutable');
    const scar = "        try {\n          await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', jeId);\n          await supabase.from('journal_entries').delete().eq('id', jeId);\n        } catch (e) {}\n";
    assert.strictEqual(scan('api/ap.js', scar).length, 2);
    assert.strictEqual(scan('x.js', "await sb.from('journal_entry_lines').update({ debit_cents: 1 }).eq('id', x);").length, 1);
    assert.strictEqual(scan('x.js', "await sb.from('journal_entry_lines').upsert(rows);").length, 1);
    assert.strictEqual(scan('x.js', "const q = `DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`;").length, 1);
    assert.strictEqual(scan('x.js', "await sb.from('journal_entries').update({ status: 'voided' }).eq('id', x);").length, 0, 'header updates (the void flip) are allowed');
    assert.strictEqual(scan('x.js', "await sb.from('journal_entry_lines').delete().eq('id', x); // posted-lines-ok: drafts only").length, 0, 'a reasoned exception on the same line is allowed');
    try {
      const old = execSync('git show origin/main:api/ap.js', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      assert.ok(scan('api/ap.js', old).length >= 6, 'the pre-fix api/ap.js (origin/main) is flagged');
    } catch (e) { if (e instanceof assert.AssertionError) throw e; /* origin/main not available here: covered by the inline sample above */ }
  });

  console.warn = origWarn; console.error = realError;
  server.close();
  Module._load = realLoad;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { realError('test_posted_je_immutable FAILED'); process.exit(1); }
})().catch((e) => { realError(e); process.exit(1); });
