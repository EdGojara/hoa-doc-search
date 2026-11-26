// Owner closing package (lib/home_sales/transfer_package.js): one approval for completed builder
// closings. Invented data only.
const assert = require('assert');
const P = require('../lib/home_sales/transfer_package');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + ': ' + e.message); } }

// A tiny in-memory PostgREST stand-in: filters eq / neq / is / ilike / gte, order, limit, single.
function fakeDb(tables, rpcs = {}) {
  const calls = [];
  function q(table) {
    let rows = (tables[table] || []).slice(); let one = null;
    const api = {
      select() { return api; },
      eq(c, v) { rows = rows.filter((r) => r[c] === v); return api; },
      neq(c, v) { rows = rows.filter((r) => r[c] !== v); return api; },
      is(c, v) { rows = rows.filter((r) => (r[c] == null) === (v == null)); return api; },
      ilike(c, v) { const re = new RegExp('^' + String(v).replace(/%/g, '.*') + '$', 'i'); rows = rows.filter((r) => re.test(String(r[c] || ''))); return api; },
      gte(c, v) { rows = rows.filter((r) => String(r[c]) >= String(v)); return api; },
      order() { return api; }, limit(n) { rows = rows.slice(0, n); return api; },
      single() { one = 'single'; return api; }, maybeSingle() { one = 'maybe'; return api; },
      then(res, rej) {
        if (one === 'single') return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'not one row' } }).then(res, rej);
        if (one === 'maybe') return Promise.resolve({ data: rows[0] || null, error: null }).then(res, rej);
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return api;
  }
  return { calls, from: q, rpc: async (name, args) => { calls.push([name, args]); return rpcs[name] ? rpcs[name](args) : { data: {}, error: null }; } };
}

const CID = 'c0000000-0000-4000-8000-000000000001';
function world() {
  return {
    ownership_change_proposals: [
      { id: 'prop-a', community_id: CID, status: 'pending', property_id: 'lot-a', proposed_owner_name: 'Buyer A', effective_start_date: '2026-09-10', properties: { street_address: '100 Example Way' } },
      { id: 'prop-b', community_id: CID, status: 'pending', property_id: 'lot-b', proposed_owner_name: 'Buyer B', effective_start_date: '2026-10-05', properties: { street_address: '102 Example Way' } },
      { id: 'prop-old', community_id: CID, status: 'pending', property_id: 'lot-c', proposed_owner_name: 'Buyer C', effective_start_date: '2026-05-01', properties: { street_address: '104 Example Way' } },
      { id: 'prop-none', community_id: CID, status: 'pending', property_id: 'lot-d', proposed_owner_name: 'Buyer D', effective_start_date: '2026-10-01', properties: { street_address: '106 Example Way' } },
      { id: 'prop-resale', community_id: CID, status: 'pending', property_id: 'lot-e', proposed_owner_name: 'Buyer E', effective_start_date: '2026-10-01', properties: { street_address: '108 Example Way' } },
    ],
    ownership_tenures: [
      { id: 'ten-a', property_id: 'lot-a', kind: 'owner', end_date: null },
      { id: 'ten-b', property_id: 'lot-b', kind: 'owner', end_date: null },
      { id: 'ten-c', property_id: 'lot-c', kind: 'owner', end_date: null },
      { id: 'ten-e', property_id: 'lot-e', kind: 'owner', end_date: null },
    ],
    journal_entries: [], homeowner_transactions: [], communities: [{ id: CID, name: 'Example HOA' }], accounting_runs: [],
  };
}
const PLANS = { 'lot-a': { builder_adjustment_cents: 2000, homeowner_due_cents: 15000, seller_names: ['Example Builder'] }, 'lot-b': { builder_adjustment_cents: 4100, homeowner_due_cents: 9000, seller_names: ['Example Builder'] } };
function deps(extra = {}) {
  const gateCalls = [];
  return {
    gateCalls,
    cutover: async () => '2026-08-01',
    CS: { loadCapitalization: async () => ({ configured: true, amount_cents: 30000 }) },
    TP: {
      gateTransferProration: async (_s, a) => { gateCalls.push(a);
        if (a.propertyId === 'lot-e') return { proceed: true, plan: { applies: false } };
        if (a.confirmed) return { proceed: true, plan: { applies: true, ...PLANS[a.propertyId] } };
        return { proceed: false, status: 409, body: { code: 'proration_confirmation_required', proration: { applies: true, ...PLANS[a.propertyId] } } }; },
      afterTransfer: async () => ({ status: 'posted' }),
    },
    ...extra,
  };
}

(async () => {
  console.log('transfer package');

  await check('the package lists builder closings with totals; the rest are excluded with reasons', async () => {
    const pkg = await P.buildPackage(fakeDb(world()), { communityId: CID, deps: deps() });
    assert.deepStrictEqual(pkg.rows.map((r) => r.proposal_id), ['prop-a', 'prop-b']);
    assert.deepStrictEqual(pkg.totals, { transfers: 2, builder_adjustment_cents: 6100, homeowner_due_cents: 24000, capitalization_cents: 60000 });
    const why = Object.fromEntries(pkg.excluded.map((x) => [x.proposal_id, x.reason]));
    assert.match(why['prop-old'], /before the GL cutover/);
    assert.match(why['prop-none'], /no current owner/);
    assert.match(why['prop-resale'], /not a builder closing/);
    assert.match(pkg.fingerprint, /^[0-9a-f]{64}$/);
  });

  await check('a lot already carrying a capitalization charge for this closing gets no second fee', async () => {
    const w = world(); w.homeowner_transactions.push({ id: 'h1', property_id: 'lot-b', txn_type: 'charge', description: 'Capitalization Fees - RE: Ownership Transfer', transaction_date: '2026-10-05' });
    const pkg = await P.buildPackage(fakeDb(w), { communityId: CID, deps: deps() });
    const b = pkg.rows.find((r) => r.proposal_id === 'prop-b');
    assert.strictEqual(b.capitalization_cents, 0);
    assert.match(b.capitalization_note, /already on this lot/);
    assert.strictEqual(pkg.totals.capitalization_cents, 30000);
    // An older charge (a prior owner's closing) does not count.
    const w2 = world(); w2.homeowner_transactions.push({ id: 'h2', property_id: 'lot-b', txn_type: 'charge', description: 'Capitalization Fees', transaction_date: '2025-01-01' });
    assert.strictEqual((await P.buildPackage(fakeDb(w2), { communityId: CID, deps: deps() })).totals.capitalization_cents, 60000);
  });

  await check('execute refuses a package that changed since the owner saw it, and without the owner', async () => {
    const db = fakeDb(world());
    await assert.rejects(P.executePackage(db, { communityId: CID, fingerprint: 'f'.repeat(64), owner: { user_id: 'u', email: 'owner@example.com' }, deps: deps() }), (e) => e.code === 'stale_package');
    await assert.rejects(P.executePackage(db, { communityId: CID, fingerprint: 'x', owner: null, deps: deps() }), (e) => e.code === 'approval_required');
    assert.strictEqual(db.calls.length, 0);   // nothing transferred
  });

  await check('execute transfers each lot through the existing path, then posts the fees in one Kat run', async () => {
    const db = fakeDb(world());
    const d = deps();
    const pkg = await P.buildPackage(db, { communityId: CID, deps: d });
    const prepared = []; const approved = [];
    d.R = { KAT: 'Kat', prepare: async (_s, a) => { prepared.push(a); return { run: { id: 'run-1', preview: { items: a.items.map((i) => ({ id: i.id })) } } }; },
      approveAndPost: async (_s, a) => { approved.push(a); db.from('accounting_runs'); return {}; } };
    // the run reads back as posted
    const w = world(); w.accounting_runs.push({ id: 'run-1', status: 'posted', result: { posted: [{}, {}] } });
    const db2 = fakeDb(w);
    const out = await P.executePackage(db2, { communityId: CID, fingerprint: pkg.fingerprint, owner: { user_id: 'u', email: 'owner@example.com' }, deps: d });
    assert.strictEqual(out.transferred, 2);
    assert.deepStrictEqual(db2.calls.map((c) => [c[0], c[1].p_proposal_id, c[1].p_settlement_date]), [['approve_ownership_proposal', 'prop-a', '2026-09-10'], ['approve_ownership_proposal', 'prop-b', '2026-10-05']]);
    assert.ok(d.gateCalls.filter((g) => g.confirmed).length === 2);
    assert.strictEqual(prepared.length, 1);
    const items = prepared[0].items;
    assert.deepStrictEqual(items.map((i) => [i.id, i.posting_date, i.homeowner.property_id]), [['capfee-prop-a', '2026-09-10', 'lot-a'], ['capfee-prop-b', '2026-10-05', 'lot-b']]);
    assert.deepStrictEqual(items[0].lines.map((l) => [l.account_number, l.debit_cents || 0, l.credit_cents || 0]), [['1300', 30000, 0], ['4020', 0, 30000]]);
    assert.deepStrictEqual(approved[0].approval, { channel: 'in_app', user_id: 'u', email: 'owner@example.com' });
    assert.deepStrictEqual(approved[0].include, ['capfee-prop-a', 'capfee-prop-b']);
    assert.deepStrictEqual([out.capitalization.status, out.capitalization.posted], ['posted', 2]);
  });

  await check('a refused transfer gets no capitalization fee; the others still complete', async () => {
    const d = deps();
    const pkg = await P.buildPackage(fakeDb(world()), { communityId: CID, deps: d });
    const prepared = [];
    d.R = { KAT: 'Kat', prepare: async (_s, a) => { prepared.push(a); return { run: { id: 'run-1', preview: { items: a.items.map((i) => ({ id: i.id })) } } }; }, approveAndPost: async () => ({}) };
    const db = fakeDb(world(), { approve_ownership_proposal: (a) => (a.p_proposal_id === 'prop-b' ? { data: null, error: { message: 'seller changed' } } : { data: {}, error: null }) });
    const out = await P.executePackage(db, { communityId: CID, fingerprint: pkg.fingerprint, owner: { user_id: 'u', email: 'owner@example.com' }, deps: d });
    assert.deepStrictEqual([out.transferred, out.failed], [1, 1]);
    assert.match(out.results.find((r) => r.proposal_id === 'prop-b').error, /seller changed/);
    assert.deepStrictEqual(prepared[0].items.map((i) => i.id), ['capfee-prop-a']);
  });

  await check('capitalization items: stable id per closing (posts once), buyer pays, dated at settlement', async () => {
    const items = P.capitalizationItems([{ proposal_id: 'p1', property_id: 'l1', address: '1 Test St', settlement_date: '2026-10-01', buyer: 'B', capitalization_cents: 30000 }, { proposal_id: 'p2', capitalization_cents: 0 }]);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, P.capItemId('p1'));
    assert.ok(items[0].evidence.basis.length >= 10);
    assert.strictEqual(P.capSourceRef('c', 'p1'), 'KATJE:c:capfee-p1');
  });

  if (failures) { console.log(`${failures} failed`); process.exit(1); }
  console.log('all passed');
})();
