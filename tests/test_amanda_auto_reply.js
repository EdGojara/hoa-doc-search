// tests/test_amanda_auto_reply.js  (Issue #29) — Amanda controlled send: authority gate,
// claim/lease/state machine, Sent Items verification, audit, escalation, and crash recovery.
// A "crash" is a Graph call that never resolves (the process dies there: no handler runs);
// a NEW orchestrator instance (a new process) then recovers with the clock past the lease.
// Every scenario asserts at most ONE Graph /send in total. No network, no production.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');

const policy = require('../lib/amanda/reply_policy');
const { createAutoReply, LEASE_MS, VERIFY_DELAYS } = require('../lib/amanda/auto_reply');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const AMANDA = 'amandaalbright@bedrocktx.com';
const ED = 'egojara@bedrocktx.com';
const ENV_ON = { AMANDA_AUTO_REPLY: 'on', AMANDA_AUTO_REPLY_SENDERS: ED };
const IMID = '<ed-canyon-gate@bedrocktx.com>';
const KEY = `email:${IMID}`;
const hang = () => new Promise(() => {});
const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));

// ---- in-memory DB (PostgREST-shaped) with the migration-490 unique claim ----
function fakeDb(seed = {}) {
  const T = { outbound_email_drafts: [], email_messages: [], objective_events: [], cron_runs: [], ...seed };
  let seq = 0;
  function from(t) {
    const f = []; let mode = 'select'; let payload = null; let single = false; let maybe = false; let head = false; let lim = null;
    const q = {
      select(_c, o) { if (o && o.head) head = true; return q; },
      eq(c, v) { f.push((r) => r[c] === v); return q; }, in(c, v) { f.push((r) => v.includes(r[c])); return q; },
      is(c, v) { f.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      lt(c, v) { f.push((r) => r[c] != null && String(r[c]) < String(v)); return q; }, gte(c, v) { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; },
      limit(n) { lim = n; return q; }, order() { return q; },
      insert(p) { mode = 'insert'; payload = p; return q; }, update(p) { mode = 'update'; payload = p; return q; },
      single() { single = true; return q; }, maybeSingle() { maybe = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    function exec() {
      const rows = T[t] || (T[t] = []);
      if (mode === 'insert') {
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...JSON.parse(JSON.stringify(payload)) };
        if (t === 'outbound_email_drafts' && row.draft_kind === 'amanda_auto_reply' && rows.some((r) => r.draft_kind === row.draft_kind && r.source_email_ref === row.source_email_ref)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_outbound_drafts_amanda_auto_reply"' } };
        }
        rows.push(row); return { data: single ? { ...row } : [{ ...row }], error: null };
      }
      let out = rows.filter((r) => f.every((p) => p(r)));
      if (mode === 'update') { for (const r of out) Object.assign(r, JSON.parse(JSON.stringify(payload))); return { data: out.map((r) => ({ ...r })), error: null }; }
      if (head) return { count: out.length, error: null };
      if (lim != null) out = out.slice(0, lim);
      if (single) return out.length === 1 ? { data: { ...out[0] }, error: null } : { data: null, error: { message: 'not single' } };
      if (maybe) return { data: out[0] ? { ...out[0] } : null, error: null };
      return { data: out.map((r) => ({ ...r })), error: null };
    }
    return q;
  }
  return { from, T };
}

// ---- fake Amanda mailbox (shared across "processes") ----
function fakeMailbox() {
  // The inbound SOURCE message lives in the mailbox too. Its Graph id changes when it moves
  // (ingest files it right after the insert), exactly as regular Graph ids do.
  const M = { msgs: {}, n: 0, sends: 0, creates: 0, patches: 0, attaches: 0, sourceId: 'src-graph-id', sourceImid: IMID, createCalls: [] };
  M.moveSource = () => { M.sourceId = `src-moved-${++M.n}`; return M.sourceId; };
  M.addDraft = (props) => { const id = `imm-${++M.n}`; M.msgs[id] = { id, isDraft: true, parentFolderId: 'DRAFTS', conversationId: 'conv-1', marker: null, body: '<div>quoted thread</div>', attachments: [], createdDateTime: new Date().toISOString(), ...props }; return id; };
  return M;
}
function graphFor(M, hooks = {}) {
  const at = async (name) => { if (hooks[name] === 'before') return hang(); };
  const after = async (name) => { if (hooks[name] === 'after') return hang(); };
  return {
    async messageMeta() { return { headers: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: hooks.authAs || 'Internal' }], to: [AMANDA], cc: hooks.cc || [], conversationId: 'conv-1' }; },
    async findByInternetMessageId(mbx, imid) { return hooks.noImidMatch || imid !== M.sourceImid || M.sourceGone ? null : M.sourceId; },
    async createReply(mbx, src, key) {
      await at('createReply');
      M.createCalls.push(src);
      if (hooks.createReplyError) { const e = new Error(hooks.createReplyError.message); e.temporary = hooks.createReplyError.temporary; throw e; }
      if (hooks.moveOnFirstCreate && !M.racedOnce) { M.racedOnce = true; M.moveSource(); }   // filed between resolve and reply
      if (src !== M.sourceId || M.sourceGone) return null;                                    // Graph 404: no draft created
      M.creates += 1; const id = M.addDraft({ marker: hooks.noMarkerOnCreate ? null : key });
      await after('createReply'); return { id, internetMessageId: null, conversationId: 'conv-1' };
    },
    async getMessage(mbx, id) {
      if (id === M.sourceId && !M.sourceGone) return { id, isDraft: false, parentFolderId: 'FILED', conversationId: 'conv-1', body: '', marker: null };
      await at('getMessage'); const m = M.msgs[id]; return m ? { ...m } : null;
    },
    async setMarker(mbx, id, key) { M.msgs[id].marker = key; },
    async findOwnedDrafts(mbx, key) { await at('findOwnedDrafts'); return Object.values(M.msgs).filter((m) => m.isDraft && m.marker === key).map((m) => ({ id: m.id, createdDateTime: m.createdDateTime })); },
    async findConversationDrafts(mbx, conv) { return Object.values(M.msgs).filter((m) => m.isDraft && m.conversationId === conv).map((m) => ({ id: m.id, createdDateTime: m.createdDateTime })); },
    async patchBody(mbx, id, html) { await at('patchBody'); M.patches += 1; M.msgs[id].body = html; },
    async listAttachments(mbx, id) { return M.msgs[id].attachments.map((a) => ({ name: a.name, contentId: a.contentId })); },
    async addAttachment(mbx, id, a) { M.attaches += 1; M.msgs[id].attachments.push(a); },
    async send(mbx, id) {
      await at('send');
      M.sends += 1; Object.assign(M.msgs[id], { isDraft: false, parentFolderId: 'SENT', internetMessageId: `<sent-${id}@bedrocktx.com>`, sentDateTime: new Date().toISOString() });
      await after('send'); return { status: 202 };
    },
    async sentItemsId() { return 'SENT'; },
  };
}
function proc(db, M, { hooks = {}, clock, env = ENV_ON } = {}) {
  const timers = [];
  const c = clock || { t: Date.parse('2026-10-04T23:00:00Z') };
  const ar = createAutoReply({ supabase: db, graph: graphFor(M, hooks), mailbox: AMANDA, env, log: quiet, now: () => c.t,
    setTimeout: (fn, ms) => timers.push({ fn, ms }), buildEmail: (text) => ({ html: `<p>${text}</p><p>Amanda Albright, signature</p>`, attachments: [{ name: 'logo.png', contentId: 'bedrocklogo' }] }) });
  return { ar, timers, clock: c };
}
const inbound = { id: 'in-1', internet_message_id: IMID, graph_id: 'src-graph-id', conversation_id: 'conv-1', sender_email: ED, sender_name: 'Ed Gojara', subject: 'Canyon Gate' };
const contract = { ok: true, intent: 'work', durable: true, objective: { id: 'obj-c50ec1f3', created: false }, audit_warnings: [] };
const draft = { body: 'Hi Ed,\n\nCanyon Gate has three items before Monday.', careful: false };
const EXEC = { class: 'EXECUTE', reasons: [], policy_version: policy.POLICY_VERSION };
function seedInbound(db) { db.T.email_messages.push({ id: 'in-1', internet_message_id: IMID, direction: 'inbound', graph_id: 'src-graph-id', conversation_id: 'conv-1', triage_status: 'needs_review', extracted: { draft: { status: 'pending', body: draft.body, review_hint: 'amanda request (work)' } } }); }
const receipt = (db) => db.T.outbound_email_drafts.find((r) => r.source_email_ref === KEY);

// ================= AUTHORITY =================
const goodInput = (over = {}) => ({ env: ENV_ON, mailbox: AMANDA, amandaMailbox: AMANDA, email: { sender_email: ED, direction: 'inbound', has_attachments: false },
  authAs: 'Internal', toRecipients: [AMANDA], ccRecipients: [], classification: 'internal', draft: { careful: false }, contract, recentAutoReplies: 0, ...over });

check('GATE: the Ed-only happy path is EXECUTE; Ed is not mistaken for an AI mailbox', () => {
  const d = policy.decideAmandaReply(goodInput());
  assert.strictEqual(d.class, 'EXECUTE', JSON.stringify(d.reasons));
  assert.ok(!policy.aiMailboxes().has(ED), 'ED_MAILBOX is a person, not an AI teammate');
  assert.ok(policy.aiMailboxes().has('claire@bedrocktx.com') && policy.aiMailboxes().has(AMANDA) && policy.aiMailboxes().has('info@bedrocktx.com'));
});

check('GATE: every condition independently blocks EXECUTE: safety -> REVIEW, content -> ACKNOWLEDGE (kill switch, allowlist, AI sender, spoof, outside cc, attachment, class, contract, careful, intent, rate cap)', () => {
  const cases = [
    ['kill_switch_off', { env: { AMANDA_AUTO_REPLY_SENDERS: ED } }],
    ['sender_not_allowlisted', { email: { sender_email: 'celina@bedrocktx.com', direction: 'inbound' } }],
    ['sender_is_ai_or_system', { env: { AMANDA_AUTO_REPLY: 'on', AMANDA_AUTO_REPLY_SENDERS: 'claire@bedrocktx.com' }, email: { sender_email: 'claire@bedrocktx.com', direction: 'inbound' } }],
    ['not_authenticated_internal:Anonymous', { authAs: 'Anonymous' }],
    ['not_authenticated_internal:missing', { authAs: null }],
    ['non_internal_recipient', { ccRecipients: ['homeowner@gmail.com'] }],
    ['has_attachments', { email: { sender_email: ED, direction: 'inbound', has_attachments: true } }],
    ['classification:homeowner_request', { classification: 'homeowner_request' }],
    ['contract_not_ok', { contract: { ...contract, ok: false } }],
    ['contract_audit_warnings', { contract: { ...contract, audit_warnings: ['timeline entry missing'] } }],
    ['draft_careful', { draft: { careful: true } }],
    ['intent_not_eligible:query:non_deterministic', { contract: { ok: true, intent: 'query', durable: false, objective: null, audit_warnings: [] } }],
    ['intent_not_eligible:work', { contract: { ok: true, intent: 'work', durable: false, objective: null, audit_warnings: [] } }],
    ['rate_cap', { recentAutoReplies: policy.RATE_CAP_PER_HOUR }],
    ['not_amanda_mailbox', { mailbox: 'info@bedrocktx.com' }],
  ];
  for (const [reason, over] of cases) {
    const d = policy.decideAmandaReply(goodInput(over));
    // WHO/WHERE (safety) failures -> REVIEW (no email at all); content-only failures -> ACKNOWLEDGE
    // (the fixed acknowledgement goes out, the answer stays in review). Never EXECUTE.
    const safety = policy.SAFETY.some((p) => reason === p || reason.startsWith(p + ':'));
    assert.strictEqual(d.class, safety ? 'REVIEW' : 'ACKNOWLEDGE', reason); assert.ok(d.reasons.includes(reason), `${reason} not in ${d.reasons}`);
  }
  assert.strictEqual(policy.decideAmandaReply(goodInput({ contract: { ok: true, intent: 'query', deterministic: 'status', audit_warnings: [] } })).class, 'EXECUTE', 'exact status is eligible');
  assert.strictEqual(policy.decideAmandaReply(goodInput({ contract: { ok: true, intent: 'decision', audit_warnings: [] } })).class, 'EXECUTE', 'the deterministic decision floor is eligible');
});

check('DECIDE: no Graph call unless the switch is on and the sender is allowlisted; rate check fails closed', async () => {
  let graphCalls = 0; const db = fakeDb(); const M = fakeMailbox();
  const g = graphFor(M); const counting = { ...g, messageMeta: async (...a) => { graphCalls += 1; return g.messageMeta(...a); } };
  const mk = (env) => createAutoReply({ supabase: db, graph: counting, mailbox: AMANDA, env, log: quiet });
  const email = { mailbox: AMANDA, sender_email: ED, direction: 'inbound', has_attachments: false, internet_message_id: IMID, graph_id: 'g' };
  const off = await mk({}).decide({ email, draft: { careful: false }, contract, classification: 'internal' });
  const other = await mk(ENV_ON).decide({ email: { ...email, sender_email: 'celina@bedrocktx.com' }, draft: { careful: false }, contract, classification: 'internal' });
  assert.strictEqual(off.class, 'REVIEW'); assert.strictEqual(other.class, 'REVIEW'); assert.strictEqual(graphCalls, 0, 'zero Graph calls on the ordinary path');
  const on = await mk(ENV_ON).decide({ email, draft: { careful: false }, contract, classification: 'internal' });
  assert.strictEqual(on.class, 'EXECUTE', JSON.stringify(on.reasons)); assert.strictEqual(graphCalls, 1, 'one header read');
  const brokenDb = { from: () => ({ select() { return this; }, eq() { return this; }, gte() { return Promise.resolve({ count: null, error: { message: 'timeout' } }); } }) };
  const failClosed = await createAutoReply({ supabase: brokenDb, graph: counting, mailbox: AMANDA, env: ENV_ON, log: quiet }).decide({ email, draft: { careful: false }, contract, classification: 'internal' });
  assert.strictEqual(failClosed.class, 'REVIEW'); assert.deepStrictEqual(failClosed.reasons, ['rate_check_failed']);
});

// ================= HAPPY PATH + AUDIT =================
check('EXECUTE: claim -> marked draft -> body once + signature attachments -> write-ahead send_requested -> /send ONCE -> verified in Sent Items -> audit', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox(); const { ar } = proc(db, M);
  const r = await ar.execute({ inbound, draft, decision: EXEC, contract });
  assert.strictEqual(r.status, 'sent'); assert.strictEqual(M.sends, 1); assert.strictEqual(M.creates, 1);
  const rc = receipt(db);
  assert.strictEqual(rc.status, 'sent'); assert.ok(rc.verified_at && rc.send_requested_at); assert.strictEqual(rc.sent_internet_message_id, `<sent-${rc.graph_draft_id}@bedrocktx.com>`);
  const sent = M.msgs[rc.graph_draft_id];
  assert.strictEqual(sent.marker, KEY, 'TrustEd ownership marker on the reply'); assert.ok(sent.body.includes('data-trusted-receipt=') && sent.body.includes('quoted thread'));
  assert.strictEqual(sent.attachments.length, 1);
  const inb = db.T.email_messages.find((m) => m.id === 'in-1');
  assert.strictEqual(inb.triage_status, 'handled'); assert.strictEqual(inb.extracted.draft.status, 'sent'); assert.strictEqual(inb.extracted.draft.receipt_id, rc.id);
  const out = db.T.email_messages.find((m) => m.direction === 'outbound');
  assert.strictEqual(out.mailbox, AMANDA); assert.strictEqual(out.graph_id, rc.graph_draft_id); assert.strictEqual(out.internet_message_id, rc.sent_internet_message_id); assert.ok(out.sent_at);
  assert.deepStrictEqual(db.T.objective_events.map((e) => [e.objective_id, e.kind, e.summary.split(' (')[0]]), [['obj-c50ec1f3', 'message_out', 'Sent by email to egojara@bedrocktx.com']]);
  assert.strictEqual(db.T.cron_runs.filter((c) => c.job_name === 'amanda_auto_reply' && c.ok).length, 1);
});

check('IDEMPOTENT: the same inbound again (retry, Pull inbox, recovery, re-ingest) never claims or sends again', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  await proc(db, M).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 3; i++) { const again = await proc(db, M).ar.execute({ inbound: { ...inbound, id: `reingested-${i}` }, draft, decision: EXEC, contract }); assert.strictEqual(again.skipped, 'already_claimed'); }
  const both = await Promise.all([proc(db, M).ar.execute({ inbound, draft, decision: EXEC, contract }), proc(db, M).ar.execute({ inbound, draft, decision: EXEC, contract })]);
  assert.ok(both.every((b) => b.skipped === 'already_claimed'));
  await proc(db, M).ar.sweep();
  assert.strictEqual(M.sends, 1); assert.strictEqual(db.T.outbound_email_drafts.length, 1);
});

check('REVIEW decisions never touch the receipt store or Graph', async () => {
  const db = fakeDb(); const M = fakeMailbox();
  const r = await proc(db, M).ar.execute({ inbound, draft, decision: { class: 'REVIEW', reasons: ['sender_not_allowlisted'] }, contract });
  assert.strictEqual(r.skipped, 'not_execute'); assert.strictEqual(db.T.outbound_email_drafts.length, 0); assert.strictEqual(M.creates + M.sends, 0);
});

// ================= CRASH RECOVERY =================
async function crashThenRecover(hookName, when, { recoverAt = LEASE_MS + 1000 } = {}) {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const clock = { t: Date.parse('2026-10-04T23:00:00Z') };
  proc(db, M, { hooks: { [hookName]: when }, clock }).ar.execute({ inbound, draft, decision: EXEC, contract });   // dies at the hook
  for (let i = 0; i < 10; i++) await tick();
  const stateAtCrash = receipt(db).status;
  clock.t += recoverAt;
  const B = proc(db, M, { clock });
  const out = await B.ar.sweep();
  return { db, M, B, clock, stateAtCrash, out };
}

check('CRASH 1: right after the claim (no Graph object): recovery resumes under the SAME receipt and sends once', async () => {
  const { db, M, stateAtCrash } = await crashThenRecover('findOwnedDrafts', 'before');
  assert.strictEqual(stateAtCrash, 'claimed');
  assert.strictEqual(receipt(db).status, 'sent'); assert.strictEqual(M.sends, 1); assert.strictEqual(M.creates, 1); assert.strictEqual(db.T.outbound_email_drafts.length, 1);
});

check('CRASH 2: after createReply, before the id was stored: recovery adopts the draft BY OWNERSHIP MARKER, creates none, sends once', async () => {
  const { db, M, stateAtCrash } = await crashThenRecover('createReply', 'after');
  assert.strictEqual(stateAtCrash, 'claimed'); assert.strictEqual(receipt(db).graph_draft_id ? 'stored' : 'missing', 'stored');
  assert.strictEqual(M.creates, 1, 'no second createReply'); assert.strictEqual(Object.keys(M.msgs).length, 1, 'no extra draft');
  assert.strictEqual(receipt(db).status, 'sent'); assert.strictEqual(M.sends, 1);
});

check('CRASH 3: draft created, before /send: recovery inspects THAT draft and resumes it (body once, no duplicate attachment), sends once', async () => {
  const { db, M, stateAtCrash } = await crashThenRecover('patchBody', 'before');
  assert.strictEqual(stateAtCrash, 'draft_created');
  assert.strictEqual(M.creates, 1, 'createReply not repeated'); assert.strictEqual(M.patches, 1); assert.strictEqual(M.attaches, 1);
  assert.strictEqual(receipt(db).status, 'sent'); assert.strictEqual(M.sends, 1);
  // A resume after the body was already patched never patches it again.
  const db2 = fakeDb(); seedInbound(db2); const M2 = fakeMailbox(); const clock = { t: Date.parse('2026-10-04T23:00:00Z') };
  proc(db2, M2, { hooks: { getMessage: 'before' }, clock }).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 10; i++) await tick();
  const id = receipt(db2).graph_draft_id; M2.msgs[id].body = `<div data-trusted-receipt="x">already</div>`;   // simulate a body already carrying our marker
  M2.msgs[id].body = `<div ${'data-trusted-receipt="' + require('crypto').createHash('sha256').update(KEY).digest('hex').slice(0, 24) + '"'}>ours</div>quoted`;
  clock.t += LEASE_MS + 1000; await proc(db2, M2, { clock }).ar.sweep();
  assert.strictEqual(M2.patches, 0, 'body already marked: not patched twice'); assert.strictEqual(M2.sends, 1);
});

check('CRASH 4a: after send_requested, /send accepted, before verification: recovery VERIFIES and records; zero extra sends', async () => {
  const { db, M, stateAtCrash } = await crashThenRecover('send', 'after');
  assert.strictEqual(stateAtCrash, 'send_requested');
  assert.strictEqual(receipt(db).status, 'sent'); assert.strictEqual(M.sends, 1, 'never resent');
});

check('CRASH 4b: send_requested but /send never reached Graph: verification only, bounded, then ESCALATE; zero sends', async () => {
  const { db, M, B, stateAtCrash } = await crashThenRecover('send', 'before');
  assert.strictEqual(stateAtCrash, 'send_requested'); assert.strictEqual(M.sends, 0);
  for (let i = 0; i < VERIFY_DELAYS.length + 1; i++) { const t = B.timers.shift(); if (!t) break; await t.fn(); for (let k = 0; k < 5; k++) await tick(); }
  const rc = receipt(db);
  assert.strictEqual(rc.status, 'unverified'); assert.ok(rc.escalated_at, 'escalated to a person'); assert.strictEqual(M.sends, 0, 'never sends from send_requested');
  const inb = db.T.email_messages.find((m) => m.id === 'in-1');
  assert.strictEqual(inb.triage_status, 'needs_review'); assert.match(inb.extracted.draft.review_hint, /may already have replied automatically.*Check Amanda's Sent Items/);
  assert.ok(db.T.cron_runs.some((c) => c.job_name === 'amanda_auto_reply' && c.ok === false));
});

check('LEASE: a live worker is never stolen; two recoverers racing after expiry -> exactly one proceeds', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox(); const clock = { t: Date.parse('2026-10-04T23:00:00Z') };
  proc(db, M, { hooks: { findOwnedDrafts: 'before' }, clock }).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 10; i++) await tick();
  clock.t += 30e3;   // lease still live
  const early = await proc(db, M, { clock }).ar.sweep();
  assert.deepStrictEqual(early.map((x) => x.skipped), ['lease_live']); assert.strictEqual(M.creates, 0);
  clock.t += LEASE_MS;
  await Promise.all([proc(db, M, { clock }).ar.sweep(), proc(db, M, { clock }).ar.sweep()]);
  assert.strictEqual(M.creates, 1); assert.strictEqual(M.sends, 1);
});

check('UNMARKED drafts in the conversation are evidence, not proof: never adopted or deleted; escalated; zero sends', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox(); const clock = { t: Date.parse('2026-10-04T23:00:00Z') };
  proc(db, M, { hooks: { findOwnedDrafts: 'before' }, clock }).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 10; i++) await tick();
  const human = M.addDraft({ marker: null, createdDateTime: new Date(clock.t + 1000).toISOString() });   // a person's Outlook draft
  clock.t += LEASE_MS + 1000;
  await proc(db, M, { clock }).ar.sweep();
  const rc = receipt(db);
  assert.strictEqual(rc.status, 'unverified'); assert.ok(rc.escalated_at); assert.match(rc.last_error, /unmarked draft/);
  assert.ok(M.msgs[human] && M.msgs[human].isDraft, 'the human draft is untouched'); assert.strictEqual(M.creates, 0); assert.strictEqual(M.sends, 0);
  // Two TrustEd-marked drafts (should never happen): do not guess either; escalate.
  const db2 = fakeDb(); seedInbound(db2); const M2 = fakeMailbox(); const c2 = { t: Date.parse('2026-10-04T23:00:00Z') };
  proc(db2, M2, { hooks: { findOwnedDrafts: 'before' }, clock: c2 }).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 10; i++) await tick();
  M2.addDraft({ marker: KEY }); M2.addDraft({ marker: KEY }); c2.t += LEASE_MS + 1000;
  await proc(db2, M2, { clock: c2 }).ar.sweep();
  assert.strictEqual(receipt(db2).status, 'unverified'); assert.strictEqual(Object.keys(M2.msgs).length, 2, 'nothing deleted'); assert.strictEqual(M2.sends, 0);
});

check('MARKER: if Graph drops the marker on createReply, it is PATCHed onto the draft before anything else', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  await proc(db, M, { hooks: { noMarkerOnCreate: true } }).ar.execute({ inbound, draft, decision: EXEC, contract });
  assert.strictEqual(M.msgs[receipt(db).graph_draft_id].marker, KEY); assert.strictEqual(M.sends, 1);
});

check('BOUNDS: a permanent Graph error before send -> failed + human banner; temporary errors stop at MAX_ATTEMPTS', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  await proc(db, M, { hooks: { createReplyError: { message: 'ErrorAccessDenied', temporary: false } } }).ar.execute({ inbound, draft, decision: EXEC, contract });
  let rc = receipt(db); assert.strictEqual(rc.status, 'failed'); assert.ok(rc.escalated_at); assert.strictEqual(M.sends, 0);
  assert.match(db.T.email_messages[0].extracted.draft.review_hint, /did not go out.*Review and send this draft yourself/);
  const db2 = fakeDb(); seedInbound(db2); const M2 = fakeMailbox(); const clock = { t: Date.parse('2026-10-04T23:00:00Z') };
  await proc(db2, M2, { hooks: { createReplyError: { message: 'network reset' } }, clock }).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 5; i++) { clock.t += LEASE_MS + 1000; await proc(db2, M2, { hooks: { createReplyError: { message: 'network reset' } }, clock }).ar.sweep(); }
  rc = receipt(db2); assert.strictEqual(rc.status, 'failed'); assert.ok(rc.attempts <= 3, `attempts ${rc.attempts}`); assert.strictEqual(M2.sends, 0);
  const sweeps = await proc(db2, M2, { clock }).ar.sweep(); assert.deepStrictEqual(sweeps, [], 'escalated receipts leave the sweep');
});

check('HUMAN-OVERRIDE SUPPORT: receiptFor / verifyNow (fresh check promotes a found sent copy) / releaseToHuman (pre-send only)', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  proc(db, M, { hooks: { send: 'after' } }).ar.execute({ inbound, draft, decision: EXEC, contract });   // dies after /send, before verification
  for (let i = 0; i < 10; i++) await tick();
  const ar = proc(db, M).ar; const rc = await ar.receiptFor(IMID);
  assert.strictEqual(rc.status, 'send_requested');
  assert.strictEqual(await ar.verifyNow(rc), 'sent', 'the sent copy is found and recorded'); assert.strictEqual(receipt(db).status, 'sent');
  assert.strictEqual(await ar.releaseToHuman(receipt(db)), false, 'a sent receipt is never released');
  const db2 = fakeDb(); seedInbound(db2); const M2 = fakeMailbox(); const c = { t: Date.parse('2026-10-04T23:00:00Z') };
  proc(db2, M2, { hooks: { findOwnedDrafts: 'before' }, clock: c }).ar.execute({ inbound, draft, decision: EXEC, contract });
  for (let i = 0; i < 10; i++) await tick();
  assert.strictEqual(await proc(db2, M2, { clock: c }).ar.releaseToHuman(receipt(db2)), true);
  assert.strictEqual(receipt(db2).status, 'failed'); c.t += LEASE_MS + 1000; await proc(db2, M2, { clock: c }).ar.sweep(); assert.strictEqual(M2.sends, 0, 'recovery never sends what a person took over');
});

// ================= SOURCE MOVED (live proof 2026-10-04) =================
check('LIVE-PROOF REGRESSION: the inbound message is FILED (Graph id changes) between ingest and reply creation -> resolved by internetMessageId, the stale id is never used, one send', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const staleId = M.sourceId;                       // what ingest saw before filing
  const newId = M.moveSource();                     // ingest filed it; the stored id would be updated too
  db.T.email_messages[0].graph_id = newId;
  const r = await proc(db, M).ar.execute({ inbound: { ...inbound, graph_id: staleId }, draft, decision: EXEC, contract });
  assert.strictEqual(r.status, 'sent'); assert.strictEqual(M.sends, 1);
  assert.deepStrictEqual(M.createCalls, [newId], 'createReply only ever targets the current message');
  assert.ok(!M.createCalls.includes(staleId), 'the pre-move id handed in from ingest is never trusted');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'amanda', 'auto_reply.js'), 'utf8');
  assert.ok(!/sourceGraphId:\s*inbound\.graph_id/.test(src) && !/ctx\.sourceGraphId/.test(src), 'no hand-off of a source id from ingest');
  const ing = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.ok(!/inbound: \{ id: insId, internet_message_id: email\.internet_message_id, graph_id: email\.graph_id/.test(ing), 'ingest no longer hands over the pre-filing graph_id');
});

check('RACE: the message moves BETWEEN resolve and createReply (404, no draft) -> re-resolved once and retried; one draft, one send', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const r = await proc(db, M, { hooks: { moveOnFirstCreate: true } }).ar.execute({ inbound, draft, decision: EXEC, contract });
  assert.strictEqual(r.status, 'sent'); assert.strictEqual(M.createCalls.length, 2); assert.notStrictEqual(M.createCalls[0], M.createCalls[1]);
  assert.strictEqual(M.creates, 1, 'exactly one draft'); assert.strictEqual(M.sends, 1); assert.strictEqual(receipt(db).attempts, 1, 'one attempt, not two');
});

check('FALLBACK: no internetMessageId match -> the stored graph_id is used ONLY if Graph confirms it; a stale stored id escalates with zero sends', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const r = await proc(db, M, { hooks: { noImidMatch: true } }).ar.execute({ inbound, draft, decision: EXEC, contract });
  assert.strictEqual(r.status, 'sent'); assert.deepStrictEqual(M.createCalls, ['src-graph-id']);
  const db2 = fakeDb(); seedInbound(db2); const M2 = fakeMailbox(); M2.sourceGone = true;   // deleted or unreachable
  await proc(db2, M2).ar.execute({ inbound, draft, decision: EXEC, contract });
  const rc = receipt(db2);
  assert.strictEqual(rc.status, 'failed'); assert.ok(rc.escalated_at); assert.match(rc.last_error, /source message not found/);
  assert.strictEqual(M2.createCalls.length, 0, 'no createReply on an unconfirmed id'); assert.strictEqual(M2.sends, 0);
});

check('PRODUCTION RECEIPT: a receipt left `claimed` by the live 404 (attempts 1, no draft, lease released) recovers under the SAME receipt and sends EXACTLY once; further sweeps, re-ingest and a human Send cannot double-send', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const clock = { t: Date.parse('2026-10-04T23:30:00Z') };
  M.moveSource(); db.T.email_messages[0].graph_id = M.sourceId;   // filed after ingest, stored id updated
  db.T.outbound_email_drafts.push({ id: '01fdf096', draft_kind: 'amanda_auto_reply', source_email_ref: KEY, status: 'claimed', persona: 'amanda', from_mailbox: AMANDA,
    to_email: ED, subject: 'Re: Canyon Gate', body_text: draft.body, attempts: 1, verify_checks: 0, lease_token: 'live-lease', lease_expires_at: new Date(clock.t - 1000).toISOString(),
    claimed_at: '2026-10-04T23:24:16Z', conversation_id: 'conv-1', objective_id: 'obj-c50ec1f3', last_error: 'createReply returned no draft', created_at: '2026-10-04T23:24:16Z' });
  await proc(db, M, { clock }).ar.sweep();
  const rc = receipt(db);
  assert.strictEqual(rc.status, 'sent'); assert.strictEqual(rc.attempts, 2); assert.strictEqual(M.sends, 1); assert.strictEqual(M.creates, 1);
  assert.strictEqual(db.T.outbound_email_drafts.length, 1, 'same receipt, never a second one');
  for (let i = 0; i < 3; i++) { clock.t += LEASE_MS + 1000; await proc(db, M, { clock }).ar.sweep(); }
  const again = await proc(db, M, { clock }).ar.execute({ inbound: { ...inbound, id: 'reingested' }, draft, decision: EXEC, contract });
  assert.strictEqual(again.skipped, 'already_claimed');
  const ar = proc(db, M, { clock }).ar; assert.strictEqual((await ar.receiptFor(IMID)).status, 'sent', 'the Communications guard sees sent -> 409');
  assert.strictEqual(await ar.releaseToHuman(receipt(db)), false);
  assert.strictEqual(M.sends, 1, 'still exactly one send');
});

// ================= REAL GRAPH ADAPTER (live proof 2026-10-05) =================
check('REAL ADAPTER: listing a draft\'s attachments selects only base-type properties (contentId is fileAttachment-only; Graph 400s on it), and no $select names a property Graph rejects', async () => {
  const gsPath = require.resolve('../lib/email/graph_send');
  const savedGs = require.cache[gsPath]; const realFetch = global.fetch; const urls = [];
  require.cache[gsPath] = { id: gsPath, filename: gsPath, loaded: true, exports: { ...(savedGs ? savedGs.exports : {}), getToken: async () => 'token' } };
  global.fetch = async (url) => {
    urls.push(String(url));
    if (/\/attachments\?\$select=[^&]*contentId/.test(decodeURIComponent(String(url)))) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'BadRequest', message: "Parsing OData Select and Expand failed: Could not find a property named 'contentId' on type 'microsoft.graph.attachment'." } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ value: [{ name: 'image001.png', '@odata.type': '#microsoft.graph.fileAttachment' }] }) };
  };
  try {
    delete require.cache[require.resolve('../lib/amanda/auto_reply')];
    const { _realGraph } = require('../lib/amanda/auto_reply');
    const list = await _realGraph().listAttachments(AMANDA, 'draft-imm-id');
    assert.deepStrictEqual(list, [{ name: 'image001.png' }]);
    assert.ok(urls.some((u) => /\/attachments\?\$select=name$/.test(u)), urls.join(' '));
  } finally {
    global.fetch = realFetch; if (savedGs) require.cache[gsPath] = savedGs; else delete require.cache[gsPath];
    delete require.cache[require.resolve('../lib/amanda/auto_reply')];
  }
  // Every $select in the adapter names only properties of the base message / folder / attachment types.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'amanda', 'auto_reply.js'), 'utf8');
  const BASE = new Set(['id', 'name', 'isDraft', 'parentFolderId', 'internetMessageId', 'conversationId', 'sentDateTime', 'createdDateTime', 'body', 'internetMessageHeaders', 'toRecipients', 'ccRecipients']);
  for (const m of src.matchAll(/\$select=([A-Za-z,]+)/g)) for (const f of m[1].split(',')) assert.ok(BASE.has(f), `unexpected $select property: ${f}`);
});

check('RESUME after the live 400: a draft that already has the patched body and one foreign inline image gets ONLY our missing signature images, matched by name', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox(); const clock = { t: Date.parse('2026-10-05T00:30:00Z') };
  proc(db, M, { hooks: { getMessage: 'before' }, clock }).ar.execute({ inbound, draft, decision: EXEC, contract });   // dies at draft_created
  for (let i = 0; i < 10; i++) await tick();
  const id = receipt(db).graph_draft_id;
  M.msgs[id].attachments.push({ name: 'image001.png' });   // Ed's signature image from the quoted thread
  clock.t += LEASE_MS + 1000; await proc(db, M, { clock }).ar.sweep();
  assert.deepStrictEqual(M.msgs[id].attachments.map((a) => a.name).sort(), ['image001.png', 'logo.png']);
  assert.strictEqual(M.sends, 1); assert.strictEqual(receipt(db).status, 'sent');
});

// ================= NEVER SILENT (Ed, 2026-10-05) =================
const STATUS_CONTRACT = { ok: true, intent: 'query', deterministic: 'status', durable: false, objective: null, audit_warnings: [] };
const MODEL_QUERY = { ok: true, intent: 'query', durable: false, objective: null, audit_warnings: [] };

check("NEVER SILENT: every direct request from Ed has a VISIBLE outcome (answer sent or acknowledgement sent); none ends as a silent draft", () => {
  const cases = [
    ["Ed's exact email (exact status for Canyon Gate)", { contract: STATUS_CONTRACT }, 'EXECUTE'],
    ['work request (durable objective)', { contract }, 'EXECUTE'],
    ['decision request (controlled destination / floor)', { contract: { ok: true, intent: 'decision', audit_warnings: [] } }, 'EXECUTE'],
    ['AI-written answer to a broader question', { contract: MODEL_QUERY }, 'ACKNOWLEDGE'],
    ['older staff-assist drafter (no request contract)', { contract: null }, 'ACKNOWLEDGE'],
    ['careful draft', { draft: { careful: true } }, 'ACKNOWLEDGE'],
    ['email with attachments', { email: { sender_email: ED, direction: 'inbound', has_attachments: true } }, 'ACKNOWLEDGE'],
    ['forwarded homeowner mail (non-internal class)', { classification: 'homeowner_request' }, 'ACKNOWLEDGE'],
  ];
  for (const [name, over, expected] of cases) {
    const d = policy.decideAmandaReply(goodInput(over));
    assert.strictEqual(d.class, expected, `${name}: ${d.reasons}`);
    assert.ok(['EXECUTE', 'ACKNOWLEDGE'].includes(d.class), `${name} would be silent`);
  }
  // WHO/WHERE failures still never email (the pending draft in Communications is the outcome).
  for (const over of [{ authAs: 'Anonymous' }, { ccRecipients: ['x@gmail.com'] }, { email: { sender_email: 'celina@bedrocktx.com', direction: 'inbound' } }]) {
    assert.strictEqual(policy.decideAmandaReply(goodInput(over)).class, 'REVIEW');
  }
});

check("ED'S EXACT EMAIL end to end through the send machinery: the exact-status answer is sent once, verified, inbound handled", async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const decision = policy.decideAmandaReply(goodInput({ contract: STATUS_CONTRACT }));
  const r = await proc(db, M).ar.execute({ inbound, draft: { body: 'Hi Ed,\n\n2 items need you now at Canyon Gate at Cinco Ranch...' }, decision, contract: STATUS_CONTRACT });
  assert.strictEqual(r.status, 'sent'); assert.strictEqual(M.sends, 1);
  assert.strictEqual(receipt(db).policy.mode, 'answer'); assert.strictEqual(db.T.email_messages[0].triage_status, 'handled');
  assert.strictEqual(db.T.objective_events.length, 0, 'a status answer creates no objective event (no objective)');
});

check('ACKNOWLEDGE: the fixed, non-AI acknowledgement is sent ONCE and verified; the inbound STAYS in review with its pending answer; timeline says Acknowledged; no execution claimed', async () => {
  const db = fakeDb(); seedInbound(db); const M = fakeMailbox();
  const decision = policy.decideAmandaReply(goodInput({ contract: { ...MODEL_QUERY, objective: { id: 'obj-c50ec1f3' } } }));
  assert.strictEqual(decision.class, 'ACKNOWLEDGE');
  const aiAnswer = 'Hi Ed,\n\nThe Gexa bill is late because nobody approved it.';
  const r = await proc(db, M).ar.execute({ inbound, draft: { body: aiAnswer }, decision, contract: { objective: { id: 'obj-c50ec1f3' } } });
  assert.strictEqual(r.status, 'sent'); assert.strictEqual(M.sends, 1);
  const rc = receipt(db); assert.strictEqual(rc.policy.mode, 'ack'); assert.strictEqual(rc.ai_drafted, false);
  const sent = M.msgs[rc.graph_draft_id];
  assert.ok(!sent.body.includes('nobody approved'), 'the AI-written answer is NOT what went out');
  assert.ok(sent.body.includes('I have this. My reply needs a person to review it before I send it') && sent.body.includes('Nothing has been sent or changed yet.'));
  const ackText = policy.acknowledgementText('Ed');
  assert.ok(!/—/.test(ackText), 'no em-dash'); assert.ok(!/\b(?:I(?:'ve| have) (?:sent|done|handled|approved|paid)|on it|right away)\b/i.test(ackText), 'claims nothing was executed');
  const inb = db.T.email_messages.find((m) => m.id === 'in-1');
  assert.strictEqual(inb.triage_status, 'needs_review', 'still in review'); assert.strictEqual(inb.extracted.draft.status, 'pending', 'the answer is still pending');
  assert.strictEqual(inb.extracted.draft.acknowledged.receipt_id, rc.id); assert.match(inb.extracted.draft.review_hint, /^Amanda acknowledged this by email \(no answer sent\)/);
  assert.match(db.T.objective_events[0].summary, /^Acknowledged by email to egojara@bedrocktx\.com; the answer needs review/);
  assert.ok(db.T.cron_runs.some((c) => c.summary && c.summary.action === 'acknowledged'));
  // Idempotent: one inbound, one outward message total.
  await proc(db, M).ar.execute({ inbound, draft: { body: aiAnswer }, decision, contract: {} }); await proc(db, M).ar.sweep();
  assert.strictEqual(M.sends, 1);
});

check('ACKNOWLEDGE does not block the person: the Communications guard skips acknowledgement receipts; ingest decides for every staff-assist draft', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_triage.js'), 'utf8');
  assert.match(src, /if \(rcpt && !\(rcpt\.policy && rcpt\.policy\.mode === 'ack'\)\) \{/);
  const ing = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.match(ing, /contract: d\.amanda_request \|\| null/);
  assert.ok(!/if \(d\.amanda_request\) \{\s*try \{\s*draft\.autonomy/.test(ing), 'the decision no longer skips the older drafter');
});

// ================= HUMAN SEND GUARDS =================
check('COMMUNICATIONS SEND GUARD: Amanda receipt checked BEFORE any Graph send; sent=409; may-have-sent gets a FRESH verification, then explicit confirmation; live pre-send=409; stale pre-send released to the person only on confirm', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_triage.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("router.post('/:id/send'"); const block = src.slice(start, src.indexOf('\n});', start));
  assert.match(block, /graph_id, internet_message_id, conversation_id/, 'the route reads the inbound internet_message_id');
  const iGuard = block.indexOf("persona === 'amanda' && m.internet_message_id");
  assert.ok(iGuard > 0 && iGuard < block.indexOf('graphSend.sendReplyAs(') && iGuard < block.indexOf('graphSend.sendAs('), 'guard runs before any send');
  assert.ok(iGuard < block.indexOf("triage_status: 'handled'"), 'and before anything is marked');
  assert.match(block, /rcpt\.status === 'sent'\) return res\.status\(409\)\.json\(\{ error: 'already_sent_by_amanda'/);
  const iVerify = block.indexOf('autoReply.verifyNow(rcpt)'); const iConfirm = block.indexOf("error: 'amanda_unverified_confirm_required', message: 'Amanda may already");
  assert.ok(iVerify > 0 && iVerify < iConfirm, 'fresh verification BEFORE the confirmation path');
  assert.match(block, /\(rcpt\.status === 'failed' && rcpt\.send_requested_at\)/, 'a failed receipt after send_requested is treated as may-have-sent');
  assert.match(block, /error: 'amanda_sending'/); assert.match(block, /autoReply\.releaseToHuman\(rcpt\)/);
  assert.match(block, /catch \(e\) \{ return res\.status\(503\)/, 'cannot check the receipt -> nothing is sent');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'communications.html'), 'utf8');
  assert.match(ui, /j\.error==='amanda_unverified_confirm_required' && confirm\(/); assert.match(ui, /confirm_after_amanda:true/);
});

check('DRAFT QUEUE: Amanda receipt records are never sent, edited or discarded from the Draft Queue', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'email_drafts.js'), 'utf8').replace(/\r\n/g, '\n');
  const send = src.slice(src.indexOf("router.post('/:id/send'"));
  const iGuard = send.indexOf("d.draft_kind === 'amanda_auto_reply') return res.status(409)");
  assert.ok(iGuard > 0 && iGuard < send.indexOf('graphSend.sendAs('), 'refused before any send');
  // Edit and discard only touch status 'draft'; receipts never carry that status.
  assert.match(src, /router\.put\('\/:id'[\s\S]*?\.eq\('status', 'draft'\)/); assert.match(src, /router\.post\('\/:id\/discard'[\s\S]*?\.eq\('status', 'draft'\)/);
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '490_amanda_auto_reply_receipts.sql'), 'utf8');
  assert.ok(!/status\s*:\s*'draft'|DEFAULT 'draft'.*amanda/i.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'amanda', 'auto_reply.js'), 'utf8')), 'receipts never use status draft');
  assert.ok(mig.length > 0);
});

// ================= WIRING =================
check('WIRING: ingest decides before the row and executes only on EXECUTE; recovery rides boot + the 6-hour push pass; no new timer; no sign-off; migration shape', () => {
  const ing = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.match(ing, /draft\.autonomy = await require\('\.\.\/amanda\/auto_reply'\)\.getAutoReply\(\)\.decide\(/);
  assert.match(ing, /\['EXECUTE', 'ACKNOWLEDGE'\]\.includes\(draft\.autonomy\.class\)\) \{[\s\S]*?getAutoReply\(\)\.execute\(/);
  assert.match(ing, /contract: d\.amanda_request \|\| null/, 'the decision runs for every staff-assist draft, including the older drafter');
  const push = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_push.js'), 'utf8');
  assert.match(push, /getAutoReply\(\)\.sweep\(\)/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/amanda\/auto_reply'\)\.startAutoReplyRecovery\(\)/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'amanda', 'auto_reply.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/setInterval/.test(src), 'no polling timer'); assert.ok(!/DELETE'|\.remove\(|deleteMessage/.test(src), 'never deletes a draft');
  assert.ok(!/AUTO_OUTBOUND_EMAIL/.test(src), 'not the global auto-send switch');
  const staff = fs.readFileSync(path.join(__dirname, '..', 'lib', 'community', 'amanda_staff_assist.js'), 'utf8');
  assert.ok(!/parts\.push\('Amanda'\)/.test(staff), 'no bare sign-off; the signature comes from buildAmandaEmail');
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '490_amanda_auto_reply_receipts.sql'), 'utf8');
  assert.match(mig, /CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_drafts_amanda_auto_reply[\s\S]*WHERE draft_kind = 'amanda_auto_reply'/);
  for (const s of ['claimed', 'draft_created', 'draft_ready', 'send_requested', 'unverified', 'failed']) assert.ok(mig.includes(`'${s}'`), s);
  assert.match(mig, /^BEGIN;/m); assert.match(mig, /^COMMIT;/m);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests.filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY))) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
