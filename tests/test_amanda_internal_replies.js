// Amanda's standing authority for internal correspondence (lib/amanda/internal_replies).
// Invented data only.
const assert = require('assert');
const IR = require('../lib/amanda/internal_replies');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + ': ' + e.message); } }

const AMANDA = 'amanda-test@bedrocktx.com';
const graphSend = { AMANDA_MAILBOX: AMANDA };
function fakeDb({ users = [], autoReplies = 0 } = {}) {
  const updates = [];
  const q = (table) => {
    const st = { table, filters: [] };
    const api = {
      select(cols, o) { st.head = o && o.head; return api; }, ilike(c, v) { st.filters.push([c, v]); return api; }, eq(c, v) { st.filters.push([c, v]); return api; },
      gte() { return api; }, limit() { return api; },
      single() { return Promise.resolve({ data: { extracted: {} }, error: null }); },
      update(p) { updates.push([table, p]); return { eq: () => Promise.resolve({ error: null }) }; },
      then(res) {
        if (table === 'user_profiles') { const e = (st.filters.find((f) => f[0] === 'email') || [])[1]; return Promise.resolve({ data: users.filter((u) => u.email === e), error: null }).then(res); }
        if (table === 'outbound_email_drafts') return Promise.resolve({ count: autoReplies, error: null }).then(res);
        return Promise.resolve({ data: [], error: null }).then(res);
      },
    };
    return api;
  };
  return { from: q, updates };
}
const inbound = (o = {}) => ({ id: 'm1', mailbox: AMANDA, direction: 'inbound', classification: 'internal', sender_email: 'staffer@bedrocktx.com', sender_name: 'Pat Staffer',
  subject: 'Re: deposits', body_full: 'Please check again; I made some deposits.', conversation_id: 'c1', internet_message_id: '<x@y>', ...o });
const draft = { body: 'Hi Pat, thank you. Could you send the deposit confirmations so Kat can match them?', persona: 'amanda', careful: false };
const STAFF = [{ email: 'staffer@bedrocktx.com', role: 'staff', is_active: true }];
const okCheck = async () => ({ ok: true, needs_reply: true, issues: [] });
function deps(o = {}) {
  const sent = [];
  return { sent, graphSend, aiMailboxes: new Set(['kat-test@bedrocktx.com']), sendCheck: okCheck, autoReply: { execute: async (a) => { sent.push(a); return { status: 'sent' }; } }, ...o };
}

(async () => {
  console.log('amanda internal replies');

  await check('an active staff member gets Amanda\'s reply through the existing receipt machinery, once', async () => {
    const d = deps();
    const r = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft, env: {}, deps: d });
    assert.strictEqual(r.action, 'sent');
    assert.strictEqual(d.sent.length, 1);
    assert.strictEqual(d.sent[0].decision.class, 'EXECUTE');
    assert.strictEqual(d.sent[0].decision.sender_kind, 'staff');
    assert.strictEqual(d.sent[0].draft.body, draft.body);
  });

  await check('not sent: an outside sender, an inactive or unknown staff address, a system sender', async () => {
    for (const [who, users] of [['someone@example.com', STAFF], ['former@bedrocktx.com', [{ email: 'former@bedrocktx.com', role: 'staff', is_active: false }]], ['nobody@bedrocktx.com', []], ['no-reply@bedrocktx.com', STAFF]]) {
      const d = deps();
      const r = await IR.handleInternal({ supabase: fakeDb({ users }), inbound: inbound({ sender_email: who }), draft, env: {}, deps: d });
      assert.strictEqual(r.action, 'review', who); assert.strictEqual(d.sent.length, 0, who);
    }
  });

  await check('restricted topics stay with a person (payments, postings, write-offs, contracts, legal, personnel)', async () => {
    for (const t of ['Please approve the payment to the vendor', 'Can you post the entry today?', 'We should write off the balance', 'Sign the contract with the vendor', 'Is this legal advice?', 'About her salary']) {
      const d = deps();
      const r = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound({ body_full: t }), draft, env: {}, deps: d });
      assert.strictEqual(r.action, 'review', t); assert.ok(r.reasons[0].startsWith('restricted:'), t); assert.strictEqual(d.sent.length, 0);
    }
    assert.deepStrictEqual(IR.restrictedTopics('Thanks, I deposited the checks.'), []);
  });

  await check('the send check decides: unsupported claims or a curt tone stay drafts; no reply needed is handled silently', async () => {
    const d1 = deps({ sendCheck: async () => ({ ok: false, needs_reply: true, issues: ['claims the check was deposited'] }) });
    const r1 = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft, env: {}, deps: d1 });
    assert.deepStrictEqual([r1.action, r1.reasons, d1.sent.length], ['review', ['claims the check was deposited'], 0]);
    const db = fakeDb({ users: STAFF });
    const d2 = deps({ sendCheck: async () => ({ ok: true, needs_reply: false, issues: ['thank-you only'] }) });
    const r2 = await IR.handleInternal({ supabase: db, inbound: inbound({ body_full: 'Thanks!' }), draft, env: {}, deps: d2 });
    assert.strictEqual(r2.action, 'no_reply_needed'); assert.strictEqual(d2.sent.length, 0);
    assert.ok(db.updates.some(([t, p]) => t === 'email_messages' && p.triage_status === 'handled'), 'marked handled, no acknowledgement sent');
  });

  await check('AI teammates: answered, but never an automatic reply and never past the per-conversation loop cap', async () => {
    const d = deps();
    const r = await IR.handleInternal({ supabase: fakeDb(), inbound: inbound({ sender_email: 'kat-test@bedrocktx.com' }), draft, env: {}, deps: d });
    assert.strictEqual(r.action, 'sent'); assert.strictEqual(d.sent[0].decision.sender_kind, 'ai');
    const d2 = deps();
    const r2 = await IR.handleInternal({ supabase: fakeDb({ autoReplies: IR.LOOP_CAP }), inbound: inbound({ sender_email: 'kat-test@bedrocktx.com' }), draft, env: {}, deps: d2 });
    assert.deepStrictEqual([r2.action, r2.reasons, d2.sent.length], ['review', ['ai_loop_guard'], 0]);
    const d3 = deps();
    const r3 = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound({ subject: 'Automatic reply: deposits' }), draft, env: {}, deps: d3 });
    assert.deepStrictEqual([r3.action, d3.sent.length], ['no_reply_needed', 0]);
  });

  await check('careful drafts go to the send check WITH what Amanda held; they send only if the check passes', async () => {
    let seen = null;
    const d = deps({ sendCheck: async (a) => { seen = a.held; return { ok: true, needs_reply: true, issues: [] }; } });
    const r = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft: { ...draft, careful: true, review_hint: 'staff assist: 1 held for a human' }, env: {}, deps: d });
    assert.deepStrictEqual([r.action, seen], ['sent', 'staff assist: 1 held for a human']);
    const d2 = deps({ sendCheck: async () => ({ ok: false, needs_reply: true, supported: true, no_commitments: false, courteous: true, issues: ['decides the held part'] }) });
    const r2 = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft: { ...draft, careful: true }, env: {}, deps: d2 });
    assert.deepStrictEqual([r2.action, d2.sent.length], ['review', 0]);
    assert.match(IR.checkPrompt({ inbound: inbound(), thread: 't', draft: 'd', held: 'X' }), /must leave that part to a person/);
  });

  await check('scope: only internal mail delivered to Amanda; the off switch and an empty draft never send', async () => {
    for (const [o, env, dr] of [[{ classification: 'homeowner_request' }, {}, draft], [{ mailbox: 'claire-test@bedrocktx.com' }, {}, draft], [{}, { AMANDA_INTERNAL_REPLIES: 'off' }, draft], [{}, {}, { body: '' }]]) {
      const d = deps();
      const r = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(o), draft: dr, env, deps: d });
      assert.notStrictEqual(r.action, 'sent'); assert.strictEqual(d.sent.length, 0);
    }
  });

  await check('a duplicate claim is not a second reply', async () => {
    const d = deps({ autoReply: { execute: async () => ({ skipped: 'already_claimed' }) } });
    const r = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft, env: {}, deps: d });
    assert.strictEqual(r.action, 'skipped');
  });

  await check('send-check parsing fails closed on anything unreadable', async () => {
    assert.strictEqual(IR.parseCheck('not json'), null);
    assert.strictEqual(IR.parseCheck('{"needs_reply":true}'), null);
    assert.deepStrictEqual(IR.parseCheck('```json\n{"needs_reply":true,"supported":true,"no_commitments":true,"courteous":false,"issues":["curt"]}\n```').ok, false);
    const r = await IR.sendCheck({ inbound: inbound(), thread: 'x', draft: 'y' }, { client: { messages: { create: async () => { throw new Error('down'); } } } });
    assert.strictEqual(r.ok, false);
  });

  await check('one revision: a curt or unsupported draft is rewritten from the thread and sent only if the fresh check passes', async () => {
    let calls = 0;
    const checker = async ({ draft: body }) => { calls += 1; return body === 'REVISED' ? { ok: true, needs_reply: true, supported: true, no_commitments: true, courteous: true, issues: [] } : { ok: false, needs_reply: true, supported: false, no_commitments: true, courteous: true, issues: ['claims a deposit'] }; };
    const d = deps({ sendCheck: checker, reviseDraft: async () => 'REVISED' });
    const r = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft, env: {}, deps: d });
    assert.deepStrictEqual([r.action, calls, d.sent[0].draft.body, d.sent[0].decision.revised], ['sent', 2, 'REVISED', true]);
    const d2 = deps({ sendCheck: async () => ({ ok: false, needs_reply: true, supported: false, no_commitments: true, courteous: true, issues: ['still unsupported'] }), reviseDraft: async () => 'STILL BAD' });
    const r2 = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft, env: {}, deps: d2 });
    assert.deepStrictEqual([r2.action, d2.sent.length], ['review', 0]);
    let revisedAsked = false;
    const d3 = deps({ sendCheck: async () => ({ ok: false, needs_reply: true, supported: true, no_commitments: false, courteous: true, issues: ['promises a refund'] }), reviseDraft: async () => { revisedAsked = true; return 'X'; } });
    const r3 = await IR.handleInternal({ supabase: fakeDb({ users: STAFF }), inbound: inbound(), draft, env: {}, deps: d3 });
    assert.deepStrictEqual([r3.action, revisedAsked, d3.sent.length], ['review', false, 0]);   // a commitment is never revised into a send
  });

  if (failures) { console.log(`${failures} failed`); process.exit(1); }
  console.log('all passed');
})();
