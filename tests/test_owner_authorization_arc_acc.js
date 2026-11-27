// tests/test_owner_authorization_arc_acc.js  (Ed 2026-11-26: ARC/ACC in the Owner Authorization Service)
// The ARC/ACC adapter (lib/authorization/arc_acc, migration 582): one numbered package, the
// owner's reply ("approved", "approved except 3"), execution through each module's own path,
// the recheck immediately before any email, and Amanda's verification. No real database,
// mail or module: a small in-memory fake and recorded executors.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AA = require('../lib/authorization/arc_acc');
const AZ = require('../lib/authorization');
const OA = require('../lib/onboarding/owner_authorization');
const RG = require('../lib/email/reply_guard');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const OWNER = 'egojara@bedrocktx.com';

// In-memory Supabase: enough of the query builder for the adapter.
function fakeDb(seed = {}) {
  const t = JSON.parse(JSON.stringify(seed));
  let ids = 0;
  const storage = {};
  const rpcCalls = [];
  const table = (n) => (t[n] = t[n] || []);
  const from = (name) => {
    const st = { filters: [], op: 'select', patch: null, rows: null, single: false, maybe: false, limit: null };
    const api = {
      select() { return api; }, order() { return api; },
      eq(k, v) { st.filters.push((x) => x[k] === v); return api; },
      is(k, v) { st.filters.push((x) => (x[k] == null ? null : x[k]) === v); return api; },
      neq(k, v) { st.filters.push((x) => x[k] !== v); return api; },
      in(k, vs) { st.filters.push((x) => vs.includes(x[k])); return api; },
      gte(k, v) { st.filters.push((x) => x[k] != null && String(x[k]) >= String(v)); return api; },
      ilike(k, v) { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); st.filters.push((x) => re.test(String(x[k] || ''))); return api; },
      like(k, v) { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$'); st.filters.push((x) => re.test(String(x[k] || ''))); return api; },
      not(k, op, v) { if (op === 'is') { st.filters.push((x) => x[k] != null); return api; } const vals = String(v).replace(/[()]/g, '').split(','); st.filters.push((x) => !vals.includes(x[k])); return api; },
      limit(n) { st.limit = n; return api; },
      single() { st.single = true; return api; }, maybeSingle() { st.maybe = true; return api; },
      insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return api; },
      update(p) { st.op = 'update'; st.patch = p; return api; },
      then(res, rej) {
        let data;
        if (st.op === 'insert') {
          if (name === 'work_items' && st.rows.some((r) => r.source_ref && table(name).some((x) => x.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(x.status)))) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }).then(res, rej);
          data = st.rows.map((r) => ({ id: `${name}-${++ids}`, occurred_at: new Date(Date.now() + ids).toISOString(), updated_at: new Date(Date.now() + ids).toISOString(), ...r })); table(name).push(...data);
        }
        else {
          const hit = table(name).filter((x) => st.filters.every((f) => f(x)));
          if (st.op === 'update') { for (const x of hit) Object.assign(x, JSON.parse(JSON.stringify(st.patch))); }
          data = st.limit ? hit.slice(0, st.limit) : hit;
        }
        if (st.single) return Promise.resolve(data.length ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } }).then(res, rej);
        if (st.maybe) return Promise.resolve({ data: data[0] || null, error: null }).then(res, rej);
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return api;
  };
  return {
    t, storage, rpcCalls, from,
    storage: { from: () => ({ async upload(p, buf) { storage[p] = buf; return { error: null }; } }) },
    async rpc(name, args) { rpcCalls.push([name, args]); if (name === 'owner_authorization_mark_executed') { const a = table('owner_authorizations').find((x) => x.id === args.p_id); if (!a || a.status !== 'authorized') return { data: null, error: { message: 'only an authorized owner authorization is marked executed' } }; a.status = 'executed'; } return { data: null, error: null }; },
  };
}

const APP = (id, extra = {}) => ({ id, status: 'received', reference_number: `SCR-BLD-${id}`, street_address: `${id} Misty Maple Lane, Richmond, TX`, lot_number: '1', block_number: '1', plan_number: '4700', elevation: 'D4', community_id: 'c1', ...extra });
const DEC = (id, extra = {}) => ({ id, status: 'pending_review', reference_number: `WAT-ARC-${id}`, letter_body: `Dear Owner ${id},\n\nApproved.`, submitter_email: `owner${id}@example.com`, community_id: 'c2', homeowner_address: `${id} Cape Clover Trail`, ...extra });
const DRAFT = (id, extra = {}) => ({ id, status: 'draft', persona: 'annie', to_email: 'builder@example.com', subject: 'Re: ARC Approvals Needed', body_text: 'Hi,\n\nThe approval letters, dated today, are attached.', attachments: [], source_email_ref: 'in-1', policy: { awaiting_owner_authorization: true }, ...extra });

function seed() {
  return {
    builder_applications: [APP('a1'), APP('a2')],
    acc_decisions: [DEC('d1'), DEC('d2', { submitter_email: null })],
    outbound_email_drafts: [DRAFT('m1'), DRAFT('old1', { policy: {} })],
    user_profiles: [{ id: 'ed-uid', email: OWNER, full_name: 'Ed Gojara', role: 'admin', is_active: true }],
    email_messages: [], acc_finalizations: [], work_items: [], work_item_events: [], authorization_events: [], builder_application_responses: [],
  };
}
const SPEC = () => [
  { action: 'builder_decision', target_id: 'a1', executor: 'annie', title: '8003 Misty Maple Lane (SCR-BLD-a1)', decision: 'approve', basis: 'complete' },
  { action: 'builder_decision', target_id: 'a2', executor: 'annie', title: '8011 Misty Maple Lane (SCR-BLD-a2)', decision: 'approve_with_conditions', conditions: ['Vary the trim color.'], basis: 'repeat' },
  { action: 'acc_decision', target_id: 'd1', executor: 'annie', title: '20022 Cape Clover (WAT-ARC-d1)', decision_type: 'approved_with_conditions', deliver: 'email', withdraw_drafts: ['old1'] },
  { action: 'acc_info_request', target_id: 'd2', executor: 'annie', title: '19906 Juniper Chase (WAT-ARC-d2)', decision_type: 'request_more_info', deliver: 'mail' },
  { action: 'correspondence', target_id: 'm1', executor: 'annie', title: 'Lennar reply', attach_letters_of: [1, 2], depends_on: [1, 2], letters_close_for: ['a1', 'a2'], info_request_for: [] },
];

// Executors that record what they were asked to do, the way the modules register them.
function installExecutors(db, { accStatus = 200 } = {}) {
  const calls = { builder: [], acc: [], draft: [] };
  AA.registerExecutor('builder', {
    async finalize(args) { calls.builder.push(args); const a = db.t.builder_applications.find((x) => x.id === args.applicationId); a.status = args.action === 'approve' ? 'approved' : 'approved_with_conditions'; const r = { id: `resp-${a.id}`, application_id: a.id, decided_at: new Date().toISOString() }; db.t.builder_application_responses.push(r); return { response: r }; },
    async envelope(appId) { return { filename: `${appId}.pdf`, pdfBuffer: Buffer.from(`letter ${appId}`) }; },
    async validate() { return { ok: true }; },
  });
  AA.registerExecutor('acc', {
    async preflight() { return { ok: true, final: true, decided_by: 'annie' }; },
    async finalize(id, body, actor) { calls.acc.push({ id, body, actor }); if (accStatus !== 200) return { status: accStatus, json: { error: 'refused' } }; const d = db.t.acc_decisions.find((x) => x.id === id); if (body.decision_type !== 'request_more_info') d.status = 'decided'; return { status: 200, json: { email: { sent: !!body.send } } }; },
  });
  AA.registerExecutor('draft', {
    async send(id, approver, sha) { calls.draft.push({ id, approver, sha }); const d = db.t.outbound_email_drafts.find((x) => x.id === id); assert.strictEqual(RG.packageHash(d), sha, 'the send echoes the hash of the message as it now stands, letters included'); const at = new Date(Date.now() + 120000).toISOString(); d.policy = { ...(d.policy || {}), scheduled_send: { send_at: at } }; return { status: 202, json: { send_at: at } }; },
  });
  return calls;
}

async function authorized(db, excluded = []) {
  installExecutors(db);
  const pkg = await AA.buildPackage(db, SPEC());
  assert.ok(pkg.ok, pkg.problems.join('; '));
  const a = { id: 'auth-1', scope: 'arc_acc_decisions', status: 'authorized', subject: 'Owner authorization ABCD1234: 5 architectural items', items: pkg.items, owner_email: OWNER,
    requested_at: new Date(Date.now() - 3600e3).toISOString(), expires_at: new Date(Date.now() + 86400e3).toISOString(), authorized_by_user_id: 'ed-uid', authorized_by_email: OWNER,
    authorized_at: new Date().toISOString(), evidence: { internet_message_id: '<r@x>', excluded_items: excluded }, requested_by: 'ai-team:annie', coordinator: 'ai-team:amanda' };
  db.t.owner_authorizations = [a];
  return a;
}

// ---- the reply ---------------------------------------------------------------------------
check('reply: "approved" authorizes everything; "approved except 3 and 7" and street numbers leave items out; a change, a decline or an unclear reply authorizes nothing', () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ n, title: n === 2 ? '8011 Misty Maple Lane, Lot 36' : `item ${n}` }));
  assert.deepStrictEqual(AA.parseReply('Approved', items), { kind: 'approve', excluded: [] });
  assert.deepStrictEqual(AA.parseReply('approved except 3 and 7', items), { kind: 'approve', excluded: [3, 7] });
  assert.deepStrictEqual(AA.parseReply('Approved, excluding items 3, 5 & 6. Thanks', items), { kind: 'approve', excluded: [3, 5, 6] });
  assert.deepStrictEqual(AA.parseReply('approved but not 8011', items), { kind: 'approve', excluded: [2] });
  assert.deepStrictEqual(AA.parseReply('approved, hold 4', items), { kind: 'approve', excluded: [4] });
  assert.strictEqual(AA.parseReply('Approved, but change 4: make the deadline 30 days', items).kind, 'changes');
  assert.strictEqual(AA.parseReply('Do not approve', items).kind, 'decline');
  assert.strictEqual(AA.parseReply('wait', items).kind, 'decline');
  assert.strictEqual(AA.parseReply('approved except 9999', items).kind, 'unclear');
  assert.strictEqual(AA.parseReply('looks good', items).kind, 'unclear');
  assert.strictEqual(AA.parseReply('approved except 1, 2, 3, 4, 5, 6, 7', items).kind, 'decline', 'leaving everything out is not an approval');
});

function replyMessage(req, text) {
  return { message: { from: { emailAddress: { address: OWNER } }, sender: { emailAddress: { address: OWNER } }, subject: 'RE: ' + req.subject, replyText: text, receivedDateTime: new Date().toISOString(),
    internetMessageId: '<reply@x>', id: 'g1', conversationId: 'conv-1' },
    headers: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' }, { name: 'X-MS-Exchange-Organization-AuthSource', value: 'x' }, { name: 'X-MS-Exchange-Organization-AuthMechanism', value: '04' }, { name: 'In-Reply-To', value: '<req@x>' }] };
}
check('verified reply: an ARC/ACC exclusion is recorded in the evidence; a partial approval of any other request is refused instead of executing everything', () => {
  const base = { status: 'requested', request_message_id: '<req@x>', request_conversation_id: 'conv-1', expires_at: new Date(Date.now() + 3600e3).toISOString() };
  const arc = { ...base, id: 'r1', scope: 'arc_acc_decisions', subject: 'Owner authorization AAAA0001: 3 architectural items', items: [{ n: 1, title: 'a' }, { n: 2, title: 'b' }, { n: 3, title: 'c' }] };
  let m = replyMessage(arc, 'approved except 2');
  let v = OA.authorizationFromReply(m.message, { requests: [arc], ownerEmail: OWNER, headers: m.headers });
  assert.ok(v.match, v.why); assert.deepStrictEqual(v.evidence.excluded_items, [2]);
  m = replyMessage(arc, 'change 2: say 30 days');
  v = OA.authorizationFromReply(m.message, { requests: [arc], ownerEmail: OWNER, headers: m.headers });
  assert.ok(!v.match && v.verified && v.changes, 'a verified change request is not an authorization');
  const runs = { ...base, id: 'r2', scope: 'accounting_runs', subject: 'Owner authorization BBBB0002: 2 accounting runs', items: [{ run_id: 'x' }] };
  m = replyMessage(runs, 'approved except the second one');
  v = OA.authorizationFromReply(m.message, { requests: [runs], ownerEmail: OWNER, headers: m.headers });
  assert.ok(!v.match && /whole or not at all/.test(v.why), v.why);
  m = replyMessage(runs, 'approved');
  assert.ok(OA.authorizationFromReply(m.message, { requests: [runs], ownerEmail: OWNER, headers: m.headers }).match, 'a plain approval of a run package still works');
});

// ---- the package -------------------------------------------------------------------------
check('package: items are numbered and fingerprinted; a missing condition, an emailless email item, a decided case and two emails to one person are refused before anything is sent', async () => {
  const db = fakeDb(seed()); installExecutors(db);
  const ok = await AA.buildPackage(db, SPEC());
  assert.ok(ok.ok, ok.problems.join('; '));
  assert.deepStrictEqual(ok.items.map((i) => i.n), [1, 2, 3, 4, 5]);
  assert.ok(ok.items.every((i) => /^[0-9a-f]{64}$/.test(i.fingerprint) && /^ai-team:/.test(i.executor)));
  assert.strictEqual(ok.items[2].decided_by, 'annie');
  const bad = SPEC();
  bad[1].conditions = [];
  bad[3].deliver = 'email';
  bad.push({ action: 'acc_decision', target_id: 'd1', executor: 'annie', title: 'again', decision_type: 'approved', deliver: 'email' });
  db.t.builder_applications[0].status = 'approved';
  const r = await AA.buildPackage(db, bad);
  const p = r.problems.join(' | ');
  assert.ok(!r.ok);
  assert.ok(/2: conditions are required/.test(p), p);
  assert.ok(/4: .*no valid email/.test(p), p);
  assert.ok(/1: .*already approved/.test(p), p);
  assert.ok(/items 3, 6 all email/.test(p), p);
});

check('request email: every item with its decision, executing teammate, basis, conditions and full proposed text; how to approve, leave out or change items', async () => {
  const db = fakeDb(seed()); installExecutors(db);
  const pkg = await AA.buildPackage(db, SPEC());
  const mail = AA.renderRequest({ subject: AA.requestSubject('ABCD1234', pkg.items), shown: pkg.shown, expiresAt: 'Thursday' });
  assert.ok(/^Owner authorization ABCD1234: 5 architectural items \(2 builder, 2 resident, 1 correspondence\)$/.test(mail.subject), mail.subject);
  for (const s of ['approved except 3 and 7', 'change 4', 'Vary the trim color.', 'Dear Owner d1,', 'The approval letters, dated today, are attached.', 'executed by Annie', 'Attaches the decision letters of items 1, 2', 'staff print and mail it', 'Withdraws 1 earlier unsent draft']) assert.ok(mail.html.includes(s) || mail.text.includes(s), s);
  assert.ok(!/\u2014/.test(mail.text), 'no em-dashes');
});

// ---- execution ---------------------------------------------------------------------------
check('execute: builder decisions as the owner by email authorization, ACC through the finalize path, replaced drafts withdrawn, mailed letters get a print-and-mail follow-up, the reply carries every letter', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  const calls = installExecutors(db);
  const out = await AA.executePackage({ supabase: db, sentItems: async () => [] }, a);
  assert.deepStrictEqual(out.results.map((r) => r.status), ['done', 'done', 'done', 'done', 'scheduled']);
  assert.ok(/authorized by email reply, owner authorization auth-1; executed by Annie/.test(calls.builder[0].decided_by), calls.builder[0].decided_by);
  assert.deepStrictEqual(calls.builder[1].conditions, ['Vary the trim color.']);
  assert.strictEqual(calls.acc[0].actor.email, OWNER); assert.strictEqual(calls.acc[0].actor.via.channel, 'owner_authorization');
  assert.strictEqual(calls.acc[0].body.send, true); assert.strictEqual(calls.acc[1].body.send, false, 'the mailed letter is filed, not emailed');
  assert.strictEqual(db.t.outbound_email_drafts.find((d) => d.id === 'old1').status, 'discarded', 'the replaced draft is withdrawn');
  assert.ok(db.t.work_items.some((w) => /Print and mail/.test(w.title) && w.source_ref === 'owner_authorization:auth-1:4:mail'));
  const reply = db.t.outbound_email_drafts.find((d) => d.id === 'm1');
  assert.deepStrictEqual(reply.attachments.map((x) => x.name), ['a1.pdf', 'a2.pdf']);
  assert.strictEqual(reply.policy.owner_authorization.authorization_id, 'auth-1');
  assert.strictEqual(calls.draft[0].approver.via.channel, 'owner_authorization');
  const evs = db.t.authorization_events.map((e) => e.event);
  assert.strictEqual(evs.filter((e) => e === 'executed').length, 4, 'the scheduled reply records when it is actually sent');
});

check('execute: an item left out is never carried out, and the reply that depends on it is held for revision (not sent)', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db, [2]);
  const calls = installExecutors(db);
  const out = await AA.executePackage({ supabase: db, sentItems: async () => [] }, a);
  assert.strictEqual(out.results[1].status, 'excluded');
  assert.strictEqual(out.results[4].status, 'held');
  assert.strictEqual(calls.builder.length, 1); assert.strictEqual(calls.draft.length, 0);
  assert.strictEqual(db.t.builder_applications[1].status, 'received');
  assert.ok(db.t.authorization_events.some((e) => e.event === 'declined'));
  assert.ok(db.t.work_items.some((w) => w.source_ref === 'owner_authorization:auth-1:5' && /revises/.test(w.next_step)));
});

check('execute: a target changed after review, or correspondence already sent / the recipient wrote again, is not sent; Amanda gets the follow-up', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  db.t.acc_decisions[0].letter_body = 'Dear Owner, edited later.';
  db.t.email_messages.push({ id: 'in9', direction: 'inbound', sender_email: 'builder@example.com', received_at: new Date().toISOString(), subject: 'one more thing' });
  const calls = installExecutors(db);
  const out = await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  assert.strictEqual(out.results[2].status, 'failed'); assert.ok(/changed after you reviewed it/.test(out.results[2].detail));
  assert.strictEqual(out.results[4].status, 'superseded'); assert.ok(/wrote again/.test(out.results[4].detail));
  assert.strictEqual(calls.acc.filter((c) => c.id === 'd1').length, 0); assert.strictEqual(calls.draft.length, 0);
  assert.ok(db.t.work_items.some((w) => w.source_ref === 'owner_authorization:auth-1:3'));
  // Sent Items: something already went to the homeowner since the request.
  const db2 = fakeDb(seed()); const a2 = await authorized(db2); const c2 = installExecutors(db2);
  const out2 = await AA.executePackage({ supabase: db2, sentItems: async (to) => (to === 'ownerd1@example.com' ? [{ mailbox: 'info@bedrocktx.com', sent_at: new Date().toISOString(), subject: 'Your application' }] : []) }, a2);
  assert.strictEqual(out2.results[2].status, 'superseded'); assert.ok(/Sent Items/.test(out2.results[2].detail));
  assert.strictEqual(c2.acc.filter((c) => c.id === 'd1').length, 0);
});

check('execute: refuses an authorization that is not the owner\'s, not authorized, or expired', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  await assert.rejects(AA.ownerActor(db, { ...a, status: 'requested' }));
  await assert.rejects(AA.ownerActor(db, { ...a, expires_at: new Date(Date.now() - 1000).toISOString() }));
  await assert.rejects(AA.ownerActor(db, { ...a, authorized_by_email: 'someone@bedrocktx.com' }));
  const actor = await AA.ownerActor(db, a, 'ai-team:annie');
  assert.strictEqual(actor.via.authorization_id, 'auth-1'); assert.strictEqual(actor.via.evidence_message_id, '<r@x>');
});

check('after the reply goes: builder letters stamped, work items closed, the ledger records it, and Amanda verifies and reports once', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  installExecutors(db);
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  const d = db.t.outbound_email_drafts.find((x) => x.id === 'm1');
  d.status = 'sent'; d.sent_at = new Date().toISOString();
  const reports = [];
  // The Draft Queue send calls afterDraftSent; the report goes through the injected sender.
  const orig = AA.verifyAndReport;
  const res = await AA.afterDraftSent(db, d, { sent_at: d.sent_at, message_id: '<sent@x>' });
  void orig;
  assert.ok(db.t.builder_application_responses.every((r) => r.email_sent_at === d.sent_at), 'every letter on the reply is stamped as emailed');
  assert.ok(db.t.authorization_events.some((e) => e.event === 'executed' && e.target_id === 'm1'));
  const again = await AA.verifyAndReport(db, 'auth-1', { send: async (m) => reports.push(m) });
  assert.ok(res && res.complete, 'every item is settled once the reply is sent');
  assert.ok(again.already_reported || again.reported, 'reported exactly once');
});

check('wiring: the action registry, the Tessa reply loop, the ACC finalize path, the builder module and the Draft Queue use the one service; staged drafts cannot be sent around it', () => {
  const act = AZ.actionForScope('arc_acc_decisions');
  assert.ok(act && act.executable && act.supportsExclusions && act.recordsOwnExecution && act.executor === 'ai-team:annie');
  const server = read('server.js');
  assert.ok(/req\._accAgentIssuer \|\| req\._accOwnerAuthorized \|\| await getActingUser\(req\)/.test(server));
  assert.ok(/registerExecutor\('acc'/.test(server) && /owner_preflight/.test(server));
  assert.ok(/registerExecutor\('builder'/.test(read('api/builder_applications.js')) && /finalizeApplicationCore\(args\)/.test(read('api/builder_applications.js')));
  const drafts = read('api/email_drafts.js');
  assert.ok(/registerExecutor\('draft'/.test(drafts) && /awaiting_owner_authorization/.test(drafts) && /afterDraftSent/.test(drafts) && /afterDraftHeld/.test(drafts) && /approver_via/.test(drafts));
  const tessa = read('lib/ea/tessa_inbox.js');
  assert.ok(/arc_acc'\)\.graphSentItems/.test(tessa) && /change_requested/.test(tessa));
  const sql = read('migrations/582_owner_authorized_arc_acc.sql');
  assert.ok(/'conversion_objects', 'accounting_runs', 'arc_acc_decisions'/.test(sql) && /owner_authorization_request_arc_acc/.test(sql) && /GRANT EXECUTE .* TO service_role/.test(sql));
  assert.ok(/via: actor\.via/.test(read('lib/acc/decision_authority.js')), 'the decision record says how the owner\'s decision reached it');
});

check('durable: the completion report goes exactly once, even when several workers finish at the same moment', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  installExecutors(db);
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  const d = db.t.outbound_email_drafts.find((x) => x.id === 'm1'); d.status = 'sent'; d.sent_at = new Date().toISOString();
  const { recordEvents } = require('../lib/authorization/events');
  await recordEvents(db, { authority_kind: 'request', authorization_id: a.id, action_type: 'arc_acc_decision', target_id: 'm1', event: 'executed', executed_by: 'ai-team:annie', result: { ok: true } });
  const reports = [];
  const send = async (m) => { reports.push(m.subject); };
  await Promise.all([AA.verifyAndReport(db, a.id, { send }), AA.verifyAndReport(db, a.id, { send }), AA.verifyAndReport(db, a.id, { send })]);
  await AA.verifyAndReport(db, a.id, { send });   // a restart later
  assert.strictEqual(reports.length, 1, 'one completion report per authorization');
  assert.strictEqual(db.t.owner_authorizations[0].status, 'executed');
});

check('durable: a resumed run never repeats completed work; only system failures are retried', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  let calls = installExecutors(db);
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  const done = calls.builder.length + calls.acc.length;
  // A restart: the run is resumed while the scheduled reply is still pending.
  calls = installExecutors(db);
  const again = await AA.resumePending(db, { sentItems: async () => [] });
  assert.strictEqual(calls.builder.length + calls.acc.length, 0, 'nothing already carried out is carried out again');
  assert.strictEqual(calls.draft.length, 0, 'a scheduled message is not sent a second time');
  assert.ok(done > 0 && again.length === 1);
  assert.ok(AA.isRetryable({ status: 'held', detail: 'not sent: The attachment "x.pdf" no longer matches the version that was reviewed' }));
  assert.ok(AA.isRetryable({ status: 'failed', detail: 'not issued: The final record could not be filed (...)' }));
  assert.ok(!AA.isRetryable({ status: 'superseded', detail: 'not sent: the recipient wrote again' }));
  assert.ok(!AA.isRetryable({ status: 'failed', detail: 'the case or its letter changed after you reviewed it', retryable: false }));
});

check('durable: one runner per authorization; a second worker steps aside while the first holds the lease, and takes over a dead one', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  installExecutors(db);
  db.t.work_items.push({ id: 'lease-1', source_ref: 'owner_authorization_run:auth-1', status: 'in_progress', updated_at: new Date().toISOString() });
  const r = await AA.executePackage({ supabase: db, sentItems: async () => [] }, a);
  assert.ok(r.skipped, 'a live lease means another worker is carrying it out');
  db.t.work_items[0].updated_at = new Date(Date.now() - 3600e3).toISOString();
  const r2 = await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  assert.ok(!r2.skipped && r2.results.length === 5, 'a lease left by a worker that died is taken over');
});

check("durable: Amanda's retry list completes items the owner told her to finish, once", async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  const { recordEvents } = require('../lib/authorization/events');
  await recordEvents(db, { authority_kind: 'request', authorization_id: a.id, action_type: 'arc_acc_decision', target_id: 'd1', event: 'execution_failed', executed_by: 'ai-team:annie', result: { ok: false, status: 'failed', detail: 'not issued: Decision authority required' } });
  db.t.work_items.push({ id: 'lease-1', source_ref: 'owner_authorization_run:auth-1', status: 'waiting', updated_at: new Date().toISOString(), notes: JSON.stringify({ retry: [3] }) });
  const calls = installExecutors(db);
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  assert.strictEqual(calls.acc.filter((c) => c.id === 'd1').length, 1, 'item 3 is carried out on the retry list');
  assert.strictEqual(db.t.work_items.find((w) => w.id === 'lease-1').notes, null, 'the list is consumed');
});

check('file fingerprints hash the raw bytes (the Draft Queue compares them with the stored file)', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  installExecutors(db);
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => ({}) }, a);
  const att = db.t.outbound_email_drafts.find((x) => x.id === 'm1').attachments[0];
  assert.strictEqual(att.sha256, require('crypto').createHash('sha256').update(Buffer.from('letter a1')).digest('hex'));
});

check('a reference to an approval already decided and on record is not a new approval; any other approval statement still is', () => {
  const DA = require('../lib/acc/decision_authority');
  const L = 'We have filed them with your tree removal application, which was approved with conditions on August 10, 2026. Are you asking for approval of new work?';
  assert.strictEqual(DA.grantsApproval(L), true, 'without the record, it reads as an approval');
  assert.strictEqual(DA.grantsApproval(L, { priorApprovalDates: ['2026-08-10'] }), false, 'with the decided approval on record, it is the record');
  assert.strictEqual(DA.grantsApproval(L, { priorApprovalDates: ['2026-08-11'] }), true, 'a date that is not on record still counts');
  assert.strictEqual(DA.grantsApproval('Your application is approved. Your earlier one was approved on August 10, 2026.', { priorApprovalDates: ['2026-08-10'] }), true);
  assert.ok(DA.checkOutboundText(L, { priorApprovalDates: ['2026-08-10'] }).ok);
  assert.ok(/prior_approval_dates/.test(read('server.js')) && /priorApprovalDates/.test(read('lib/email/graph_send.js')) && /prior_approvals/.test(read('lib/acc/owner_preflight.js')));
});

check('the complete ACC record keeps an encrypted or signed PDF whole (embedded, named, fingerprinted) instead of failing the decision', async () => {
  const { buildAccPacket } = require('../lib/acc/packet');
  const { PDFDocument } = require('pdf-lib');
  const letter = await PDFDocument.create(); letter.addPage(); const lb = Buffer.from(await letter.save());
  const bad = Buffer.from('%PDF-1.7\n%encrypted and unreadable\n');
  const pk = await buildAccPacket({ dec: { supporting_docs_storage_paths: ['acc/x/signed.pdf'], photo_storage_paths: [], document_manifest: [{ path: 'acc/x/signed.pdf', filename: 'Signed form.pdf' }] }, letterBuffer: lb, download: async () => bad });
  assert.ok(pk.ok); assert.deepStrictEqual(pk.omitted, []);
  const e = pk.included.find((x) => x.embedded);
  assert.ok(e && /Signed form/.test(e.what) && e.sha256 === require('crypto').createHash('sha256').update(bad).digest('hex'));
  assert.strictEqual((await PDFDocument.load(pk.bytes)).getPageCount(), 2, 'the letter page plus the page naming the embedded original');
});

check("wiring: Tessa acknowledges at once; boot and Amanda's scheduled pass resume authorized work; the release race does not record a failure", () => {
  const tessa = read('lib/ea/tessa_inbox.js');
  assert.ok(tessa.includes('subject: `Received: ${auth.subject}`') && tessa.indexOf('Received: ${auth.subject}') < tessa.indexOf('AZ.executeAuthorized(ctx, auth'), 'the acknowledgment goes before the work runs');
  const server = read('server.js');
  assert.ok(/resumePending\(supabase\)/.test(server) && /second re-arm/.test(server));
  assert.ok(/resumePending\(supabase\)/.test(read('lib/scheduler.js')));
  assert.ok(/rearm: \(\) => rearmScheduled\(\)/.test(read('api/email_drafts.js')));
  assert.ok(read('lib/authorization/arc_acc.js').includes("if (now && now.status === 'sent') return null;"));
});

check('builder decision notices: authorized only for recorded decisions, to the submitter or primary contact of record, and only matching what was decided', () => {
  const DA = require('../lib/acc/decision_authority');
  const apps = [{ reference_number: 'SCR-1', status: 'approved', decided_by: 'Ed', decided_at: '2026-11-27', submitter_email: 'b@lennar.com', builder_company: { primary_contact_email: 'pc@lennar.com' } }];
  const appr = { ok: false, approval: true };
  assert.ok(DA.authorizesBuilderDecisionNotice(apps, appr, ['b@lennar.com']).ok);
  assert.ok(DA.authorizesBuilderDecisionNotice(apps, appr, ['pc@lennar.com']).ok);
  assert.ok(!DA.authorizesBuilderDecisionNotice(apps, appr, ['someone@else.com']).ok, 'a stranger is refused');
  assert.ok(!DA.authorizesBuilderDecisionNotice([{ ...apps[0], decided_by: null }], appr, ['b@lennar.com']).ok, 'an undecided lot is refused');
  assert.ok(!DA.authorizesBuilderDecisionNotice([{ ...apps[0], status: 'received' }], appr, ['b@lennar.com']).ok, 'an approval email for an unapproved lot is refused');
  assert.ok(/builderApplicationIds/.test(read('lib/email/graph_send.js')) && /builderApplicationIds/.test(read('api/email_drafts.js')));
});

check('after the one completion report, an outstanding item finished on Amanda\'s retry list gets one short update, never a second report', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  installExecutors(db);
  a.status = 'executed';
  db.t.work_items.push({ id: 'lease-9', source_ref: 'owner_authorization_run:auth-1', status: 'waiting', updated_at: new Date().toISOString(), notes: JSON.stringify({ retry: [3] }) });
  const sent = [];
  const r = await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async (m) => sent.push(m.subject) }, a);
  assert.ok(!r.skipped);
  assert.ok(sent.length === 1 && /^Update: /.test(sent[0]), JSON.stringify(sent));
  const again = await AA.reportUpdate(db, a, { send: async (m) => sent.push(m.subject) });
  assert.strictEqual(again.updated, false, 'each completed item is reported once');
  assert.strictEqual(db.t.owner_authorizations[0].status, 'executed');
});

check('an item that succeeds on retry closes its failure follow-up, and a mailed letter still gets its own print-and-mail task', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  installExecutors(db, { accStatus: 422 });
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => {} }, a);
  const fu = db.t.work_items.find((w) => w.source_ref === 'owner_authorization:auth-1:4');
  assert.ok(fu && fu.status === 'new', 'the refused item has a follow-up for Amanda');
  installExecutors(db);
  await AA.executePackage({ supabase: db, sentItems: async () => [], sendReport: async () => {} }, a, { retry: [3, 4] });
  assert.strictEqual(fu.status, 'done', 'the follow-up closes once the item is carried out');
  const mail = db.t.work_items.find((w) => w.source_ref === 'owner_authorization:auth-1:4:mail');
  assert.ok(mail && mail.status === 'new' && /^Print and mail/.test(mail.title), 'staff are still told to mail the letter');
});

check('the run lease is settled once nothing is scheduled; it stays open while a message is still waiting to go', async () => {
  const db = fakeDb(seed());
  const a = await authorized(db);
  db.t.work_items.push({ id: 'lease-1', source_ref: 'owner_authorization_run:auth-1', status: 'waiting', notes: null });
  db.t.outbound_email_drafts[0].policy = { scheduled_send: { send_at: 'x' } };
  await AA.settleLease(db, a);
  assert.strictEqual(db.t.work_items[0].status, 'waiting');
  db.t.outbound_email_drafts[0].status = 'sent';
  await AA.settleLease(db, a);
  assert.strictEqual(db.t.work_items[0].status, 'done');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
