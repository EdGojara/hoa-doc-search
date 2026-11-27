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

  await check('authorization: items carry the package fingerprint; Tessa\'s email lists every transfer and the total', async () => {
    const pkg = await P.buildPackage(fakeDb(world()), { communityId: CID, deps: deps() });
    const items = P.authorizationItems(pkg);
    assert.deepStrictEqual(items.map((i) => [i.n, i.proposal_id, i.settlement_date, i.capitalization_cents, i.fingerprint]), [[1, 'prop-a', '2026-09-10', 30000, pkg.fingerprint], [2, 'prop-b', '2026-10-05', 30000, pkg.fingerprint]]);
    const subject = P.requestSubject('ABCD1234', 'Example HOA', pkg.totals);
    assert.match(subject, /^Owner authorization ABCD1234: closing package, Example HOA, 2 ownership transfers, \$901\.00 in new charges$/);   // Tessa's inbox matches "owner authorization XXXXXXXX"
    const mail = P.renderRequest({ subject, pkg, communityName: 'Example HOA', expiresAt: 'soon' });
    assert.match(mail.text, /Reply "approved"/);
    assert.match(mail.text, /1\. 100 Example Way, settled 9\/10\/2026, to Buyer A: builder \$20\.00, buyer \$150\.00, capitalization \$300\.00/);
    assert.match(mail.text, /104 Example Way \(5\/1\/2026\): dated before the GL cutover/);
    assert.ok(!/—/.test(mail.text + mail.html), 'no em-dashes');
  });

  await check('authorization: the reply-approved package runs the same workflow, fees approved under the authorization', async () => {
    const d = deps();
    const pkg = await P.buildPackage(fakeDb(world()), { communityId: CID, deps: d });
    const auth = { id: 'auth-1', status: 'authorized', scope: 'closing_packages', authorized_by_email: 'owner@example.com', subject: 'Owner authorization X', items: P.authorizationItems(pkg) };
    const approved = [];
    d.R = { KAT: 'Kat', prepare: async (_s, a) => ({ run: { id: 'run-1', preview: { items: a.items.map((i) => ({ id: i.id })) } } }), approveAndPost: async (_s, a) => { approved.push(a); return {}; } };
    const w = world(); w.accounting_runs.push({ id: 'run-1', status: 'posted', result: { posted: [{}, {}] } });
    const db = fakeDb(w); const marked = [];
    const out = await P.executeAuthorized({ supabase: db, rpc: async (n, a) => { marked.push([n, a.p_id]); }, deps: d }, auth);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(db.calls.map((c) => c[1].p_proposal_id), ['prop-a', 'prop-b']);
    assert.match(db.calls[0][1].p_reviewed_by, /authorized by email reply, owner authorization auth-1/);
    assert.deepStrictEqual(approved[0].approval, { channel: 'owner_closing_package', authorization_id: 'auth-1' });
    assert.deepStrictEqual(marked, [['owner_authorization_mark_executed', 'auth-1']]);
    assert.match(P.renderCompletion(auth, out).text, /2 transfer\(s\) recorded, 0 not\.\nCapitalization fees: 2 of 2 posted/);
  });

  await check('authorization: refused when not authorized, or when the package now lists other transfers', async () => {
    const d = deps();
    const pkg = await P.buildPackage(fakeDb(world()), { communityId: CID, deps: d });
    const items = P.authorizationItems(pkg);
    const db = fakeDb(world());
    await assert.rejects(P.executeAuthorized({ supabase: db, deps: d }, { id: 'a', status: 'requested', scope: 'closing_packages', authorized_by_email: 'o', items }), (e) => e.code === 'approval_required');
    await assert.rejects(P.executeAuthorized({ supabase: db, deps: d }, { id: 'a', status: 'authorized', scope: 'accounting_runs', authorized_by_email: 'o', items }), (e) => e.code === 'approval_required');
    // same fingerprint cannot be forged onto a different list: a missing item is refused
    await assert.rejects(P.executeAuthorized({ supabase: db, deps: d }, { id: 'a', status: 'authorized', scope: 'closing_packages', authorized_by_email: 'o', items: items.slice(0, 1) }), (e) => e.code === 'stale_package');
    // a changed package (new transfer appears) changes the fingerprint
    const w = world(); w.ownership_change_proposals.push({ id: 'prop-z', community_id: CID, status: 'pending', property_id: 'lot-a', proposed_owner_name: 'Z', effective_start_date: '2026-11-01', properties: { street_address: '110 Example Way' } });
    await assert.rejects(P.executeAuthorized({ supabase: fakeDb(w), deps: d }, { id: 'a', status: 'authorized', scope: 'closing_packages', authorized_by_email: 'o', items }), (e) => e.code === 'stale_package');
    assert.strictEqual(db.calls.length, 0);
  });

  await check('authorization service: closing packages are a registered tier-1 action approved whole (no partial replies)', async () => {
    const AZ = require('../lib/authorization');
    const a = AZ.actionForScope('closing_packages');
    assert.ok(a && a.executable && a.type === 'closing_package');
    assert.strictEqual(AZ.tierOf ? AZ.tierOf(a, {}) : a.tier, 1);
    assert.ok(!a.parseReply && !a.supportsExclusions);
  });

  if (failures) { console.log(`${failures} failed`); process.exit(1); }
  console.log('all passed');
})();
