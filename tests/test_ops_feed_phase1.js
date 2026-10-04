// tests/test_ops_feed_phase1.js  (Issue #29 Phase 1) — read-only Operations Feed
// In-memory read-only fake (any write throws). No network, no model, no action.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildFeed, buildItem, summarize } = require('../lib/feed/build');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const NOW = Date.parse('2026-10-05T15:00:00Z');
const C1 = '11111111-1111-4111-8111-111111111111'; const C2 = '22222222-2222-4222-8222-222222222222';
const iso = (h) => new Date(NOW - h * 3600000).toISOString();

function readOnlyDb(seed = {}, { fail = [] } = {}) {
  const T = JSON.parse(JSON.stringify(seed));
  const calls = [];
  function from(t) {
    const f = []; let order = null; let lim = null;
    const deny = () => { throw new Error(`write attempted on ${t}`); };
    const q = {
      select() { return q; },
      eq(c, v) { f.push((r) => r[c] === v); return q; },
      in(c, v) { f.push((r) => v.includes(r[c])); return q; },
      gte(c, v) { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; },
      lte(c, v) { f.push((r) => r[c] != null && String(r[c]) <= String(v)); return q; },
      or(expr) { const parts = expr.split(',').map((p) => p.split('.')); f.push((r) => parts.some(([c, op, v]) => (op === 'eq' ? r[c] === v : op === 'is' && v === 'null' ? r[c] == null : false))); return q; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return q; },
      limit(n) { lim = n; return q; },
      insert: deny, update: deny, upsert: deny, delete: deny,
      then(res, rej) {
        calls.push(t);
        if (fail.includes(t)) return Promise.resolve({ data: null, error: { message: `relation "${t}" unavailable` } }).then(res, rej);
        let out = (T[t] || []).filter((r) => f.every((p) => p(r)));
        if (order) { const [c, asc] = order; out = [...out].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1)); }
        if (lim != null) out = out.slice(0, lim);
        return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null }).then(res, rej);
      },
    };
    return q;
  }
  return { from, T, calls };
}

const comm = (id, name) => ({ communities: { name } });
const world = () => ({
  objectives: [
    { id: 'o1', title: 'Check coding: bill A-1 ($125.00)', status: 'open', autonomy_class: 'REVIEW', priority: 'normal', next_action: 'A person checks the coding.', domain: 'ap', subject_key: 'ap_invoice:i1', accountable_persona: 'amanda', community_id: C1, last_activity_at: iso(30), opened_at: iso(30), ...comm(C1, 'Alpha') },
    { id: 'o2', title: 'Bill waiting on the community', status: 'open', autonomy_class: 'BLOCK', priority: 'normal', blocked_reason: 'Payables needs to supply the community.', domain: 'ap', subject_key: 'ap_exception:e9', accountable_persona: 'amanda', community_id: null, last_activity_at: iso(50), opened_at: iso(50) },
    { id: 'o3', title: 'Legacy email objective, quiet', status: 'open', domain: null, subject_key: null, accountable_persona: null, community_id: C1, last_activity_at: iso(10), opened_at: iso(10) },
    { id: 'o4', title: 'Homeowner follow-up waiting on staff', status: 'waiting_human', domain: null, subject_key: null, accountable_persona: null, community_id: C1, last_activity_at: iso(5), opened_at: iso(5), ...comm(C1, 'Alpha') },
    { id: 'o5', title: 'Resolved thing', status: 'resolved', domain: 'ap', subject_key: 'ap_invoice:i7', accountable_persona: 'amanda', closed_at: iso(3), closed_reason: 'bill is voided', community_id: C1, ...comm(C1, 'Alpha') },
  ],
  objective_events: [
    { objective_id: 'o1', at: iso(30), actor: 'amanda', kind: 'opened', summary: 'REVIEW: Check coding: bill A-1 ($125.00)' },
  ],
  manager_wakes: [
    { status: 'consumed', outcome: 'execute_candidate', consumed_at: iso(2), community_id: C1 },
    { status: 'consumed', outcome: 'execute_candidate', consumed_at: iso(4), community_id: C1 },
    { status: 'consumed', outcome: 'review', consumed_at: iso(4), community_id: C1 },
  ],
  ap_intake_exceptions: [
    { id: 'e9', status: 'pending', reason: 'no_community', vendor_name: 'Lake Pro', invoice_number: '262093', total_cents: 118522, community_id: null, created_at: iso(50) },
    { id: 'e2', status: 'pending', reason: 'unreadable_attachment', vendor_name: 'Zoo Co', invoice_number: null, total_cents: null, community_id: C2, created_at: iso(70), ...comm(C2, 'Beta') },
  ],
  ap_invoices: [
    { id: 'i1', status: 'awaiting_approval', needs_review: true, vendor_invoice_number: 'A-1', total_cents: 12500, community_id: C1, created_at: iso(30), vendor: { name: 'Acme' }, ...comm(C1, 'Alpha') },
    { id: 'i2', status: 'on_hold', needs_review: true, vendor_invoice_number: '7316', total_cents: 147000, community_id: C1, created_at: iso(20), vendor: { name: 'Swim Co' }, ...comm(C1, 'Alpha') },
    { id: 'i3', status: 'awaiting_approval', needs_review: false, vendor_invoice_number: 'OK-1', total_cents: 5000, community_id: C1, created_at: iso(10), vendor: { name: 'Clean Co' } },
  ],
  ap_invoice_approvals: [
    { invoice_id: 'i1', action: 'approved', user_name: 'Celina', notes: null, created_at: iso(1) },
  ],
  acc_decisions: [
    { id: 'a1', status: 'pending_review', community_id: C2, community_name: 'Beta', homeowner_address: '1 Sample Ln', project_summary: 'Patio cover', created_at: iso(24) },
    { id: 'a2', status: 'decided', community_id: C2, community_name: 'Beta', project_summary: 'Fence', created_at: iso(240) },
  ],
  board_packets: [
    { id: 'b1', status: 'draft', community_id: C1, period_label: 'October 2026', meeting_date: '2026-10-07', ...comm(C1, 'Alpha') },
    { id: 'b2', status: 'final', community_id: C1, period_label: 'Old', meeting_date: '2026-10-06' },
    { id: 'b3', status: 'draft', community_id: C1, period_label: 'Far', meeting_date: '2026-12-01' },
  ],
  board_packet_distribution_log: [],
  acc_finalizations: [],
  cron_runs: [
    { id: 'r1', job_name: 'cure_lapse', ok: false, error: 'boom', started_at: iso(6) },
    { id: 'r2', job_name: 'manager_sweep', ok: true, started_at: iso(7) },
  ],
});

check('empty state: nothing needs a person, $0 model, no writes, no actions', async () => {
  const db = readOnlyDb({});
  const f = await buildFeed(db, { now: NOW, env: {} });
  assert.strictEqual(f.total, 0); assert.strictEqual(f.model_calls, 0); assert.deepStrictEqual(f.actions, []);
  assert.strictEqual(f.summary, 'Nothing needs a person right now.');
  assert.deepStrictEqual(f.section_errors, {});
});

check('items come from objectives + domain queues, with deterministic specialist identity and no duplicates', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  const keys = [...f.needs, ...f.more].map((i) => i.key);
  assert.ok(keys.includes('objective:o1') && !keys.includes('ap_invoice:i1'), 'the Amanda objective supersedes the raw invoice row');
  assert.ok(keys.includes('objective:o2') && !keys.includes('ap_exception:e9'), 'and the raw exception row');
  assert.ok(keys.includes('ap_invoice:i2'), 'an on-hold bill with no objective yet still shows');
  assert.ok(!keys.includes('ap_invoice:i3'), 'a clean bill is not "needs a person"');
  assert.ok(keys.includes('ap_exception:e2') && keys.includes('acc_decision:a1') && keys.includes('board_packet:b1') && keys.includes('cron_run:r1'));
  assert.ok(!keys.includes('acc_decision:a2') && !keys.includes('board_packet:b2') && !keys.includes('board_packet:b3'), 'decided ACC, final packet, far meeting are out');
  assert.ok(!keys.includes('objective:o3'), 'quiet legacy objectives stay on their own screen');
  assert.ok(keys.includes('objective:o4'), 'a legacy objective waiting on a human is in');
  const by = Object.fromEntries([...f.needs, ...f.more].map((i) => [i.key, i.specialist.name]));
  assert.strictEqual(by['ap_invoice:i2'], 'Emma'); assert.strictEqual(by['acc_decision:a1'], 'Annie'); assert.strictEqual(by['board_packet:b1'], 'Paige'); assert.strictEqual(by['cron_run:r1'], 'Amanda'); assert.strictEqual(by['objective:o1'], 'Emma');
  assert.strictEqual(new Set(keys).size, keys.length, 'no item appears twice');
});

check('3-5 items up top: highest priority first, then whoever has waited longest; the rest under "more"', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  assert.ok(f.needs.length <= 5 && f.needs.length + f.more.length === f.total);
  const pri = { critical: 0, high: 1, normal: 2, low: 3 };
  const all = [...f.needs, ...f.more];
  for (let i = 1; i < all.length; i += 1) assert.ok(pri[all[i - 1].priority] <= pri[all[i].priority], 'priority order');
  assert.strictEqual(f.needs[0].priority, 'high');
  const normals = all.filter((i) => i.priority === 'normal' && i.kind !== 'board_packet');
  for (let i = 1; i < normals.length; i += 1) assert.ok(String(normals[i - 1].at) <= String(normals[i].at), 'oldest first within a priority');
});

check('deterministic summary + recent handled + routine count; template text, no model', async () => {
  const f = await buildFeed(readOnlyDb(world()), { now: NOW, env: {} });
  assert.match(f.summary, /^In the last 24 hours: 2 routine bills continued on the normal path, 1 item cleared\. \d+ items need a person \(/);
  assert.match(f.summary, /Emma \d/);
  assert.strictEqual(f.routine_24h, 2); assert.strictEqual(f.recent.length, 1); assert.strictEqual(f.recent[0].reason, 'bill is voided');
  assert.strictEqual(f.last_sweep.started_at, iso(7)); assert.strictEqual(f.last_sweep.ok, true);
  assert.strictEqual(summarize({ total: 0, recent: [], routine_24h: 0, by_specialist: {}, capped: [] }), 'Nothing needs a person right now.');
});

check('failure semantics: a source that does not answer is reported, never counted as clear', async () => {
  const f = await buildFeed(readOnlyDb(world(), { fail: ['ap_invoices', 'manager_wakes'] }), { now: NOW, env: {} });
  assert.ok(f.section_errors.ap_invoices && f.section_errors.wakes);
  assert.strictEqual(f.routine_24h, null, 'unknown, not zero');
  assert.ok([...f.needs, ...f.more].some((i) => i.kind === 'acc_decision'), 'the sources that answered still show');
});

check('a capped source is flagged and the summary count says "+" (no silent undercount)', async () => {
  const w = world(); w.ap_intake_exceptions = Array.from({ length: 100 }, (_, n) => ({ id: `x${n}`, status: 'pending', reason: 'no_vendor', vendor_name: 'V', community_id: C1, created_at: iso(100 + n) }));
  const f = await buildFeed(readOnlyDb(w), { now: NOW, env: {} });
  assert.ok(f.capped.includes('ap_exceptions'));
  assert.match(f.summary, /\d+\+ items need a person/);
});

check('community scope: that community plus items whose community is not yet identified', async () => {
  const f = await buildFeed(readOnlyDb(world()), { communityId: C1, now: NOW, env: {} });
  const keys = [...f.needs, ...f.more].map((i) => i.key);
  assert.ok(keys.includes('objective:o2'), 'unknown-community BLOCK stays visible');
  assert.ok(!keys.includes('ap_exception:e2') && !keys.includes('acc_decision:a1'), 'other communities drop out');
});

check('detail drawer: objective timeline merged with the domain history; read-only', async () => {
  const db = readOnlyDb(world());
  const d = await buildItem(db, 'objective:o1');
  assert.strictEqual(d.title, 'Check coding: bill A-1 ($125.00)'); assert.strictEqual(d.specialist.name, 'Emma');
  assert.deepStrictEqual([...new Set(d.timeline.map((t) => t.source))].sort(), ['objective', 'payables']);
  assert.ok(d.timeline.some((t) => /approved/.test(t.text) && t.actor === 'Celina'), 'AP approval history comes from ap_invoice_approvals');
  assert.ok(d.timeline.some((t) => t.source === 'objective'));
  for (let i = 1; i < d.timeline.length; i += 1) assert.ok(String(d.timeline[i - 1].at) <= String(d.timeline[i].at), 'chronological');
  assert.deepStrictEqual(d.actions, []); assert.strictEqual(d.model_calls, 0); assert.deepStrictEqual(d.link, { label: 'Open in Objectives', href: '/admin/objectives' });
  const e = await buildItem(db, 'ap_exception:e2'); assert.match(e.facts[0], /readable copy/); assert.strictEqual(e.link.href, '/#tab=ap');
  const b = await buildItem(db, 'board_packet:b1'); assert.strictEqual(b.specialist.name, 'Paige');
  assert.strictEqual(await buildItem(db, 'acc_decision:nope'), null);
  await assert.rejects(() => buildItem(db, "objective:o1'; drop table"), (x) => x.code === 'BAD_INPUT');
  await assert.rejects(() => buildItem(db, 'payments:1'), (x) => x.code === 'BAD_INPUT', 'only known kinds');
});

check('read-only by construction: feed code has no writes, no model, no mail; the API is GET-only and admin-gated', () => {
  for (const f of ['lib/feed/build.js', 'api/feed.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/\.(insert|update|upsert|delete)\(/.test(src), `${f} writes`);
    assert.ok(!/require\([^)]*(ai\/|anthropic|openai|graph_send|notifications|email)/.test(src), `${f} pulls a model or mail module`);
  }
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'feed.js'), 'utf8');
  assert.ok(!/router\.(post|put|patch|delete)\(/.test(api), 'GET routes only');
  assert.strictEqual((api.match(/requireAdmin\(req, res\)/g) || []).length, 2, 'both routes admin-gated');
  const board = fs.readFileSync(path.join(__dirname, '..', 'api', 'board_portal.js'), 'utf8');
  assert.ok(!/lib\/feed/.test(board), 'board Ask Amanda does not read the staff feed');
});

check('Today renders the feed from the existing card (one surface, no competing card) with failure text', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'today.html'), 'utf8');
  assert.strictEqual((html.match(/id="th-amanda"/g) || []).length, 1);
  assert.ok(/TX\.get\('\/api\/feed' \+ q\)/.test(html) && /\/api\/feed\/item\?key=/.test(html));
  assert.ok(!/\/api\/manager\/shadow/.test(html), 'the old shadow fetch is gone');
  assert.ok(/Unavailable is not the same as clear/.test(html));
  assert.ok(!/<form|method="post"|TX\.post\(/i.test(html.slice(html.indexOf('Operations Feed (Issue #29'), html.indexOf('var feedSeq'))), 'no write controls in the feed');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) { fail += 1; console.log(`  ✗ ${n}\n    ${String(e.stack).split('\n').slice(0, 4).join('\n    ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
