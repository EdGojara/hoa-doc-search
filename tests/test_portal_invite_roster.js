// Bulk portal invite: dry run, approval hash, risky-recipient exclusion,
// silent account creation (Ed 2026-11-22, LOPF + CG launch). Offline: an
// in-memory Supabase stand-in records every write and every email.
'use strict';
const assert = require('assert');
const path = require('path');
const roster = require('../lib/portal/invite_roster');

// ---- 1) Pure roster rules ---------------------------------------------------
const owners = [
  { property_id: 'p1', street_address: '1 Oak', owner_contact_id: 'cA', owner_name: 'Ann A', owner_email: 'ann@example.com' },
  { property_id: 'p2', street_address: '2 Oak', owner_contact_id: 'cB', owner_name: 'Bob B', owner_email: '' },
  { property_id: 'p3', street_address: '3 Oak', owner_contact_id: 'cC', owner_name: 'Cy C', owner_email: 'one@example.com; two@example.com' },
  { property_id: 'p4', street_address: '4 Oak', owner_contact_id: 'cD', owner_name: 'Di D', owner_email: 'same@example.com' },
  { property_id: 'p5', street_address: '5 Oak', owner_contact_id: 'cE', owner_name: 'Ed E LLC', owner_email: 'Same@Example.com ' },
  { property_id: 'p6', street_address: '6 Oak', owner_contact_id: 'cF', owner_name: 'Rental Co', owner_email: 'admin@amgtx.com' },
  { property_id: 'p7', street_address: '7 Oak', owner_contact_id: 'cG', owner_name: 'Gil G', owner_email: 'office@somepm.com' },
  { property_id: 'p8', street_address: '8 Oak', owner_contact_id: 'cH', owner_name: 'Hoang H', owner_email: 'hoang@example.com' },
  { property_id: 'p9', street_address: '9 Oak', owner_contact_id: 'cH', owner_name: 'Hoang H', owner_email: 'hoang@example.com' },
  { property_id: 'p10', street_address: '10 Oak', owner_contact_id: 'cI', owner_name: 'Ivy I', owner_email: 'fkh1@m.mayhoa.com' },
];
let r = roster.buildRoster(owners, []);
const reasonOf = (cid) => (r.skipped.find((s) => s.contact_id === cid) || {}).reason;
assert.deepStrictEqual(r.invite.map((x) => x.contact_id), ['cA', 'cH'], 'only clean owners are invited');
assert.strictEqual(reasonOf('cB'), 'no_email');
assert.strictEqual(reasonOf('cC'), 'multiple_emails', 'packed emails excluded');
assert.strictEqual(reasonOf('cD'), 'shared_email', 'same inbox on different owners excluded (case/space-insensitive)');
assert.strictEqual(reasonOf('cE'), 'shared_email');
assert.strictEqual(reasonOf('cF'), 'management_inbox', 'property-manager domain excluded');
assert.strictEqual(reasonOf('cG'), 'management_inbox', 'role inbox office@ excluded');
assert.strictEqual(reasonOf('cI'), 'management_inbox', 'manager subdomain excluded');
assert.strictEqual(roster.classifyEmail('hoang@example.com'), null, 'a name starting with "hoa" is not a role inbox');
assert.deepStrictEqual(r.invite.find((x) => x.contact_id === 'cH').properties.map((p) => p.property_id), ['p8', 'p9'], 'multi-lot owner: one account, every lot');
assert.strictEqual(r.counts.lots, 10);

// Management inbox can be included deliberately; shared email cannot.
r = roster.buildRoster(owners, [], { includeFlagged: ['cF', 'cD'] });
assert.ok(r.invite.some((x) => x.contact_id === 'cF' && x.override === 'management_inbox'));
assert.ok(!r.invite.some((x) => x.contact_id === 'cD'), 'shared email is never overridable');

// Existing accounts: never duplicated; a silently created one is emailed once.
r = roster.buildRoster(owners, [
  { id: 'u1', email: 'ann@example.com', contact_id: 'cA', status: 'invited', invited_by: roster.SILENT_CREATE_MARK, first_login_at: null },
  { id: 'u2', email: 'hoang@example.com', contact_id: 'cH', status: 'active', invited_by: 'x', first_login_at: '2026-11-01' },
]);
assert.deepStrictEqual(r.invite.map((x) => [x.contact_id, x.action]), [['cA', 'email_existing']]);
assert.strictEqual(reasonOf('cH'), 'already_has_account');
r = roster.buildRoster(owners, [{ id: 'u3', email: 'ann@example.com', contact_id: 'cZ', status: 'active' }]);
assert.strictEqual(reasonOf('cA'), 'email_has_other_portal_account', 'an inbox already tied to another account is not reused');

// Restricting to contacts: a non-owner is named, not silently dropped.
r = roster.buildRoster(owners, [], { contactIds: ['cA', 'tenant1'] });
assert.deepStrictEqual(r.invite.map((x) => x.contact_id), ['cA']);
assert.strictEqual(reasonOf('tenant1'), 'not_a_current_owner');

// Hash: order-insensitive, changes when who/email/lots/action change.
const base = roster.buildRoster(owners, []).invite;
const h = roster.rosterHash('c1', base);
assert.strictEqual(roster.rosterHash('c1', [...base].reverse()), h);
assert.notStrictEqual(roster.rosterHash('c1', base.slice(1)), h);
assert.notStrictEqual(roster.rosterHash('c1', base.map((x) => ({ ...x, email: x.email + 'x' }))), h);
assert.notStrictEqual(roster.rosterHash('c2', base), h);
// Owner payments switch: on only after balances are verified and fees are set.
const fa = require('../lib/portal/financial_access');
const at = '2026-11-22T00:00:00Z';
assert.strictEqual(fa.paymentsSwitchConfig({}, { on: true, by: 'o', at }).error, 'balances_not_verified');
const verifiedCfg = fa.balancesOnConfig({}, { verifiedBy: 'o', note: null, at });
assert.strictEqual(fa.paymentsSwitchConfig(verifiedCfg, { on: true, by: 'o', at }).error, 'payment_fees_not_set');
const onCfg = fa.paymentsSwitchConfig({ ...verifiedCfg, payment_fees: { card_fee_bps: 350 } }, { on: true, by: 'o', at }).cfg;
assert.strictEqual(fa.decideFinancialAccess({ portal_module_config: onCfg }).reason, 'stripe_not_ready', 'Stripe readiness still required');
assert.strictEqual(fa.decideFinancialAccess({ portal_module_config: onCfg, stripe_connected_account_id: 'acct_1', stripe_onboarding_status: 'enabled' }).payments, true);
const offCfg = fa.paymentsSwitchConfig(onCfg, { on: false, by: 'o', at }).cfg;
assert.deepStrictEqual([fa.decideFinancialAccess({ portal_module_config: offCfg, stripe_connected_account_id: 'acct_1', stripe_onboarding_status: 'enabled' }).payments, offCfg.balance.status], [false, 'live'], 'payments off leaves balances on');
const withPilot = { portal_pilot: { user_ids: ['u1'], set_by: 'o', set_at: at }, balance: { status: 'live' } };
assert.deepStrictEqual(fa.carryFinancialStamp(withPilot, { balance: { status: 'hidden' } }).portal_pilot, withPilot.portal_pilot, 'ordinary config writes keep the pilot list');
assert.strictEqual(fa.carryFinancialStamp({}, { portal_pilot: { user_ids: ['x'] } }).portal_pilot, undefined, 'and cannot forge it');
const po = require('../lib/portal/portal_open');
assert.ok(po.isOpenCommunity({ portal_active: false, portal_module_config: withPilot }, 'u1'));
assert.ok(!po.isOpenCommunity({ portal_active: false, portal_module_config: withPilot }, 'u2'));
assert.ok(!po.isOpenCommunity({ portal_active: false, portal_module_config: withPilot }), 'association-wide question never counts the pilot');
console.log('test_portal_invite_roster (rules): ok');

// ---- 2) Endpoint against an in-memory database --------------------------------
function makeFake(db) {
  const writes = [];
  let seq = 0;
  function from(table) {
    const st = { filters: [], op: 'select', payload: null, head: false, single: false, range: null };
    const api = {
      select(_c, o) { if (o && o.head) st.head = true; return api; },
      eq(c, v) { st.filters.push((x) => x[c] === v); return api; },
      is(c, v) { st.filters.push((x) => (x[c] == null ? null : x[c]) === v); return api; },
      in(c, vs) { st.filters.push((x) => vs.includes(x[c])); return api; },
      order() { return api; }, limit() { return api; },
      range(a, b) { st.range = [a, b]; return api; },
      maybeSingle() { st.single = true; return api; }, single() { st.single = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      upsert(p) { st.op = 'upsert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
    };
    function run() {
      const rows = db[table] || (db[table] = []);
      if (st.op === 'insert') {
        const made = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((x) => ({ id: `${table}-${++seq}`, ...x }));
        rows.push(...made); writes.push({ table, op: 'insert', n: made.length });
        return { data: st.single ? made[0] : made, error: null };
      }
      if (st.op === 'upsert') { writes.push({ table, op: 'upsert' }); return { data: null, error: null }; }
      if (st.op === 'update') {
        writes.push({ table, op: 'update' });
        for (const x of rows.filter((x) => st.filters.every((f) => f(x)))) Object.assign(x, st.payload);
        return { data: null, error: null };
      }
      let out = rows.filter((x) => st.filters.every((f) => f(x)));
      if (st.head) return { count: out.length, data: null, error: null };
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      return { data: st.single ? (out[0] || null) : out, error: null };
    }
    return api;
  }
  return { from, writes, auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
}

const { BEDROCK_MGMT_CO_ID } = require('../lib/company');
const db = {
  communities: [{ id: 'c1', name: 'Sample HOA', slug: 'sample', portal_active: false, is_demo: false, portal_module_config: {} }],
  properties: owners.map((o) => ({ id: o.property_id, community_id: 'c1', excluded_at: null })),
  v_current_property_owners: owners.map((o) => ({ ...o, community_id: 'c1' })),
  portal_users: [],
};
const fake = makeFake(db);
const sent = [];
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const sbPath = require.resolve('@supabase/supabase-js');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => fake } };
stub('api/_require_admin.js', {
  requireOwner: async (req, res) => (req.headers['x-test-owner'] ? { email: 'owner@example.com' } : (res.status(403).json({ error: 'owner_only' }), null)),
});
stub('lib/email/portal_invite.js', { sendPortalInvite: async (a) => { sent.push(a); return { ok: true }; }, renderInviteEmail: () => ({}) });
process.env.PORTAL_INVITE_SEND_PER_SEC = '50';
const express = require('express');
const { router } = require('../api/portal_admin');

(async () => {
  const app = express(); app.use('/api/portal-admin', router);
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (body, owner = true) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/portal-admin/community/c1/bulk-invite`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': '1' } : {}) }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    // Dry run writes nothing and sends nothing.
    const p = await call({ dry_run: true });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(fake.writes.length, 0, 'dry run writes nothing');
    assert.strictEqual(sent.length, 0, 'dry run sends nothing');
    assert.ok(p.body.cross_check.ok && p.body.counts.invite === 2 && p.body.preview_hash);
    assert.ok(['cC', 'cD', 'cE', 'cF', 'cG', 'cI'].every((cid) => p.body.skipped.some((s) => s.contact_id === cid)), 'risky recipients excluded by default');

    // Writes are the owner's, and need the approved hash.
    assert.strictEqual((await call({ mode: 'create_only', preview_hash: p.body.preview_hash, portal_active_expected: false }, false)).status, 403);
    assert.strictEqual((await call({ mode: 'create_only', portal_active_expected: false })).body.error, 'preview_changed');

    // The list changes after preview -> refused, nothing written.
    db.v_current_property_owners.push({ property_id: 'p11', street_address: '11 Oak', owner_contact_id: 'cJ', owner_name: 'Jo J', owner_email: 'jo@example.com', community_id: 'c1' });
    db.properties.push({ id: 'p11', community_id: 'c1', excluded_at: null });
    const stale = await call({ mode: 'create_only', preview_hash: p.body.preview_hash, portal_active_expected: false });
    assert.strictEqual(stale.status, 409); assert.strictEqual(stale.body.error, 'preview_changed');
    assert.strictEqual(fake.writes.length, 0, 'a changed list writes nothing');

    // Cross-check: a live lot missing from the owner list blocks writes.
    db.properties.push({ id: 'p12', community_id: 'c1', excluded_at: null });
    const p2 = await call({ dry_run: true });
    assert.strictEqual(p2.body.cross_check.ok, false);
    assert.strictEqual((await call({ mode: 'create_only', preview_hash: p2.body.preview_hash, portal_active_expected: false })).body.error, 'roster_cross_check_failed');
    db.properties.pop();

    // Portal state must be what the owner chose; send refuses while the portal is off.
    const p3 = await call({ dry_run: true });
    assert.strictEqual((await call({ mode: 'create_only', preview_hash: p3.body.preview_hash, portal_active_expected: true })).body.error, 'portal_state_changed');
    assert.strictEqual((await call({ mode: 'send', preview_hash: p3.body.preview_hash })).body.error, 'portal_not_active');
    assert.strictEqual(fake.writes.length, 0);

    // Portal off = pilot: creating accounts for every owner needs explicit broader-launch approval.
    const pilotRefused = await call({ mode: 'create_only', preview_hash: p3.body.preview_hash, portal_active_expected: false });
    assert.strictEqual(pilotRefused.status, 409); assert.strictEqual(pilotRefused.body.error, 'pilot_mode');
    assert.strictEqual(fake.writes.length, 0, 'pilot mode writes nothing');

    // PILOT: owner-only route; adding one owner creates that one account silently
    // and returns a sign-in link to hand over. No email.
    const pilot = async (body, owner = true) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/portal-admin/community/c1/pilot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': '1' } : {}) }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    assert.strictEqual((await pilot({ action: 'add', contact_id: 'cA' }, false)).status, 403, 'only the owner writes the pilot list');
    assert.strictEqual(fake.writes.length, 0);
    assert.strictEqual((await pilot({ action: 'add', contact_id: 'cF' })).body.reason, 'management_inbox', 'risky inbox refused unless included');
    const added = await pilot({ action: 'add', contact_id: 'cA' });
    assert.strictEqual(added.status, 200); assert.strictEqual(added.body.emailed, false);
    assert.ok(/portal-login\.html\?token=/.test(added.body.sign_in_link), 'returns a sign-in link to hand over');
    assert.strictEqual(sent.length, 0, 'adding a pilot homeowner emails nobody');
    const pilotUser = db.portal_users.find((u) => u.contact_id === 'cA');
    assert.strictEqual(pilotUser.invited_by, 'portal-pilot');
    assert.deepStrictEqual(db.communities[0].portal_module_config.portal_pilot.user_ids, [pilotUser.id]);
    assert.strictEqual(db.communities[0].portal_module_config.portal_pilot.set_by, 'owner@example.com');

    // Ordinary config writes keep the list and cannot forge it; launching is the owner's.
    const patch = async (body, owner = false) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/portal-admin/community/c1/module-config`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': '1' } : {}) }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    assert.strictEqual((await patch({ module_config: { compliance: { status: 'live' }, portal_pilot: { user_ids: ['forged'] } } })).status, 200);
    assert.deepStrictEqual(db.communities[0].portal_module_config.portal_pilot.user_ids, [pilotUser.id], 'a tile write keeps the pilot list and cannot forge it');
    assert.strictEqual((await patch({ portal_active: true })).status, 403, 'staff cannot launch a portal');
    assert.strictEqual(db.communities[0].portal_active, false);

    // The pilot user sees their lot while the portal is off; nobody else does.
    const { openPropertyIds } = require('../lib/portal/portal_open');
    const gateDb = { from: () => ({ select: () => ({ in: async (_c, ids) => ({ data: ids.map((id) => ({ id, communities: db.communities[0] })), error: null }) }) }) };
    assert.deepStrictEqual([...await openPropertyIds(gateDb, ['p1'], pilotUser.id)], ['p1'], 'pilot user sees their lot while portal_active is false');
    assert.strictEqual((await openPropertyIds(gateDb, ['p8'], 'someone-else')).size, 0, 'a non-pilot user of the same association does not');
    assert.strictEqual((await openPropertyIds(gateDb, ['p1'])).size, 0, 'no user = no pilot');
    const pres = require('../lib/portal/financial_access').presentedModuleConfig(db.communities[0].portal_module_config, { balance: false });
    assert.strictEqual(pres.portal_pilot, undefined, 'the pilot list never reaches the homeowner browser');
    fake.writes.length = 0;

    // Broader launch, approved explicitly: accounts + lot grants, no email, no magic link.
    const p3b = await call({ dry_run: true });
    const made = await call({ mode: 'create_only', preview_hash: p3b.body.preview_hash, portal_active_expected: false, broader_launch_approved: true });
    assert.strictEqual(made.status, 200); assert.strictEqual(made.body.accounts_created, 2, 'the pilot account is not duplicated');
    assert.strictEqual(sent.length, 0, 'silent creation emails nobody');
    assert.ok(!fake.writes.some((w) => w.table === 'portal_magic_links'));
    assert.ok(db.portal_users.filter((u) => u.id !== pilotUser.id).every((u) => u.invited_by === roster.SILENT_CREATE_MARK && u.management_company_id === BEDROCK_MGMT_CO_ID));
    assert.ok(!db.portal_users.some((u) => ['cC', 'cD', 'cE', 'cF', 'cG', 'cI'].includes(u.contact_id)), 'no account for a risky recipient');

    // Switch day: portal on, preview shows them as not yet emailed, send emails each once.
    db.communities[0].portal_active = true;
    const p4 = await call({ dry_run: true });
    assert.strictEqual(p4.body.counts.invite_existing_silent, 2);
    const s = await call({ mode: 'send', preview_hash: p4.body.preview_hash });
    assert.strictEqual(s.status, 202); assert.strictEqual(s.body.emails_queued, 2); assert.strictEqual(s.body.accounts_created, 0);
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((ok) => setTimeout(ok, 20));
    await new Promise((ok) => setTimeout(ok, 50));
    assert.deepStrictEqual(sent.map((x) => x.toEmail).sort(), ['hoang@example.com', 'jo@example.com'], 'the pilot homeowner is not auto-invited');
    const p5 = await call({ dry_run: true });
    assert.strictEqual(p5.body.counts.invite, 0, 'after sending, nobody is left to email (no double send)');
    console.log('test_portal_invite_roster (endpoint): ok');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
