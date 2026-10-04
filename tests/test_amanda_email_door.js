// tests/test_amanda_email_door.js  (Issue #29 Phase 2B) — the amanda@ staff email door
// into the shared Amanda request contract. Fake DB (writes only to objectives /
// objective_events), a counting model for the contract, and a counting stand-in
// for the legacy staff-assist client so a duplicate model call would be caught.
// Nothing is sent: the door only returns a draft.
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

check('CONTINUITY: an in-app Canyon Gate objective is REUSED when the same matter arrives by amanda@, and the email shows on its timeline', async () => {
  legacyCalls = 0;
  const d = db();
  const app = await handleRequest({ channel: 'app', actor: { email: 'ed@bedrocktx.com', name: 'Ed' }, text: 'Get Canyon Gate ready for Monday.' }, { supabase: d, anthropic: model(WORK) });
  assert.strictEqual(app.objective.created, true);
  const m = model(WORK);
  const r = await draftAmandaStaffAssist({ email: staffEmail('Hi Amanda,\n\nCan you get Canyon Gate ready for Monday?\n\nThanks,\nCelina\n\nFrom: Ed\nSent: Friday\nolder thread text'), contract: { supabase: d, communityId: null, anthropic: m } });
  assert.strictEqual(r.draftable, true); assert.strictEqual(r.assist_type, 'amanda_request:work');
  assert.strictEqual(r.amanda_request.objective.id, app.objective.id, 'same objective as the app request');
  assert.strictEqual(r.amanda_request.objective.created, false);
  assert.strictEqual(d.T.objectives.length, 1, 'no second objective');
  const ev = d.T.objective_events.map((e) => [e.kind, e.actor, e.summary.split(':')[0]]);
  assert.deepStrictEqual(ev, [
    ['opened', 'amanda', 'REVIEW'], ['message_in', 'ed@bedrocktx.com', 'app request'], ['message_out', 'amanda', 'Proposed'],
    ['message_in', 'celina@bedrocktx.com', 'email request'], ['message_out', 'amanda', 'Proposed']]);
  assert.match(d.T.objective_events[3].summary, /^email request: Can you get Canyon Gate ready for Monday\?$/, 'the request text, not the quoted thread or signature');
  assert.strictEqual(m.calls, 1, 'one model call for the email'); assert.strictEqual(legacyCalls, 0, 'no duplicate staff-assist call');
  assert.match(r.body, /^Hi Celina,\n\nThe next step is routing/); assert.match(r.body, /This is on the existing work item: "Canyon Gate Monday readiness"/);
  assert.match(r.body, /What I would do next:\n1\. Route Gexa Energy/); assert.ok(!/\n\nAmanda$/.test(r.body), 'no bare sign-off: every send path adds the real signature via buildAmandaEmail (Issue #29)');
  assert.match(r.review_hint, /amanda request \(work\) · existing work: .* · AI calls: 1/);
  assert.match(m.prompts[0], /by email to amanda@/); assert.match(m.prompts[0], /THEIR EMAIL \(context only/);
});

check('EMAIL QUESTION (exact status): answered from the feed, no objective, 0 model calls, no staff-assist call', async () => {
  legacyCalls = 0;
  const d = db(); const m = model(WORK);
  const r = await draftAmandaStaffAssist({ email: staffEmail('Hi Amanda,\nWhat still needs me today?\nThanks'), contract: { supabase: d, anthropic: m } });
  assert.strictEqual(r.assist_type, 'amanda_request:query'); assert.strictEqual(r.amanda_request.durable, false); assert.strictEqual(r.amanda_request.model_calls, 0);
  assert.strictEqual(m.calls, 0); assert.strictEqual(legacyCalls, 0); assert.strictEqual(d.writes.length, 0, 'a question creates nothing');
  assert.match(r.body, /Nothing needs a person right now\./); assert.match(r.review_hint, /exact status, no AI/);
});

check('EMAIL DECISION: "please approve the Gexa bill" executes nothing; the draft states the floor; no model, no objective', async () => {
  legacyCalls = 0;
  const d = db(); const m = model(WORK);
  const r = await draftAmandaStaffAssist({ email: staffEmail('Amanda,\nPlease approve the Gexa bill so it goes out today.\n-- \nCelina'), contract: { supabase: d, anthropic: m } });
  assert.strictEqual(r.assist_type, 'amanda_request:decision'); assert.strictEqual(r.amanda_request.model_calls, 0); assert.strictEqual(r.amanda_request.durable, false);
  assert.match(r.body, /I can't approve anything from a conversation\. Bills are approved in Payables by a person: staff approve, Ed releases payment\./);
  assert.strictEqual(m.calls, 0); assert.strictEqual(legacyCalls, 0); assert.strictEqual(d.writes.length, 0);
});

check('LINK HOST: Today and destination links use the operator app host even when TRUSTED_URL / APP_BASE_URL point elsewhere', async () => {
  const saved = { t: process.env.TRUSTED_URL, a: process.env.APP_BASE_URL };
  process.env.TRUSTED_URL = 'https://my.bedrocktxai.com'; process.env.APP_BASE_URL = 'https://my.bedrocktxai.com';
  try {
    const links = (s) => s.match(/https?:\/\/\S+/g) || [];
    const work = await draftAmandaStaffAssist({ email: staffEmail('Hi Amanda,\n\nCan you get Canyon Gate ready for Monday?\n\nThanks,\nCelina'), contract: { supabase: db(), anthropic: model(WORK) } });
    const status = await draftAmandaStaffAssist({ email: staffEmail('Hi Amanda,\nWhat still needs me today?\nThanks'), contract: { supabase: db(), anthropic: model(WORK) } });
    const held = { ap_invoices: [{ id: u(85), community_id: CG, vendor_id: 'vDJ', vendor_invoice_number: '1010', total_cents: 30000, status: 'on_hold', needs_review: true, notes: 'ON HOLD: W-9 required before payment.', created_at: '2026-10-02T00:00:00Z', vendor: { name: 'Sample Vendor' }, communities: { name: 'Canyon Gate at Cinco Ranch' } }] };
    const action = await draftAmandaStaffAssist({ email: staffEmail('Hi Amanda,\nWhat still needs me today?\nThanks'), contract: { supabase: db(held), anthropic: model(WORK) } });
    assert.ok(work.body.includes('https://app.bedrocktxai.com/app/today'), 'work: Today link on the operator host');
    assert.ok(status.body.includes('https://app.bedrocktxai.com/app/today'), 'status: Today link on the operator host');
    assert.ok(/Where to act: https:\/\/app\.bedrocktxai\.com\//.test(action.body), 'Take action destination on the operator host');
    assert.ok(action.body.includes(`https://app.bedrocktxai.com/#tab=ap&invoice=${u(85)}`), 'exact destination path kept');
    for (const l of [...links(work.body), ...links(status.body), ...links(action.body)]) assert.ok(l.startsWith('https://app.bedrocktxai.com/'), `link on wrong host: ${l}`);
  } finally {
    if (saved.t === undefined) delete process.env.TRUSTED_URL; else process.env.TRUSTED_URL = saved.t;
    if (saved.a === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = saved.a;
  }
});

check('REAL SIGNATURE: a corporate signature + confidentiality notice ("unauthorized review") never turns a work request into "review my work"', async () => {
  legacyCalls = 0;
  const footer = '\n\nThanks,\n\n\nSample Staffer\nSample Management, LLC\n100 Main St, Ste 1\nSugar Land, TX 77478\nMain Office: 555-555-0100\n\n\n\n\nConfidentiality Notice: This email and any attachments are intended only for the recipient(s) named above and may contain confidential information. If you are not the intended recipient, please delete this message and notify the sender immediately. Any unauthorized review, use, disclosure, or distribution is prohibited.';
  const d = db(); const m = model(WORK);
  const email = staffEmail('Hi Amanda, can you get canyon gate ready for Monday?' + footer);
  assert.strictEqual(isOperationalRequest(email, requestTextFrom(email)), true, 'footer words do not change the routing');
  const r = await draftAmandaStaffAssist({ email, contract: { supabase: d, anthropic: m } });
  assert.strictEqual(r.assist_type, 'amanda_request:work'); assert.strictEqual(m.calls, 1); assert.strictEqual(legacyCalls, 0);
  assert.match(d.T.objective_events.find((e) => e.kind === 'message_in').summary, /^email request: can you get canyon gate ready for Monday\?$/);
  // A real review ask with the same footer still goes to staff assist.
  const rv = staffEmail('Hi Amanda, can you review my response below before I send it?' + footer);
  assert.strictEqual(isOperationalRequest(rv, requestTextFrom(rv)), false);
});

check('NARROW: writing help, reviews, open advice and attachments keep the existing staff-assist path (one call there, none in the contract)', async () => {
  for (const [body, extra] of [
    ['Hi Amanda, can you draft a reply to the Smiths about their fence? They are upset about the letter.', {}],
    ['Amanda, could you review my response before I send it? I want to be sure the tone is right for this homeowner.', {}],
    ['Amanda, not sure how to handle a homeowner who keeps calling about the pool hours, what should I do here?', {}],
    ['Get Canyon Gate ready for Monday. The proposal is attached, please use it.', { has_attachments: true }],
  ]) {
    legacyCalls = 0; const m = model(WORK); const d = db();
    const r = await draftAmandaStaffAssist({ email: staffEmail(body, extra), contract: { supabase: d, anthropic: m } });
    assert.strictEqual(m.calls, 0, body); assert.strictEqual(legacyCalls, 1, `legacy path for: ${body}`); assert.strictEqual(d.writes.length, 0);
    assert.ok(!/^amanda_request/.test(r.assist_type || ''), body);
  }
});

check('Communications redraft (no contract) is unchanged: always the legacy staff-assist path', async () => {
  legacyCalls = 0;
  const r = await draftAmandaStaffAssist({ email: staffEmail('Get Canyon Gate ready for Monday please, the board meets then and I need it all clean.') });
  assert.strictEqual(legacyCalls, 1); assert.ok(!/^amanda_request/.test(r.assist_type || ''));
  const triage = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_triage.js'), 'utf8');
  assert.ok(!/contract:/.test(triage), 'api/email_triage.js does not opt in');
});

check('actor must be trusted Bedrock staff: a non-staff email never reaches the contract; the contract itself refuses an outside actor on email', async () => {
  legacyCalls = 0; const m = model(WORK); const d = db();
  const r = await draftAmandaStaffAssist({ email: staffEmail('Get Canyon Gate ready for Monday.', { sender_email: 'someone@gmail.com' }), contract: { supabase: d, anthropic: m } });
  assert.strictEqual(m.calls, 0); assert.strictEqual(d.writes.length, 0); assert.ok(!/^amanda_request/.test(r.assist_type || ''));
  const direct = await handleRequest({ channel: 'email', actor: { email: 'someone@gmail.com' }, text: 'Get Canyon Gate ready for Monday.' }, { supabase: d, anthropic: m });
  assert.strictEqual(direct.ok, false); assert.strictEqual(direct.error, 'actor_not_staff'); assert.strictEqual(m.calls, 0);
});

check('a contract failure becomes an honest careful draft, never a fall-through to another drafter (no second model call)', async () => {
  legacyCalls = 0;
  const d = db();
  const r = await draftAmandaStaffAssist({ email: staffEmail('Get Canyon Gate ready for Monday.'), contract: { supabase: d, anthropic: { messages: { create: async () => { throw new Error('overloaded'); } } } } });
  assert.strictEqual(r.draftable, true); assert.strictEqual(r.careful, true); assert.match(r.review_hint, /not completed: model_failed/);
  assert.strictEqual(legacyCalls, 0); assert.strictEqual(d.T.objectives.length, 0);
});

check('request text extraction: greeting, signature and quoted thread are dropped; subject is the fallback', () => {
  assert.strictEqual(requestTextFrom({ body_full: 'Hi Amanda,\n\nCan you get Canyon Gate ready for Monday?\n\nThanks,\nCelina\n\nFrom: Ed <ed@x>\nolder' }), 'Can you get Canyon Gate ready for Monday?');
  assert.strictEqual(requestTextFrom({ body_full: 'Good morning Amanda!\nWhat still needs me today?\nBest regards\nPat' }), 'What still needs me today?');
  assert.strictEqual(requestTextFrom({ subject: 'RE: Fwd: Get Canyon Gate ready for Monday', body_full: 'Thanks' }), 'Get Canyon Gate ready for Monday');
  assert.strictEqual(isOperationalRequest({ has_attachments: false, body_full: 'x' }, 'Approve this bill'), true);
  assert.strictEqual(isOperationalRequest({ has_attachments: true, body_full: 'x' }, 'Get Canyon Gate ready for Monday.'), false);
});

check('no send, no new store, no background work in the email door', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_staff_assist.js'), 'utf8');
  assert.ok(!/sendAs|sendReplyAs|sendEmail|\.from\('(?!objectives)[a-z_]+'\)\.(insert|update|upsert)/.test(src), 'the door never sends or writes outside the contract');
  assert.ok(!/setInterval|setTimeout|scheduler/.test(src));
  const ingest = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8').split(String.fromCharCode(13)).join('');
  const i = ingest.indexOf('contract: { supabase, communityId: res.community_id || null }');
  assert.ok(i > 0, 'inbound amanda@ path opts in');
  assert.ok(/status: 'pending'/.test(ingest.slice(i, i + 600)), 'the result is still a pending draft for review');
  assert.ok(!/lib\/amanda/.test(fs.readFileSync(path.join(__dirname, '..', 'api', 'board_portal.js'), 'utf8')));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) { fail += 1; console.log(`  ✗ ${n}\n    ${String(e.stack).split('\n').slice(0, 4).join('\n    ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
