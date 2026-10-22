#!/usr/bin/env node
// ============================================================================
// test_ap_missing_bills.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// Emma's missing recurring bill check (lib/ap/missing_bills.js), against the
// real Canyon Gate bill history as it stood on 2026-10-15, when the September
// close found these bills missing only at close:
//
//   Star Protection, weekly: no bill for 9/6-9/12 or 9/20-9/26
//   Gexa 2939256-2939259: no mid-September bill, while 2939255 (billed with
//   them every month) sent one
//
// It must find exactly those, and must NOT flag Earthcare (its monthly bill is
// on file; its one-off repairs are not a cadence), an attorney, or a vendor
// whose bills don't follow a cadence. The tick must open one Emma task per
// missing bill with a stable source_ref, never duplicate it, never re-open one
// Emma closed, and close its own task once the bill arrives.
//
//   node tests/test_ap_missing_bills.js
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const path = require('path');
const { findMissingBills, tick, acctKey } = require('../lib/ap/missing_bills');
const FX = require(path.join(__dirname, 'fixtures', 'ap-missing-bills', 'canyon-gate-2026-10-15.json'));

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

const run = (over = {}) => findMissingBills({ bills: FX.bills, contracts: FX.contracts, legalVendorIds: FX.legal_vendor_ids, today: FX.as_of, ...over });
const label = (m) => `${m.vendor_name}|${m.account_number || ''}|${m.kind}|${m.period ? m.period[0] : m.expected_date}`;

t('Canyon Gate 10/15: Star\'s two missing September weeks are found, with their service weeks', () => {
  const star = run().filter((m) => /Star Protection/.test(m.vendor_name));
  assert.deepStrictEqual(star.map((m) => [m.kind, m.period]), [
    ['gap', ['2026-09-06', '2026-09-12']],
    ['gap', ['2026-09-20', '2026-09-26']],
  ]);
  assert.ok(star.every((m) => m.cadence === 'weekly'));
});

t('Canyon Gate 10/15: Gexa 2939256-2939259 are missing their mid-September bill; 2939255 is not', () => {
  const gexa = run().filter((m) => /Gexa/.test(m.vendor_name));
  assert.deepStrictEqual(gexa.map((m) => m.account_number).sort(), ['2939256', '2939257', '2939258', '2939259']);
  for (const m of gexa) {
    assert.strictEqual(m.kind, 'overdue');
    assert.strictEqual(m.expected_date, '2026-09-14');
    assert.match(m.basis, /billed together with account 2939255/);
  }
});

t('Canyon Gate 10/15: no false alarm on Earthcare (monthly on file; one-off repairs are no cadence) or the attorney', () => {
  const all = run();
  assert.ok(!all.some((m) => /Earthcare/i.test(m.vendor_name)), all.map(label).join('\n'));
  assert.ok(!all.some((m) => /DAUGHTRY/i.test(m.vendor_name)), 'attorneys bill as work happens');
  assert.ok(!all.some((m) => /S&L|Texas Access|GymTech|Versatex/i.test(m.vendor_name)), 'irregular vendors are not recurring');
});

t('the same history a month earlier (9/16): Star 9/6-9/12 is already caught the day it is late', () => {
  const asOf = run({ today: '2026-09-19', bills: FX.bills.filter((b) => b.invoice_date <= '2026-09-19') });
  const star = asOf.filter((m) => /Star Protection/.test(m.vendor_name));
  assert.deepStrictEqual(star.map((m) => [m.kind, m.period && m.period[0]]), [['overdue', '2026-09-06']]);
});

t('a recurring bill is not "missing" before its tolerance runs out', () => {
  // Star's next week (10/4-10/10) is due ~10/12; four days' grace means not yet on 10/15.
  assert.ok(!run().some((m) => /Star Protection/.test(m.vendor_name) && m.kind === 'overdue'));
});

t('an ended or expired contract ends the expectation', () => {
  const earthcare = FX.bills.find((b) => /Earthcare/i.test(b.vendor_name)).vendor_id;
  const later = run({ today: '2026-11-20' }).filter((m) => m.vendor_id === earthcare);
  assert.strictEqual(later.length, 1, 'with an active contract, the missed November bill is reported');
  const ended = run({ today: '2026-11-20', contracts: [{ vendor_id: earthcare, status: 'active', end_date: '2026-10-31', periodic_frequency: 'monthly' }] }).filter((m) => m.vendor_id === earthcare);
  assert.strictEqual(ended.length, 0, 'contract ended 10/31: no November bill is expected');
});

t('series keys: 6+ digit account numbers split a vendor; short ones (Star "519") do not', () => {
  assert.strictEqual(acctKey('2939256'), '2939256');
  assert.strictEqual(acctKey('8777 70 510 0109188'), '8777705100109188');
  assert.strictEqual(acctKey('519'), null);
  assert.strictEqual(acctKey(null), null);
});

t('empty / malformed input is safe', () => {
  assert.deepStrictEqual(findMissingBills({ bills: [], today: '2026-10-15' }), []);
  assert.deepStrictEqual(findMissingBills({ bills: [{ vendor_id: 'v' }, null, { invoice_date: '2026-01-01' }], today: '2026-10-15' }), []);
});

// ---- the tick, against an in-memory store ---------------------------------
function fakeSupabase(store) {
  return {
    from(table) {
      const st = { filters: [], op: 'select' };
      const rows = () => (store[table] || []).filter((r) => st.filters.every((f) => f(r)));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range(a, b) { st.range = [a, b]; return q; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return q; }, neq(c, v) { st.filters.push((r) => r[c] !== v); return q; },
        gte(c, v) { st.filters.push((r) => String(r[c]) >= v); return q; }, in(c, v) { st.filters.push((r) => v.includes(r[c])); return q; },
        not() { return q; }, like(c, p) { const pre = p.replace(/%$/, ''); st.filters.push((r) => String(r[c] || '').startsWith(pre)); return q; },
        update(p) { st.op = 'update'; st.payload = p; return q; },
        insert(p) { (store[table] = store[table] || []).push(...(Array.isArray(p) ? p : [p])); st.op = 'insert'; return q; },
        then(res, rej) {
          if (st.op === 'update') { rows().forEach((r) => Object.assign(r, st.payload)); return Promise.resolve({ data: null, error: null }).then(res, rej); }
          if (st.op === 'insert') return Promise.resolve({ data: null, error: null }).then(res, rej);
          let d = rows(); if (st.range) d = d.slice(st.range[0], st.range[1] + 1);
          return Promise.resolve({ data: d, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

t('tick: one Emma task per missing bill, stable source_ref, no duplicates on re-run; closed tasks stay closed; arrived bills close their task', async () => {
  const lifecycle = require('../lib/community/lifecycle');
  const realOps = lifecycle.operationalCommunities;
  lifecycle.operationalCommunities = async () => [{ id: 'c-cg', name: 'Canyon Gate at Cinco Ranch', is_demo: false }];
  try {
    const store = {
      ap_invoices: FX.bills.map((b, i) => ({ id: `inv-${i}`, community_id: 'c-cg', status: 'paid', ...b, vendors: { name: b.vendor_name, is_legal_counsel: FX.legal_vendor_ids.includes(b.vendor_id) } })),
      vendor_contracts: FX.contracts.map((c) => ({ ...c, community_id: 'c-cg' })),
      work_items: [], work_item_events: [],
    };
    const sb = fakeSupabase(store);
    const upsertTask = async (opts) => {   // same de-dup rule as api/mission_control upsertTask
      const open = store.work_items.find((w) => w.source_ref === opts.source_ref && ['new', 'in_progress', 'waiting'].includes(w.status));
      if (open) { Object.assign(open, opts); return { id: open.id, created: false }; }
      const row = { id: `wi-${store.work_items.length + 1}`, status: 'new', source_type: 'agent', created_at: new Date().toISOString(), ...opts };
      store.work_items.push(row); return { id: row.id, created: true };
    };
    const quiet = { log() {}, warn() {}, error() {} };
    const r1 = await tick({ supabase: sb, today: new Date('2026-10-15T12:00:00Z'), logger: quiet, upsertTask });
    const expected = run().length;
    assert.strictEqual(r1.created, expected);
    assert.ok(store.work_items.every((w) => w.assigned_to === 'Emma' && /^ap-missing-bill:c-cg:/.test(w.source_ref)));
    const starTask = store.work_items.find((w) => /Star Protection/.test(w.title) && /2026-09-06/.test(w.title));
    assert.ok(starTask, store.work_items.map((w) => w.title).join('\n'));
    assert.match(starTask.summary, /although the bills before and after it are on file/);

    const r2 = await tick({ supabase: sb, today: new Date('2026-10-15T18:00:00Z'), logger: quiet, upsertTask });
    assert.strictEqual(r2.created, 0); assert.strictEqual(r2.updated, expected);
    assert.strictEqual(store.work_items.length, expected, 'a re-run never duplicates');

    // Emma dismisses the Gexa 2939257 task ("account closed"): it must not come back.
    const g = store.work_items.find((w) => /2939257/.test(w.title)); g.status = 'dismissed';
    // The Star 9/6-9/12 bill arrives.
    store.ap_invoices.push({ id: 'inv-late', community_id: 'c-cg', status: 'awaiting_approval', vendor_id: FX.bills.find((b) => /Star Protection/.test(b.vendor_name)).vendor_id,
      vendor_name: 'Star Protection Agency LLC', account_number: null, invoice_date: '2026-09-14', service_period_start: '2026-09-06', service_period_end: '2026-09-12', total_cents: 427529, vendors: { name: 'Star Protection Agency LLC', is_legal_counsel: false } });
    const before = new Set(store.work_items.map((w) => w.source_ref));
    const r3 = await tick({ supabase: sb, today: new Date('2026-10-16T12:00:00Z'), logger: quiet, upsertTask });
    // Only bills that newly went late on 10/16 open a task (Comcast 0924479's October bill does).
    const fresh = store.work_items.filter((w) => !before.has(w.source_ref));
    assert.strictEqual(r3.created, fresh.length);
    assert.ok(fresh.every((w) => !/2939257|Star Protection/.test(w.title)), fresh.map((w) => w.title).join('; '));
    assert.strictEqual(store.work_items.filter((w) => /2939257/.test(w.title)).length, 1, 'the dismissed task is not re-opened');
    assert.strictEqual(starTask.status, 'done', 'the arrived bill closes its task');
    assert.strictEqual(r3.resolved, 1);
    assert.ok(store.work_item_events.some((e) => e.work_item_id === starTask.id && e.event === 'status_changed'));
  } finally { lifecycle.operationalCommunities = realOps; }
});

t('auto-close: only tasks still "new" are closed, and the closing note is appended, never overwriting the notes Emma wrote', async () => {
  const lifecycle = require('../lib/community/lifecycle');
  const realOps = lifecycle.operationalCommunities;
  lifecycle.operationalCommunities = async () => [{ id: 'c-cg', name: 'Canyon Gate at Cinco Ranch', is_demo: false }];
  try {
    const store = {
      ap_invoices: FX.bills.map((b, i) => ({ id: `inv-${i}`, community_id: 'c-cg', status: 'paid', ...b, vendors: { name: b.vendor_name, is_legal_counsel: false } })),
      vendor_contracts: [], work_item_events: [],
      work_items: [
        { id: 'wi-new', source_ref: 'ap-missing-bill:c-cg:acct:1111111:2026-08-01', source_type: 'agent', status: 'new', notes: 'Emma: asked vendor 9/20.' },
        { id: 'wi-busy', source_ref: 'ap-missing-bill:c-cg:acct:2222222:2026-08-01', source_type: 'agent', status: 'in_progress', notes: 'Emma: vendor says it was mailed.' },
      ],
    };
    const r = await tick({ supabase: fakeSupabase(store), today: new Date('2026-10-15T12:00:00Z'), logger: { log() {}, warn() {}, error() {} }, upsertTask: async () => ({ id: 'x', created: true }) });
    const closed = store.work_items.find((w) => w.id === 'wi-new'), busy = store.work_items.find((w) => w.id === 'wi-busy');
    assert.strictEqual(closed.status, 'done');
    assert.ok(closed.notes.startsWith('Emma: asked vendor 9/20.'), closed.notes);
    assert.match(closed.notes, /Closed by the missing-bill check on 2026-10-15/);
    assert.strictEqual(busy.status, 'in_progress', 'a task Emma is working is hers to close');
    assert.strictEqual(busy.notes, 'Emma: vendor says it was mailed.');
    assert.strictEqual(r.resolved, 1);
  } finally { lifecycle.operationalCommunities = realOps; }
});

t('write scope: the job writes ONLY Mission Control rows (work_items + their audit events), never bills, journal entries, payments or email', async () => {
  const lifecycle = require('../lib/community/lifecycle');
  const realOps = lifecycle.operationalCommunities;
  lifecycle.operationalCommunities = async () => [{ id: 'c-cg', name: 'Canyon Gate at Cinco Ranch', is_demo: false }];
  try {
    const store = {
      ap_invoices: FX.bills.map((b, i) => ({ id: `inv-${i}`, community_id: 'c-cg', status: 'paid', ...b, vendors: { name: b.vendor_name, is_legal_counsel: false } })),
      vendor_contracts: FX.contracts.map((c) => ({ ...c, community_id: 'c-cg' })),
      work_items: [{ id: 'wi-old', source_ref: 'ap-missing-bill:c-cg:acct:9999999:2026-01-01', source_type: 'agent', status: 'new' }],
      work_item_events: [],
    };
    const inner = fakeSupabase(store);
    const writes = [];
    const spy = { from(table) {
      const q = inner.from(table);
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        const orig = q[op];
        q[op] = (...a) => { writes.push(`${table}.${op}`); return orig ? orig.apply(q, a) : q; };
      }
      return q;
    }, rpc() { writes.push('rpc'); return Promise.resolve({ data: null, error: null }); } };
    const tasks = [];
    const r = await tick({ supabase: spy, today: new Date('2026-10-15T12:00:00Z'), logger: { log() {}, warn() {}, error() {} }, upsertTask: async (o) => { tasks.push(o); return { id: 'x', created: true }; } });
    assert.ok(r.created > 0 && r.resolved === 1, JSON.stringify(r));
    const tables = new Set(writes.map((w) => w.split('.')[0]));
    assert.deepStrictEqual([...tables].sort(), ['work_item_events', 'work_items'], writes.join(', '));
    assert.ok(tasks.every((o) => o.assigned_to === 'Emma' && /^ap-missing-bill:/.test(o.source_ref)));
    // And the module cannot reach posting, payment, approval, email or AI code.
    const src = require('fs').readFileSync(require.resolve('../lib/ap/missing_bills'), 'utf8');
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(reqs, ['../../api/mission_control', '../community/lifecycle', '../db/fetch_all']);
  } finally { lifecycle.operationalCommunities = realOps; }
});

(async () => {
  for (const r of results) {
    try { await r.fn(); console.log(`  ✓ ${r.name}`); }
    catch (e) { failed += 1; console.log(`  ✗ ${r.name}\n      ${e.message.split('\n').join('\n      ')}`); }
  }
  console.log(failed ? `\n${failed} missing-bill check(s) FAILED` : `\nall ${results.length} missing-bill checks passed`);
  process.exit(failed ? 1 : 0);
})();
