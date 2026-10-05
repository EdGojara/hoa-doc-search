// tests/test_amanda_status_intent.js  (Issue #29, 2026-10-05) — community-scoped status questions:
// Ed's exact email and natural variants are recognized by a grammar (not a phrase list) with
// greetings, pleasantries, signatures and quoted history ignored; answered from the live feed for
// the named community with 0 model calls and no objective. Harness shared with the email door test.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Legacy staff-assist builds its own client from lib/ai/anthropic: replace it with a counter.
let legacyCalls = 0;
const anthPath = require.resolve('../lib/ai/anthropic');
require.cache[anthPath] = { id: anthPath, filename: anthPath, loaded: true, exports: class { constructor() { this.messages = { create: async () => { legacyCalls += 1; return { content: [{ type: 'text', text: JSON.stringify({ assist_type: 'advice', body: 'Legacy staff-assist reply.', needs_from_them: [], held_for_human: [] }) }] }; } }; } } };
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { draftAmandaStaffAssist, requestTextFrom, isOperationalRequest } = require('../lib/community/amanda_staff_assist');
const { handleRequest } = require('../lib/amanda/request');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CG = u(901);
const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];

function db(seed = {}) {
  const T = { communities: [{ id: CG, name: 'Canyon Gate at Cinco Ranch', management_status: 'active', financials_active: true, arc_active: true, is_demo: false }], objectives: [], objective_events: [], ...JSON.parse(JSON.stringify(seed)) };
  const writes = []; let seq = 0; const WRITABLE = new Set(['objectives', 'objective_events']);
  function from(t) {
    const f = []; let order = null; let lim = null; let mode = 'select'; let payload = null; let single = false;
    const q = {
      select() { return q; }, eq(c, v) { f.push((r) => r[c] === v); return q; }, in(c, v) { f.push((r) => v.includes(r[c])); return q; },
      gte(c, v) { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; }, lte(c, v) { f.push((r) => r[c] != null && String(r[c]) <= String(v)); return q; },
      lt(c, v) { f.push((r) => r[c] != null && String(r[c]) < String(v)); return q; }, not() { return q; },
      or(expr) { const parts = expr.split(',').map((p) => p.split('.')); f.push((r) => parts.some(([c, op, v]) => (op === 'eq' ? r[c] === v : op === 'is' ? r[c] == null : false))); return q; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return q; }, limit(n) { lim = n; return q; },
      insert(p) { if (!WRITABLE.has(t)) throw new Error(`write attempted on ${t}`); mode = 'insert'; payload = p; return q; },
      update(p) { if (!WRITABLE.has(t)) throw new Error(`write attempted on ${t}`); mode = 'update'; payload = p; return q; },
      upsert() { throw new Error(`write attempted on ${t}`); }, delete() { throw new Error(`write attempted on ${t}`); },
      single() { single = true; return q; }, then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    function exec() {
      const rows = T[t] || (T[t] = []);
      if (mode === 'insert') {
        const row = { id: u(500 + (++seq)), created_at: new Date().toISOString(), ...payload };
        if (t === 'objectives' && row.subject_key && rows.some((r) => r.subject_key === row.subject_key && OPEN.includes(r.status))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        rows.push(row); writes.push({ t, op: 'insert', row }); return { data: single ? row : [row], error: null };
      }
      let out = rows.filter((r) => f.every((p) => p(r)));
      if (mode === 'update') { for (const r of out) { Object.assign(r, payload); writes.push({ t, op: 'update' }); } return { data: out, error: null }; }
      if (order) { const [c, asc] = order; out = [...out].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : 1) * (asc ? 1 : -1)); }
      if (lim != null) out = out.slice(0, lim);
      return { data: single ? out[0] || null : out.map((r) => ({ ...r })), error: null };
    }
    return q;
  }
  return { from, T, writes };
}
function model(reply) {
  const m = { calls: 0, prompts: [], messages: { create: async (a) => { m.calls += 1; m.prompts.push(a.messages[0].content); return { content: [{ type: 'text', text: JSON.stringify(reply) }] }; } } };
  return m;
}
const WORK = { intent: 'work', reply: 'The next step is routing the two past-due bills to Emma for approval.', plan: ['Route Gexa Energy to Emma for approval', 'Confirm the Winstead bill community'], specialists: ['emma'], next_dependency: 'Corrected Texas Access Works invoice', title: 'Canyon Gate Monday readiness', domain: 'ap' };
const staffEmail = (body, o = {}) => ({ subject: 'Canyon Gate', body_full: body, sender_email: 'Celina@bedrocktx.com', sender_name: 'Celina Ortiz', has_attachments: false, mailbox: 'amanda@bedrocktx.com', graph_id: 'g1', ...o });

// ===== Issue #29 (2026-10-05): community-scoped status questions =====
const { statusQuestion, isStatusQuery } = require('../lib/amanda/request');
const ED_EMAIL_BODY = 'Good morning Amanda,\n\nHope you got some rest last night.\n\nWhat do I have to do for Canyon Gate today?\n\nThanks,\n\n\nEd Gojara\nBedrock Association Management, LLC\n100 Main St, Ste 1\nSugar Land, TX 77478\nMain Office: 555-555-0100\n\n\n\n\nConfidentiality Notice: This email and any attachments are intended only for the recipient(s) named above and may contain confidential information. If you are not the intended recipient, please delete this message and notify the sender immediately. Any unauthorized review, use, disclosure, or distribution is prohibited.\n\nFrom: Amanda Albright <amandaalbright@bedrocktx.com>\nSent: Sunday, October 4, 2026 7:41 PM\nSubject: RE: Canyon Gate\n\nHi Ed, Canyon Gate has four items needing attention before Monday...';
const edEmail = (body = ED_EMAIL_BODY) => ({ subject: 'Canyon Gate', body_full: body, sender_email: 'egojara@bedrocktx.com', sender_name: 'Ed Gojara', has_attachments: false, mailbox: 'amandaalbright@bedrocktx.com', graph_id: 'g-ed' });
const VARIANTS = [
  'What do I have to do for Canyon Gate today?',
  "What's left for Canyon Gate today?",
  'Anything I need to handle for Canyon Gate?',
  'What needs my attention at Canyon Gate?',
  'How are we looking on Canyon Gate today?',
  'Is there anything I should look at for Canyon Gate today?',
  'Where do things stand for Canyon Gate?',
  'What is outstanding at Canyon Gate this morning?',
  "What's on my plate for Canyon Gate?",
];

check("ED'S EXACT EMAIL: greeting, pleasantry, signature, confidentiality notice and quoted history do not affect intent; it is a Canyon Gate status question", () => {
  const text = requestTextFrom(edEmail());
  const q = statusQuestion(text);
  assert.ok(q, `not recognized: ${JSON.stringify(text)}`);
  assert.strictEqual(q.place, 'Canyon Gate'); assert.strictEqual(q.sentence, 'What do I have to do for Canyon Gate today?');
  assert.strictEqual(isOperationalRequest(edEmail(), text), true, 'routes to the shared request contract, not the old drafter');
});

check('NATURAL VARIANTS (with and without greetings / pleasantries / thanks) are status questions; the same grammar, no phrase list', () => {
  for (const v of VARIANTS) {
    for (const t of [v, `Good morning Amanda, ${v}`, `Hi Amanda! Hope your weekend was good. ${v} Thanks!`, `Amanda, ${v}`]) {
      const q = statusQuestion(t); assert.ok(q, `not recognized: ${t}`); assert.strictEqual(q.place, 'Canyon Gate', t);
    }
  }
  for (const t of ['Amanda, what still needs me today?', 'what needs me', 'What is on my plate today?', 'Give me a status update', 'How are we looking today?']) assert.ok(isStatusQuery(t), t);
});

check('NOT status: explanations, actions, a second instruction, a record (not a community) as the place, small talk alone', () => {
  for (const t of ['Why is the Texas Access Works bill on hold?', 'What still needs me to approve the Gexa bill and why is it late?', 'Summarize Canyon Gate',
    "What's left to pay on the Gexa bill?", 'Get Canyon Gate ready for Monday.', "What's left for Canyon Gate today? Also pay the Gexa bill.",
    'How are you doing today?', 'Hope you had a good weekend!', 'Please approve the Gexa bill', 'Can you review my response below?']) {
    assert.ok(!isStatusQuery(t), `wrongly status: ${t}`);
  }
});

check('CONTRACT: each variant is answered from the live feed scoped to Canyon Gate with 0 model calls and no objective; a non-community place takes the model path', async () => {
  for (const v of [requestTextFrom(edEmail()), ...VARIANTS]) {
    const d = db(); const m = model(WORK);
    const r = await handleRequest({ channel: 'email', actor: { email: 'egojara@bedrocktx.com', name: 'Ed' }, text: v }, { supabase: d, anthropic: m });
    assert.strictEqual(r.intent, 'query', v); assert.strictEqual(r.deterministic, 'status', v);
    assert.strictEqual(r.model_calls, 0, v); assert.strictEqual(m.calls, 0, v);
    assert.strictEqual(r.durable, false); assert.strictEqual(r.objective, null); assert.strictEqual(d.writes.length, 0, 'creates nothing');
    assert.strictEqual(r.community && r.community.name, 'Canyon Gate at Cinco Ranch', v);
    assert.match(r.reply, /at Canyon Gate at Cinco Ranch/);
  }
  const m = model({ intent: 'query', reply: 'The Gexa bill has one open item.' });
  const r = await handleRequest({ channel: 'email', actor: { email: 'egojara@bedrocktx.com', name: 'Ed' }, text: "What's left for the Gexa bill today?" }, { supabase: db(), anthropic: m });
  assert.notStrictEqual(r.deterministic, 'status'); assert.strictEqual(m.calls, 1, 'a record is not a community: the model answers (and it is not auto-sendable)');
});

check("EMAIL DOOR: Ed's exact email (full body) -> shared contract, exact status, 0 model calls, no old-drafter call, nothing created", async () => {
  legacyCalls = 0; const d = db(); const m = model(WORK);
  const r = await draftAmandaStaffAssist({ email: edEmail(), contract: { supabase: d, anthropic: m } });
  assert.strictEqual(r.assist_type, 'amanda_request:query');
  assert.strictEqual(r.amanda_request.deterministic, 'status', 'the gate sees an exact-status answer (auto-send eligible)');
  assert.strictEqual(r.amanda_request.model_calls, 0); assert.strictEqual(m.calls, 0); assert.strictEqual(legacyCalls, 0);
  assert.strictEqual(d.writes.length, 0);
  assert.match(r.body, /^Hi Ed,\n\n/); assert.match(r.body, /Canyon Gate at Cinco Ranch/);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

