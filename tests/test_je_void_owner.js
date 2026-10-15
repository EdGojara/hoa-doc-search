#!/usr/bin/env node
// ============================================================================
// tests/test_je_void_owner.js
// ----------------------------------------------------------------------------
// The owner's "Void entry" action (Accounting > Journal Entries > entry):
//   GET  /api/books/journal-entries/:id/void-preview   (reads only)
//   POST /api/books/journal-entries/:id/void
//
// Locks:
//   1. AUTH. Only the signed-in OWNER may preview or void. No session, a staff
//      session and a second admin are refused, and nothing posts. A user id in
//      the request body is ignored: the actor is the session's owner. (The
//      route used to trust body.posted_by_user_id.)
//   2. REVERSAL DATE. Defaults to the original's posting date; must be a real
//      date, not before the original, in an open month, after any close.
//   3. REFUSALS SURFACED. already voided, a void reversal, already reversed
//      (a conversion NEUT), books closed (app check and migration 528),
//      posted entries immutable (migration 529), no open period, migration
//      530 missing: each is a 4xx/5xx with a plain `detail`, and nothing posts.
//   4. AUDIT. Every void writes journal_entry_corrections (kind 'void') with
//      the reason and the session's actor.
//   5. THE LOPF REPAIR SHAPE. Voiding CONV-LPF-20260731-NEUT-JE-2026-00169
//      (reversal 7/28) and -REPOST- (8/1) leaves JE-2026-00169's family at zero.
// Drives the REAL router and the REAL requireOwner against an in-memory
// database. Offline: no network, no real database. Voids nothing real.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

// ---------------------------------------------------------------- fake database
let db; let seq = 0; const faults = {};
const OWNER = { id: 'u-ed', email: 'egojara@bedrocktx.com', full_name: 'Ed Gojara', role: 'admin' };
const TOKENS = {
  'tok-owner': OWNER,
  'tok-staff': { id: 'u-kat', email: 'kat@bedrocktx.com', full_name: 'Kat', role: 'staff' },
  'tok-admin2': { id: 'u-adm', email: 'second.admin@bedrocktx.com', full_name: 'Second Admin', role: 'admin' },
};
const counted = () => { const ok = new Set(db.journal_entries.filter((j) => j.status === 'posted' || (j.status === 'voided' && j.void_reversal_je_id)).map((j) => j.id)); return db.journal_entry_lines.filter((l) => ok.has(l.journal_entry_id)); };

function fakeClient() {
  return {
    auth: {
      getUser: async (token) => (TOKENS[token] ? { data: { user: { id: TOKENS[token].id, email: TOKENS[token].email } }, error: null } : { data: { user: null }, error: { message: 'invalid token' } }),
    },
    rpc: async (fn, args) => {
      if (fn === 'next_je_reference') return { data: `JE-${args.p_fiscal_year}-T${String(++seq).padStart(4, '0')}`, error: null };
      if (fn === 'close_closed_through') return { data: faults.closed_through || null, error: null };
      if (fn === 'journal_entry_void_audit_ready') return faults.no530 ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.journal_entry_void_audit_ready' } } : { data: true, error: null };
      return { data: null, error: { message: `rpc ${fn} not faked` } };
    },
    from(table) {
      if (!db[table] && table !== 'v_trial_balance') db[table] = [];
      const st = { op: 'select', f: [], order: null, from: 0, limit: null, patch: null, rows: null, wantRows: false };
      const match = (r) => st.f.every((fn) => fn(r));
      const run = () => {
        if (table === 'v_trial_balance') {
          const rows = db.chart_of_accounts.map((a) => {
            const ls = counted().filter((l) => l.account_id === a.id);
            const d = ls.reduce((s, l) => s + l.debit_cents, 0); const c = ls.reduce((s, l) => s + l.credit_cents, 0);
            return { community_id: a.community_id, account_id: a.id, account_number: a.account_number, natural_balance_cents: a.normal_balance === 'debit' ? d - c : c - d };
          });
          return { data: rows.filter(match), error: null };
        }
        const all = db[table];
        if (st.op === 'insert') {
          if (table === 'journal_entries' && faults.immutable_on_insert) return { data: null, error: { code: 'P0001', message: 'posted_lines_immutable: CONV-X (posted) keeps its community, date, period, amounts and reversal link; post a correcting entry instead' } };
          if (table === 'journal_entries' && faults.db_books_closed) return { data: null, error: { code: 'P0001', message: 'books_closed: Lakes of Pine Forest is a former client; its ledger is read-only' } };
          const out = st.rows.map((r) => ({ id: r.id || `${table}-${++seq}`, created_at: new Date().toISOString(), ...r }));
          all.push(...out);
          return { data: st.wantRows ? out : null, error: null };
        }
        if (st.op === 'update') {
          if (table === 'journal_entries' && faults.db_posted_immutable) return { data: null, error: { code: 'P0001', message: 'posted_lines_immutable: CONV-X (posted) keeps its community, date, period, amounts and reversal link; post a correcting entry instead' } };
          if (table === 'journal_entry_corrections') return { data: null, error: { message: 'journal_entry_corrections is append-only' } };
          const hit = all.filter(match); hit.forEach((r) => Object.assign(r, st.patch));
          return { data: st.wantRows ? hit : null, error: null };
        }
        if (st.op === 'delete') return { data: null, error: { message: 'no deletes in this test' } };
        let rows = all.filter(match).map((r) => ({ ...r }));
        if (st.order) rows.sort((a, b) => (a[st.order] > b[st.order] ? 1 : a[st.order] < b[st.order] ? -1 : 0));
        rows = rows.slice(st.from, st.limit != null ? st.from + st.limit : undefined);
        return { data: rows, error: null };
      };
      const q = {
        select() { st.wantRows = true; return q; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return q; },
        update(p) { st.op = 'update'; st.patch = p; return q; },
        delete() { st.op = 'delete'; return q; },
        eq(c, v) { st.f.push((r) => r[c] === v); return q; },
        neq(c, v) { st.f.push((r) => r[c] !== v); return q; },
        is(c, v) { st.f.push((r) => (r[c] == null ? null : r[c]) === v); return q; },
        in(c, vs) { st.f.push((r) => vs.includes(r[c])); return q; },
        lte(c, v) { st.f.push((r) => r[c] <= v); return q; },
        gte(c, v) { st.f.push((r) => r[c] >= v); return q; },
        order(c) { st.order = c; return q; },
        limit(n) { st.limit = n; return q; },
        range(a, b) { st.from = a; st.limit = b - a + 1; return q; },
        maybeSingle: async () => { const r = run(); if (r.error) return r; const d = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []); return { data: d[0] || null, error: null }; },
        single: async () => { const r = run(); if (r.error) return r; const d = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []); return d.length ? { data: d[0], error: null } : { data: null, error: { message: 'no rows' } }; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

// ---------------------------------------------------------------- fixtures (LOPF shape)
const C = 'c-lopf';
const A = { x5205: 'a-5205', x2000: 'a-2000', x1000: 'a-1000' };
function seed() {
  seq = 0; Object.keys(faults).forEach((k) => delete faults[k]);
  const months = [['07', '31'], ['08', '31'], ['09', '30'], ['10', '31']];
  db = {
    communities: [{ id: C, name: 'Lakes of Pine Forest', management_status: 'active', books_of_record: 'trusted', financials_active: true, management_end_date: null }],
    user_profiles: Object.values(TOKENS).map((u) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, is_active: true })),
    accounting_periods: months.map(([m, end]) => ({ id: `p-${m}`, community_id: C, fiscal_year: 2026, period_number: Number(m), period_start: `2026-${m}-01`, period_end: `2026-${m}-${end}`, status: 'open' })),
    chart_of_accounts: [
      { id: A.x5205, community_id: C, account_number: '5205', account_name: 'Landscaping Maintenance', normal_balance: 'debit', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x2000, community_id: C, account_number: '2000', account_name: 'Accounts Payable', normal_balance: 'credit', is_active: true, is_summary: false, fund_id: 'f-opr' },
      { id: A.x1000, community_id: C, account_number: '1000', account_name: 'Operating Cash', normal_balance: 'debit', is_active: true, is_summary: false, fund_id: 'f-opr' },
    ],
    account_funds: [], journal_entries: [], journal_entry_lines: [], journal_entry_corrections: [],
  };
  // JE-2026-00169: header kept, lines deleted 9/28 (the scar). NEUT reversed it on 7/28; REPOST re-posted it on 8/1.
  je('je-169', { reference: 'JE-2026-00169', period_id: 'p-07', posting_date: '2026-07-28', source_module: 'ap_invoice' });
  je('je-neut', { reference: 'CONV-LPF-20260731-NEUT-JE-2026-00169', period_id: 'p-07', posting_date: '2026-07-28', source_module: 'reversal', reverses_je_id: 'je-169' });
  jl('je-neut', 1, A.x2000, 87750, 0); jl('je-neut', 2, A.x5205, 0, 87750);
  je('je-repost', { reference: 'CONV-LPF-20260731-REPOST-JE-2026-00169', period_id: 'p-08', posting_date: '2026-08-01', source_module: 'manual' });
  jl('je-repost', 1, A.x5205, 87750, 0); jl('je-repost', 2, A.x2000, 0, 87750);
  // A duplicate payment entry (the Waterview / Still Creek / LOPF cleanup shape).
  je('je-dup', { reference: 'JE-2026-00300', period_id: 'p-09', posting_date: '2026-09-15', source_module: 'payment_intake' });
  jl('je-dup', 1, A.x2000, 12500, 0); jl('je-dup', 2, A.x1000, 0, 12500);
}
function je(id, o) { db.journal_entries.push({ id, community_id: C, status: 'posted', reverses_je_id: null, void_reversal_je_id: null, total_debits_cents: 0, total_credits_cents: 0, ...o }); }
function jl(jeId, n, acct, d, c) {
  db.journal_entry_lines.push({ id: `${jeId}-L${n}`, journal_entry_id: jeId, line_number: n, account_id: acct, fund_id: 'f-opr', debit_cents: d, credit_cents: c, memo: `line ${n}` });
  const h = db.journal_entries.find((j) => j.id === jeId); h.total_debits_cents += d; h.total_credits_cents += c;
}
const header = (id) => db.journal_entries.find((j) => j.id === id);
const entryCount = () => db.journal_entries.length;

// ---------------------------------------------------------------- boot the real router
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
delete process.env.OWNER_EMAIL;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  if (request === '@anthropic-ai/sdk') { const B = function () { this.messages = { create: async () => { throw new Error('network blocked in test'); } }; }; B.default = B; return B; }
  return realLoad.apply(this, arguments);
};
seed();
const express = require('express');
const { router } = require('../api/books');
const app = express();
app.use('/api/books', router);

let base;
async function call(method, p, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const voidIt = (id, body, token = 'tok-owner') => call('POST', `/api/books/journal-entries/${id}/void`, { token, body });
const preview = (id, date, token = 'tok-owner') => call('GET', `/api/books/journal-entries/${id}/void-preview${date ? `?reversal_date=${date}` : ''}`, { token });
const REASON = 'Duplicate of the 9/14 payment entry';

let failed = 0; let passed = 0;
const realError = console.error; const realWarn = console.warn; const realLog = console.log;
async function t(name, fn) {
  seed();
  try { await fn(); passed++; realLog('  ok  ', name); } catch (e) { failed++; realError('  FAIL', name, '\n       ', e.message); }
}
// A refusal: the right status and code, a plain message, and nothing posted or recorded.
async function refused(res, status, code, detailRe) {
  assert.strictEqual(res.status, status, `expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  if (code) assert.strictEqual(res.body.code || res.body.error, code, JSON.stringify(res.body));
  assert.ok(res.body.detail && String(res.body.detail).length > 10, `refusal must carry a readable detail: ${JSON.stringify(res.body)}`);
  if (detailRe) assert.ok(detailRe.test(res.body.detail), `detail "${res.body.detail}" should match ${detailRe}`);
}
function nothingPosted(before) {
  assert.strictEqual(entryCount(), before, 'a refused void must post nothing');
  assert.strictEqual(db.journal_entry_corrections.length, 0, 'a refused void records nothing');
  assert.ok(!db.journal_entries.some((j) => j.status === 'voided'), 'a refused void marks nothing voided');
}

(async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.error = () => {}; console.warn = () => {}; console.log = () => {};

  realLog('auth: owner only, actor from the session');
  await t('no session: void and preview refused (403), nothing posted', async () => {
    const n = entryCount();
    await refused(await call('POST', '/api/books/journal-entries/je-dup/void', { body: { void_reason: REASON, posted_by_user_id: OWNER.id } }), 403, 'owner_only');
    await refused(await call('GET', '/api/books/journal-entries/je-dup/void-preview'), 403, 'owner_only');
    nothingPosted(n);
  });
  await t('staff session refused (403), nothing posted', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }, 'tok-staff'), 403, 'owner_only');
    await refused(await preview('je-dup', null, 'tok-staff'), 403, 'owner_only');
    nothingPosted(n);
  });
  await t('a second admin who is not the owner is refused (403)', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }, 'tok-admin2'), 403, 'owner_only');
    nothingPosted(n);
  });
  await t('a staff session naming the owner in the body is still refused', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON, posted_by_user_id: OWNER.id }, 'tok-staff'), 403, 'owner_only');
    nothingPosted(n);
  });
  await t('owner void: body-supplied user id ignored; actor, reversal and corrections record are the session owner', async () => {
    const r = await voidIt('je-dup', { void_reason: REASON, reversal_date: '2026-09-15', posted_by_user_id: 'u-attacker', voided_by_user_id: 'u-attacker', actor_user_id: 'u-attacker' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const orig = header('je-dup');
    const rev = header(orig.void_reversal_je_id);
    assert.strictEqual(orig.status, 'voided');
    assert.strictEqual(orig.voided_by_user_id, OWNER.id);
    assert.strictEqual(orig.void_reason, REASON);
    assert.strictEqual(rev.posted_by_user_id, OWNER.id);
    assert.strictEqual(rev.reverses_je_id, 'je-dup');
    assert.strictEqual(rev.posting_date, '2026-09-15');
    assert.ok(!JSON.stringify(db).includes('u-attacker'), 'the body-supplied id must not be stored anywhere');
    const c = db.journal_entry_corrections[0];
    assert.ok(c, 'a corrections record is written');
    assert.deepStrictEqual({ kind: c.kind, original: c.original_je_id, corrected: c.corrected_je_id, correcting: c.correcting_je_id, actor: c.actor_user_id, name: c.actor_name, reason: c.reason },
      { kind: 'void', original: 'je-dup', corrected: 'je-dup', correcting: rev.id, actor: OWNER.id, name: 'Ed Gojara', reason: REASON });
    // reversal lines are the original's, flipped
    const rl = db.journal_entry_lines.filter((l) => l.journal_entry_id === rev.id).map((l) => [l.account_id, l.debit_cents, l.credit_cents]);
    assert.deepStrictEqual(rl, [[A.x2000, 0, 12500], [A.x1000, 12500, 0]]);
    assert.match(r.body.message, /JE-2026-00300 voided\. Reversal JE-2026-T\d+ posted 2026-09-15 for \$125\.00/);
  });

  realLog('preview (reads only)');
  await t('preview lists the reversal lines, accounts, amounts, date, period and the dry-run balances; writes nothing', async () => {
    const n = entryCount(); const snap = JSON.stringify(db);
    const r = await preview('je-dup');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.reversal_date, '2026-09-15', 'defaults to the original posting date');
    assert.strictEqual(r.body.period.id, 'p-09');
    assert.deepStrictEqual(r.body.lines.map((l) => [l.account_number, l.account_name, l.debit_cents, l.credit_cents]), [['2000', 'Accounts Payable', 0, 12500], ['1000', 'Operating Cash', 12500, 0]]);
    assert.deepStrictEqual(r.body.totals, { debit_cents: 12500, credit_cents: 12500 });
    const b = Object.fromEntries(r.body.balances.map((x) => [x.account_number, [x.before_cents, x.change_cents, x.after_cents]]));
    // 2000 (credit-normal): NEUT Dr 877.50, REPOST Cr 877.50, dup Dr 125.00 -> -125.00; the void adds a 125.00 credit -> 0
    assert.deepStrictEqual(b['2000'], [-12500, 12500, 0]);
    // 1000 (debit-normal): dup Cr 125.00 -> -125.00; the void debits it back -> 0
    assert.deepStrictEqual(b['1000'], [-12500, 12500, 0]);
    assert.strictEqual(entryCount(), n); assert.strictEqual(JSON.stringify(db), snap, 'preview must not write');
  });

  realLog('reversal date');
  await t('not a real date -> 400 invalid_reversal_date', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON, reversal_date: '2026-09-31' }), 400, 'invalid_reversal_date');
    await refused(await voidIt('je-dup', { void_reason: REASON, reversal_date: '9/15/2026' }), 400, 'invalid_reversal_date');
    await refused(await preview('je-dup', 'yesterday'), 400, 'invalid_reversal_date');
    nothingPosted(n);
  });
  await t('before the original -> 400 reversal_before_original', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON, reversal_date: '2026-09-14' }), 400, 'reversal_before_original', /before JE-2026-00300/);
    nothingPosted(n);
  });
  await t('month not open -> 409 period_closed, says which date', async () => {
    db.accounting_periods.find((p) => p.id === 'p-09').status = 'closed';
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }), 409, 'period_closed', /2026-09-15/);
    await refused(await preview('je-dup'), 409, 'period_closed');
    nothingPosted(n);
  });
  await t('no period at all for the date -> 409 period_closed', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON, reversal_date: '2027-03-01' }), 409, 'period_closed', /2027-03-01/);
    nothingPosted(n);
  });
  await t('books closed through the date (migration 502) -> 409 period_closed', async () => {
    faults.closed_through = '2026-09-30';
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }), 409, 'period_closed', /closed through 2026-09-30/);
    nothingPosted(n);
  });
  await t('a later open date is accepted (reversal posts on that date)', async () => {
    const r = await voidIt('je-dup', { void_reason: REASON, reversal_date: '2026-10-01' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(header(header('je-dup').void_reversal_je_id).posting_date, '2026-10-01');
  });

  realLog('reason');
  await t('no written reason -> 400, nothing posted', async () => {
    const n = entryCount();
    await refused(await voidIt('je-dup', {}), 400, 'void_reason_required');
    await refused(await voidIt('je-dup', { void_reason: '   ' }), 400, 'void_reason_required');
    nothingPosted(n);
  });

  realLog('refusals surfaced, never silent');
  await t('already voided -> 409 already_voided; void reversal -> 409 is_void_reversal', async () => {
    assert.strictEqual((await voidIt('je-dup', { void_reason: REASON })).status, 200);
    const n = entryCount(); const corr = db.journal_entry_corrections.length;
    await refused(await voidIt('je-dup', { void_reason: REASON }), 409, 'already_voided', /already voided/);
    await refused(await voidIt(header('je-dup').void_reversal_je_id, { void_reason: REASON }), 409, 'is_void_reversal', /void is final/);
    assert.strictEqual(entryCount(), n); assert.strictEqual(db.journal_entry_corrections.length, corr);
  });
  await t('already reversed by a conversion NEUT -> 409 already_reversed (JE-2026-00169 itself)', async () => {
    const n = entryCount();
    await refused(await voidIt('je-169', { void_reason: REASON }), 409, 'already_reversed', /CONV-LPF-20260731-NEUT-JE-2026-00169/);
    nothingPosted(n);
  });
  await t('former client / books not kept in trustEd -> 409 books_closed', async () => {
    db.communities[0].financials_active = false;
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }), 409, 'books_closed', /Voiding a journal entry refused/);
    await refused(await preview('je-dup'), 409, 'books_closed');
    nothingPosted(n);
  });
  await t('database books_closed (migration 528) on the reversal insert -> 409 books_closed with its message', async () => {
    faults.db_books_closed = true;
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }), 409, 'books_closed', /books_closed: Lakes of Pine Forest/);
    nothingPosted(n);
  });
  await t('database posted_lines_immutable (migration 529) -> 409 posted_entry_permanent with its message', async () => {
    // The refusal arrives before anything posts (e.g. a guard on the reversal insert).
    const n = entryCount();
    faults.db_posted_immutable = true; faults.immutable_on_insert = true;
    const r = await voidIt('je-dup', { void_reason: REASON });
    await refused(r, 409, 'posted_entry_permanent', /keeps its community/);
    nothingPosted(n);
  });
  await t('flip refused AFTER the reversal posted -> 500 void_incomplete naming the reversal, never "nothing changed"', async () => {
    faults.db_posted_immutable = true;
    const r = await voidIt('je-dup', { void_reason: REASON });
    await refused(r, 500, 'void_incomplete', /Reversal JE-2026-T\d+ posted 2026-09-15, but JE-2026-00300 could not be marked voided.*do not void again/);
    assert.ok(!/Nothing was changed/.test(r.body.detail));
    assert.strictEqual(db.journal_entry_corrections.length, 0);
  });
  await t('migration 530 not applied -> 503 audit_not_ready, nothing posted', async () => {
    faults.no530 = true;
    const n = entryCount();
    await refused(await voidIt('je-dup', { void_reason: REASON }), 503, 'audit_not_ready', /migration 530/);
    nothingPosted(n);
  });
  await t('unknown entry -> 404 with a detail', async () => {
    await refused(await voidIt('je-nope', { void_reason: REASON }), 404, 'not_found');
  });

  realLog('the LOPF repair shape (run by Ed in the app; nothing real is voided here)');
  await t('void NEUT (7/28) and REPOST (8/1): JE-2026-00169 family nets to zero; two corrections recorded', async () => {
    const pv = await preview('je-neut', '2026-07-28');
    assert.strictEqual(pv.status, 200, JSON.stringify(pv.body));
    assert.strictEqual(pv.body.reversal_date, '2026-07-28');
    const a = await voidIt('je-neut', { void_reason: 'LOPF repair: JE-2026-00169 lost its lines; remove the NEUT', reversal_date: '2026-07-28' });
    const b = await voidIt('je-repost', { void_reason: 'LOPF repair: remove the REPOST of JE-2026-00169', reversal_date: '2026-08-01' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body)); assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    const fam = new Set(['je-169', 'je-neut', 'je-repost', header('je-neut').void_reversal_je_id, header('je-repost').void_reversal_je_id]);
    const net = counted().filter((l) => fam.has(l.journal_entry_id)).reduce((s, l) => s + l.debit_cents - l.credit_cents, 0);
    const ap = counted().filter((l) => fam.has(l.journal_entry_id) && l.account_id === A.x2000).reduce((s, l) => s + l.debit_cents - l.credit_cents, 0);
    assert.strictEqual(net, 0); assert.strictEqual(ap, 0, 'AP effect of the 00169 family is zero after both voids');
    assert.strictEqual(header(header('je-neut').void_reversal_je_id).posting_date, '2026-07-28');
    assert.strictEqual(header(header('je-repost').void_reversal_je_id).posting_date, '2026-08-01');
    assert.deepStrictEqual(db.journal_entry_corrections.map((c) => [c.kind, c.original_je_id, c.actor_user_id]), [['void', 'je-neut', OWNER.id], ['void', 'je-repost', OWNER.id]]);
  });

  realLog('page wiring (public/accounting.html)');
  await t('the entry modal previews, confirms in-page, posts with the session token, and never sends a user id', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'accounting.html'), 'utf8');
    const start = html.indexOf('function jevWire('); const end = html.indexOf('function jevMessage(');
    assert.ok(start > 0 && end > start, 'jevWire exists');
    const src = html.slice(start, end);
    assert.ok(/void-preview\?reversal_date=/.test(src) && /headers: await chkAuthHeader\(\)/.test(src), 'preview sends the session token');
    assert.ok(/\/void`, \{ method:'POST', headers: Object\.assign\(\{'Content-Type':'application\/json'\}, await chkAuthHeader\(\)\)/.test(src), 'void sends the session token');
    assert.ok(/await txConfirm\(\{/.test(src), 'in-page confirmation (native confirm() is suppressed in embedded browsers)');
    assert.ok(!/[^.\w]confirm\(/.test(src) && !/alert\(/.test(src), 'no native confirm()/alert() in the void flow');
    assert.ok(!/user_id/.test(src), 'the page never sends a user id');
    assert.ok(/showErr\(j, r\.status\)/.test(src), 'refusals are shown');
    assert.ok(/<script src="\/app\/confirm\.js"><\/script>/.test(html), 'txConfirm is loaded on the page');
    assert.ok(/jevWire\(id, e\)/.test(html) && /e\.status==='posted' && window\._isAdmin/.test(html), 'the action is offered on posted entries to the admin session');
  });

  server.close();
  console.error = realError; console.warn = realWarn; console.log = realLog;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error = realError; realError(e); process.exit(1); });
