// Owner Authorization Service: silent portal account creation (Ed 2026-11-27, migration 586).
// Offline: an in-memory Supabase stand-in records every write; the real roster loader and the
// real shared create path (lib/portal/silent_create) run against it.
'use strict';
const assert = require('assert');
const path = require('path');

// No email may leave: any attempt to load a sender fails the test.
const sent = [];
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stub('lib/email/portal_invite.js', { sendPortalInvite: async (a) => { sent.push(a); return { ok: true }; }, renderInviteEmail: () => ({}) });

const PS = require('../lib/authorization/portal_silent_create');
const AZ = require('../lib/authorization');
const IR = require('../lib/portal/invite_roster');

function makeFake(db) {
  const writes = [];
  let seq = 0;
  function from(table) {
    const st = { filters: [], op: 'select', payload: null, head: false, single: false, range: null, ignoreDup: false, onConflict: null };
    const api = {
      select(_c, o) { if (o && o.head) st.head = true; return api; },
      eq(c, v) { st.filters.push((x) => x[c] === v); return api; },
      is(c, v) { st.filters.push((x) => (x[c] == null ? null : x[c]) === v); return api; },
      in(c, vs) { st.filters.push((x) => vs.includes(x[c])); return api; },
      order() { return api; }, limit() { return api; },
      range(a, b) { st.range = [a, b]; return api; },
      maybeSingle() { st.single = true; return api; }, single() { st.single = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.onConflict = o && o.onConflict; st.ignoreDup = !!(o && o.ignoreDuplicates); return api; },
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
      if (st.op === 'upsert') {
        const keys = String(st.onConflict || 'id').split(',');
        for (const p of Array.isArray(st.payload) ? st.payload : [st.payload]) {
          const hit = rows.find((x) => keys.every((k) => x[k] === p[k]));
          if (!hit) rows.push({ id: `${table}-${++seq}`, ...p }); else if (!st.ignoreDup) Object.assign(hit, p);
        }
        writes.push({ table, op: 'upsert' });
        return { data: null, error: null };
      }
      if (st.op === 'update') { writes.push({ table, op: 'update' }); for (const x of rows.filter((x) => st.filters.every((f) => f(x)))) Object.assign(x, st.payload); return { data: null, error: null }; }
      let out = rows.filter((x) => st.filters.every((f) => f(x)));
      if (st.head) return { count: out.length, data: null, error: null };
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      return { data: st.single ? (out[0] || null) : out, error: null };
    }
    return api;
  }
  return { from, writes, rpc: async () => ({ data: null, error: null }) };
}

const owners = [
  { property_id: 'p1', street_address: '1 Oak', owner_contact_id: 'cA', owner_name: 'Owner A', owner_email: 'a@example.com' },
  { property_id: 'p2', street_address: '2 Oak', owner_contact_id: 'cB', owner_name: 'Owner B', owner_email: 'b@example.com' },
  { property_id: 'p3', street_address: '3 Oak', owner_contact_id: 'cB', owner_name: 'Owner B', owner_email: 'b@example.com' },
  { property_id: 'p4', street_address: '4 Oak', owner_contact_id: 'cC', owner_name: 'Owner C', owner_email: 'shared@example.com' },
  { property_id: 'p5', street_address: '5 Oak', owner_contact_id: 'cD', owner_name: 'Owner D', owner_email: 'shared@example.com' },
  { property_id: 'p6', street_address: '6 Oak', owner_contact_id: 'cE', owner_name: 'Owner E', owner_email: '' },
];
function freshDb({ portalActive = false } = {}) {
  return {
    communities: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Sample Ridge', slug: 'sample-ridge', portal_active: portalActive, is_demo: false, portal_module_config: {} },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Lakes of Sample Forest', slug: 'lakes-sample', portal_active: false, is_demo: false, portal_module_config: {} }],
    properties: owners.map((o) => ({ id: o.property_id, community_id: '11111111-1111-1111-1111-111111111111', excluded_at: null })),
    v_current_property_owners: owners.map((o) => ({ ...o, community_id: '11111111-1111-1111-1111-111111111111' })),
    portal_users: [], portal_user_properties: [], portal_magic_links: [], portal_audit_log: [], authorization_events: [],
  };
}
const CID = '11111111-1111-1111-1111-111111111111';

(async () => {
  // ---- package + request email -------------------------------------------------------------
  let db = freshDb(); let sb = makeFake(db);
  const pkg = await PS.buildPackage(sb, ['sample-ridge']);
  assert.ok(pkg.ok, JSON.stringify(pkg.problems));
  const a = pkg.associations[0];
  assert.strictEqual(a.accounts_to_create, 2, 'two clean owners');
  assert.strictEqual(a.multi_lot_accounts, 1, 'the two-lot owner is one account');
  assert.strictEqual(a.skipped.shared_email, 2); assert.strictEqual(a.skipped.no_email, 1);
  assert.ok(/^[0-9a-f]{24}$/.test(a.roster_hash) && a.roster_hash === a.loaded.hash);
  const mail = PS.renderRequest({ subject: PS.requestSubject('ABCDEF12', pkg.associations), associations: pkg.associations, expiresAt: 'x' });
  assert.ok(!/—|–/.test(mail.text + mail.html), 'no em or en dashes');
  for (const must of ['No invitation or email goes to any homeowner', 'Balances and online payments stay off', 'Roster hash: ' + a.roster_hash, 'approved except', 'Owner authorization ABCDEF12'])
    assert.ok((mail.subject + mail.text).includes(must), `request says: ${must}`);
  const onDb = freshDb({ portalActive: true });
  const onPkg = await PS.buildPackage(makeFake(onDb), ['sample-ridge']);
  assert.ok(PS.PORTAL_ON_REFUSED && !onPkg.ok && onPkg.associations.length === 0 && /public launch hold/.test(onPkg.problems[0].problems.join(' ')), 'launch hold: a portal-on association is not requested');
  const badCross = freshDb(); badCross.properties.push({ id: 'p7', community_id: CID, excluded_at: null });
  assert.ok(!(await PS.buildPackage(makeFake(badCross), ['sample-ridge'])).ok, 'a failed lot cross-check is not requested');
  assert.ok(!(await PS.buildPackage(sb, ['no-such'])).ok, 'an unknown association is not requested');

  // ---- replies: "approved except <association>" -------------------------------------------
  const items = [{ n: 1, name: 'Canyon Gate at Cinco Ranch', slug: 'canyon-gate' }, { n: 2, name: 'Lakes of Pine Forest', slug: 'lpf' }, { n: 3, name: 'Waterview Estates', slug: 'waterview' }];
  assert.deepStrictEqual(PS.parseReply('Approved except Canyon Gate', items), { kind: 'approve', excluded: [1] });
  assert.deepStrictEqual(PS.parseReply('approved except LOPF and Waterview', items), { kind: 'approve', excluded: [2, 3] });
  assert.deepStrictEqual(PS.parseReply('approved except 2', items), { kind: 'approve', excluded: [2] });
  assert.deepStrictEqual(PS.parseReply('Approved', items), { kind: 'approve', excluded: [] });
  assert.strictEqual(PS.parseReply('not approved', items).kind, 'decline');
  assert.strictEqual(PS.parseReply('looks fine', items).kind, 'unclear');
  assert.strictEqual(PS.parseReply('approved except Eaglewood', items).kind, 'unclear', 'an unknown association is never read as approving all');
  assert.deepStrictEqual(PS.parseReply('Approved, except for Waterview', items), { kind: 'approve', excluded: [3] });
  assert.strictEqual(AZ.actionForScope('portal_silent_creates').type, 'portal_silent_create');

  const auth = (over = {}) => ({ id: 'auth-1', scope: 'portal_silent_creates', status: 'authorized', authorized_by_email: 'owner@example.com', requested_by: 'ai-team:amanda', sensitivity_tier: 1,
    items: [{ n: 1, community_id: CID, name: 'Sample Ridge', slug: 'sample-ridge', accounts_to_create: 2, portal_active: false, fingerprint: a.roster_hash, membership_hash: a.membership_hash }], evidence: {}, ...over });

  // ---- a non-authorized status refuses --------------------------------------------------------
  for (const status of ['requested', 'executed', 'expired', 'declined']) {
    await assert.rejects(() => AZ.executeAuthorized({ supabase: sb, rpc: async () => null }, auth({ status }), { channel: 'email' }), /no authorized portal silent create/, `status ${status} refuses`);
  }
  await assert.rejects(() => PS.executeAuthorized({ supabase: sb }, auth({ authorized_by_email: null })), /no authorized/, 'no authorizing person refuses');
  assert.strictEqual(db.portal_users.length, 0, 'nothing created by a refused authorization');

  // ---- a hash mismatch refuses ----------------------------------------------------------------
  let out = await AZ.executeAuthorized({ supabase: sb, rpc: async () => null }, auth({ items: [{ ...auth().items[0], fingerprint: 'f'.repeat(24), membership_hash: 'e'.repeat(24) }] }), { channel: 'email' });
  assert.ok(!out.ok && /roster hash differs/.test(out.results[0].detail), 'hash mismatch refuses');
  assert.strictEqual(db.portal_users.length, 0, 'nothing created on a hash mismatch');
  // ...and so does a roster that changed after approval (a new owner email).
  const changed = freshDb(); changed.v_current_property_owners[0].owner_email = 'new@example.com';
  out = await PS.executeAuthorized({ supabase: makeFake(changed) }, auth());
  assert.ok(!out.ok && changed.portal_users.length === 0, 'a changed owner list refuses');
  // ...a failed cross-check refuses, and a portal switched on after approval refuses.
  out = await PS.executeAuthorized({ supabase: makeFake(badCross) }, auth());
  assert.ok(!out.ok && /cross-check/.test(out.results[0].detail) && badCross.portal_users.length === 0);
  out = await PS.executeAuthorized({ supabase: makeFake(onDb) }, auth());
  assert.ok(!out.ok && /public launch hold/.test(out.results[0].detail) && onDb.portal_users.length === 0, 'launch hold: portal switched on after approval refuses');
  // Even an item approved while stating the portal was on is refused under the hold.
  out = await PS.executeAuthorized({ supabase: makeFake(onDb) }, auth({ items: [{ ...auth().items[0], portal_active: true }] }));
  assert.ok(!out.ok && /public launch hold/.test(out.results[0].detail) && onDb.portal_users.length === 0, 'launch hold: an approved portal-on association is refused');
  // And a portal switched OFF after approval (approved as on) is a state change: refused.
  out = await PS.executeAuthorized({ supabase: makeFake(freshDb()) }, auth({ items: [{ ...auth().items[0], portal_active: true }] }));
  assert.ok(!out.ok && /switched off/.test(out.results[0].detail), 'portal state change refuses');

  // ---- executes, creating no email or magic link ---------------------------------------------
  const marked = [];
  const rpc = async (name, args) => { marked.push({ name, args }); return null; };
  const before = JSON.stringify(db.communities);
  out = await AZ.executeAuthorized({ supabase: sb, rpc }, auth(), { channel: 'email' });
  assert.ok(out.ok, JSON.stringify(out.results));
  assert.strictEqual(db.portal_users.length, 2, 'two accounts');
  assert.ok(db.portal_users.every((u) => u.status === 'invited' && u.invited_by === IR.SILENT_CREATE_MARK && u.role === 'homeowner'), 'silent accounts');
  assert.deepStrictEqual(db.portal_user_properties.map((g) => g.property_id).sort(), ['p1', 'p2', 'p3'], 'each owner gets exactly their lots');
  assert.strictEqual(db.portal_magic_links.length, 0, 'no magic link');
  assert.strictEqual(sent.length, 0, 'no invitation email');
  assert.strictEqual(JSON.stringify(db.communities), before, 'portal_active and community settings untouched');
  const audit = db.portal_audit_log.find((r) => r.action === 'bulk_silent_create');
  assert.ok(audit && /broader_launch_approved=true/.test(audit.notes) && /owner_authorization=auth-1/.test(audit.notes) && /to_email=0/.test(audit.notes), 'audit records the authorization');
  assert.ok(db.authorization_events.some((e) => e.event === 'executed' && e.executed_by === 'ai-team:amanda' && e.target_id === CID), 'ledger: executed by Amanda');
  assert.strictEqual(marked.filter((m) => m.name === 'owner_authorization_mark_executed').length, 1, 'marked executed once');
  assert.ok(!sb.writes.some((w) => w.table === 'communities' || w.table === 'portal_magic_links'), 'no write to communities or magic links');

  // ---- idempotent: running the same authorization again duplicates nothing -------------------
  const grantsBefore = db.portal_user_properties.length;
  out = await PS.executeAuthorized({ supabase: sb, rpc }, auth());
  assert.ok(out.ok && out.results[0].resumed === true, 'a re-run recognizes the same owners, inboxes and lots');
  assert.strictEqual(out.created, 0, 'no new accounts');
  assert.strictEqual(db.portal_users.length, 2, 'still two accounts');
  assert.strictEqual(db.portal_user_properties.length, grantsBefore, 'no duplicate grants');
  assert.strictEqual(db.portal_magic_links.length + sent.length, 0);
  // An interrupted run resumes: one account missing, the re-run creates only that one.
  const partial = freshDb(); const psb = makeFake(partial);
  await PS.executeAuthorized({ supabase: psb }, auth());
  partial.portal_users.splice(0, 1);
  out = await PS.executeAuthorized({ supabase: psb }, auth());
  assert.ok(out.ok && out.created === 1 && partial.portal_users.length === 2, 'resume creates only what is missing');

  // ---- "approved except" leaves the association out --------------------------------------------
  const ex = freshDb(); const exsb = makeFake(ex);
  out = await PS.executeAuthorized({ supabase: exsb }, auth({ evidence: { excluded_items: [1] } }));
  assert.ok(out.ok && out.results[0].status === 'excluded' && ex.portal_users.length === 0, 'excluded association is not created');
  assert.ok(ex.authorization_events.some((e) => e.event === 'declined'), 'ledger records it as left out');

  // ---- staff exceptions are masked --------------------------------------------------------------
  const exc = PS.sharedEmailExceptions('Sample Ridge', pkg.associations[0].loaded.roster);
  assert.strictEqual(exc.length, 2);
  assert.ok(exc.every((r) => r.masked_email === 's***@example.com' && r.group_size === 2 && r.shared_inbox_group === 1 && !JSON.stringify(r).includes('shared@')), 'masked, grouped');
  assert.ok(!/—/.test(PS.renderCompletion(auth(), { created: 2, results: [{ name: 'Sample Ridge', ok: true, status: 'done', accounts_created: 2 }] }).text));

  console.log('test_portal_silent_create_authorization: ok');
})().catch((e) => { console.error(e); process.exit(1); });
