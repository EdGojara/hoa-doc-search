// tests/test_shared_lookups.js  (Ed 2026-11-27)
// The shared records lookups enforce access in CODE by principal, and Amanda's conversational
// assignments are carried out by existing runners (drafts only), with completion reconciled.
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';

const P = require('../lib/lookups/principal');
const L = require('../lib/lookups');
const D = require('../lib/amanda/dispatch');
const C = require('../lib/amanda/conversation');
const { OWNER_EMAIL } = require('../lib/auth/owner_email');

let passed = 0; let failed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

// Minimal chainable Supabase fake: every awaited query resolves via handler(table, ops).
function fakeSb(handler) {
  const log = [];
  const from = (table) => {
    const ops = []; const b = {};
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'ilike', 'or', 'gte', 'lte', 'lt', 'range', 'neq']) b[m] = (...a) => { ops.push([m, ...a]); return b; };
    b.insert = (row) => { ops.push(['insert', row]); return b; };
    b.update = (row) => { ops.push(['update', row]); return b; };
    b.single = () => { ops.push(['single']); return b; };
    b.maybeSingle = () => { ops.push(['maybeSingle']); return b; };
    b.then = (res, rej) => { log.push({ table, ops }); return Promise.resolve(handler(table, ops)).then(res, rej); };
    return b;
  };
  return { from, log };
}

const owner = P.ownerPrincipal({ user: { id: 'u-owner' }, full_name: 'Owner' });
const CID_A = '11111111-1111-4111-8111-111111111111';
const CID_B = '22222222-2222-4222-8222-222222222222';
const PROP_B = '33333333-3333-4333-8333-333333333333';
const board = P.boardPrincipal({ kind: 'board', communityIds: [CID_A] });
const homeowner = P.homeownerPrincipal({ portalUserId: 'p1', communityId: CID_A, propertyIds: ['44444444-4444-4444-8444-444444444444'] });

check('principals: owner holds every capability; board has no individual homeowner records; homeowner is scoped', () => {
  for (const c of Object.keys(P.CAPABILITIES)) assert.ok(owner.capabilities.has(c), c);
  for (const c of ['homeowner_search', 'homeowner_record', 'homeowner_ledger', 'collections']) assert.ok(!board.capabilities.has(c), `board must not have ${c}`);
  assert.ok(!homeowner.capabilities.has('homeowner_search') && !homeowner.capabilities.has('collections') && !homeowner.capabilities.has('association_ar'));
  assert.ok(!homeowner.capabilities.has('homeowner_ledger'), 'ledger only when the community allows homeowner financials');
  assert.ok(P.canCommunity(owner, CID_B) && !P.canCommunity(board, CID_B) && P.canCommunity(board, CID_A));
  assert.ok(!P.canProperty(homeowner, { property_id: PROP_B, community_id: CID_A }), 'a homeowner cannot reach another lot');
  assert.throws(() => P.ownerPrincipal(null), /no authenticated owner/);
  assert.throws(() => P.boardPrincipal({ kind: 'staff' }), /no authenticated board member/);
  assert.ok(Object.isFrozen(owner) && Object.isFrozen(owner.capabilities), 'a principal cannot be widened after issue');
});

check('tool lists come from the principal: a board or homeowner never even sees the homeowner tools', () => {
  const names = (p) => L.toolsFor(p).map((t) => t.name);
  assert.deepStrictEqual(names(owner).sort(), L.TOOLS.map((t) => t.name).sort());
  for (const n of ['find_homeowner', 'homeowner_record', 'homeowner_transactions']) assert.ok(!names(board).includes(n), n);
  assert.ok(!names(homeowner).includes('find_homeowner') && !names(homeowner).includes('association_receivables'));
});

check('refusals: no principal, a missing capability, or another association return forbidden and read nothing', async () => {
  const sb = fakeSb(() => ({ data: [{ id: CID_A, name: 'Alpha Estates' }, { id: CID_B, name: 'Beta Lakes' }], error: null }));
  L._setClientForTests(sb);
  try {
    for (const [p, tool] of [[null, 'homeowner_record'], [board, 'homeowner_record'], [board, 'find_homeowner'], [homeowner, 'association_receivables'], [{ kind: 'owner' }, 'homeowner_record']]) {
      const before = sb.log.length;
      const r = await L.runLookup(tool, p, { contact_id: '55555555-5555-4555-8555-555555555555', query: 'smith', community: 'Alpha' });
      assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'forbidden', `${p && p.kind} ${tool}`);
      assert.strictEqual(sb.log.length, before, `${tool}: no query ran before the refusal`);
    }
    // board scoped to Alpha: Beta is invisible, not just refused
    const other = await L.runLookup('association_receivables', board, { community: 'Beta Lakes' });
    assert.strictEqual(other.ok, false); assert.strictEqual(other.error, 'community_not_found_or_outside_access');
    assert.ok(!(other.options || []).includes('Beta Lakes'), 'out-of-scope names are not listed');
    assert.strictEqual((await L.runLookup('drop_tables', owner, {})).error, 'unknown_lookup');
  } finally { L._setClientForTests(null); }
});

check('homeowner record: the property scope is checked BEFORE the record is assembled', async () => {
  const H = require('../api/homeowner_360');
  const realOwned = H.ownedProperties; const realAssemble = H.assemble; let assembled = false;
  H.ownedProperties = async () => [{ property_id: PROP_B, community_id: CID_B, address: '1 Main' }];
  H.assemble = async () => { assembled = true; return {}; };
  try {
    const r = await L.runLookup('homeowner_record', homeowner, { contact_id: '55555555-5555-4555-8555-555555555555' });
    assert.strictEqual(r.error, 'forbidden');
    assert.strictEqual(assembled, false, 'nothing about another lot is assembled');
  } finally { H.ownedProperties = realOwned; H.assemble = realAssemble; }
});

check('Talk to Amanda issues the owner principal only for the owner, and records tools refuse without it', async () => {
  assert.ok(C.principalFor({ user_id: 'u', email: OWNER_EMAIL }));
  assert.strictEqual(C.principalFor({ user_id: 'u', email: 'staff@bedrocktx.com' }), null);
  assert.strictEqual(C.principalFor({ user_id: null, email: OWNER_EMAIL }), null);
  assert.strictEqual(C.principalFor(null), null);
  const r = await L.runLookup('homeowner_record', C.principalFor({ user_id: 'u', email: 'board@example.com' }), { contact_id: '55555555-5555-4555-8555-555555555555' });
  assert.strictEqual(r.error, 'forbidden');
});

check('dispatch lanes: email and vendor requests go to existing runners; anything else is assigned honestly', () => {
  assert.strictEqual(D.laneFor('Email Martha and Alisha about the pool hours'), 'email');
  assert.strictEqual(D.laneFor('let the board know the audit is done'), 'email');
  assert.strictEqual(D.laneFor('get a plumber out to fix the leak at the clubhouse', { community: { id: CID_A, name: 'Alpha' } }), 'vendor');
  assert.strictEqual(D.laneFor('get a plumber out to fix the leak'), 'none', 'vendor lane needs a known community');
  assert.strictEqual(D.laneFor('figure out why reserves look low'), 'none');
});

check('dispatch: a staged email draft is recorded on the objective and set to waiting for review; nothing sent', async () => {
  const sb = fakeSb((t, ops) => (ops.find((o) => o[0] === 'maybeSingle') ? { data: { subject_refs: { kind: 'x' } }, error: null } : { data: null, error: null }));
  const r = await D.dispatchObjective(sb, { objective: { id: 'o1' }, text: 'Email Martha about the gate', actor: { email: OWNER_EMAIL, name: 'Ed' } },
    { stageEmailRequest: async () => ({ ok: true, staged: true, to: [{ name: 'Martha', email: 'm@example.com' }], draft: { id: 'd1', subject: 'Gate' } }) });
  assert.strictEqual(r.status, 'draft_staged'); assert.strictEqual(r.draft_id, 'd1');
  assert.ok(/Nothing has been sent/.test(r.summary));
  const ev = sb.log.find((l) => l.table === 'objective_events'); assert.ok(ev, 'history entry written');
  assert.ok(['opened', 'message_in', 'message_out', 'note', 'status_change', 'next_action', 'escalated', 'reattached', 'closed'].includes(ev.ops[0][1].kind), 'event kind is allowed by the CHECK constraint');
  const upd = sb.log.filter((l) => l.table === 'objectives' && l.ops.some((o) => o[0] === 'update')).map((l) => l.ops.find((o) => o[0] === 'update')[1]);
  assert.ok(upd.some((u) => u.status === 'waiting_human'));
  assert.ok(upd.some((u) => u.subject_refs && u.subject_refs.dispatch && u.subject_refs.dispatch.draft_id === 'd1' && u.subject_refs.kind === 'x'), 'existing refs kept, draft linked');
  // questions instead of a guess
  const q = await D.dispatchObjective(fakeSb(() => ({ data: null, error: null })), { objective: { id: 'o2' }, text: 'email Pat about it', actor: { email: OWNER_EMAIL } },
    { stageEmailRequest: async () => ({ ok: true, staged: false, questions: ['Which Pat?'], reply: 'Amanda needs a little more.' }) });
  assert.strictEqual(q.status, 'needs_answer'); assert.ok(/Which Pat/.test(q.summary));
});

check('dispatch: vendor drafts go through operator_actions in execute mode, which only queues a review draft', async () => {
  let called = null;
  const r = await D.dispatchObjective(fakeSb((t, ops) => (ops.find((o) => o[0] === 'maybeSingle') ? { data: { subject_refs: null }, error: null } : { data: null, error: null })),
    { objective: { id: 'o3' }, text: 'get a plumber to fix the leak', actor: { email: OWNER_EMAIL }, community: { id: CID_A, name: 'Alpha' } },
    { runAction: async (action, args, ctx, opts) => { called = { action: action.name, risk: action.risk, opts }; return { status: 'done', result: { status: 'queued', draft_id: 'd9', vendor: 'Pipe Co', category: 'plumbing', source: 'payment_history' } }; } });
  assert.strictEqual(called.action, 'draft_vendor_outreach'); assert.strictEqual(called.risk, 'safe');
  assert.strictEqual(r.status, 'draft_staged'); assert.ok(/nothing has been sent/i.test(r.summary));
});

check('completion: a sent draft resolves its objective; a discarded one reopens it', async () => {
  const objs = [{ id: 'oa', title: 'Gate email', subject_refs: { dispatch: { draft_id: 'da' } } }, { id: 'ob', title: 'Plumber', subject_refs: { dispatch: { draft_id: 'db' } } }];
  const sb = fakeSb((t, ops) => {
    if (t === 'objectives' && ops[0][0] === 'select') return { data: objs, error: null };
    if (t === 'outbound_email_drafts') return { data: [{ id: 'da', status: 'sent', sent_at: '2026-11-27T10:00:00Z' }, { id: 'db', status: 'discarded' }], error: null };
    if (ops.some((o) => o[0] === 'single')) return { data: { id: 'oa' }, error: null };
    return { data: null, error: null };
  });
  const r = await D.reconcile(sb);
  assert.deepStrictEqual(r.resolved, ['Gate email']); assert.deepStrictEqual(r.reopened, ['Plumber']);
  const updates = sb.log.filter((l) => l.table === 'objectives' && l.ops.some((o) => o[0] === 'update')).map((l) => l.ops.find((o) => o[0] === 'update')[1]);
  assert.ok(updates.some((u) => u.status === 'resolved') && updates.some((u) => u.status === 'open'));
});

check('wiring: dispatch runs only for the owner on voice/app; lookups are dispatched through runLookup', () => {
  const fs = require('fs');
  const req = fs.readFileSync(require.resolve('../lib/amanda/request.js'), 'utf8');
  assert.ok(/obj\.created && isOwnerActor\(actor\) && \(channel === 'voice' \|\| channel === 'app'\)/.test(req));
  const conv = fs.readFileSync(require.resolve('../lib/amanda/conversation.js'), 'utf8');
  assert.ok(/Lookups\.runLookup\(u\.name, ctx\.principal/.test(conv), 'conversation runs lookups with the session principal');
  assert.ok(/governing_documents: 24000/.test(conv), 'a governing-documents result is never cut below the retriever limit');
  const disp = fs.readFileSync(require.resolve('../lib/amanda/dispatch.js'), 'utf8');
  assert.ok(!/sendMail|graph_send\.send|\.send\(/.test(disp), 'the dispatcher never sends');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
