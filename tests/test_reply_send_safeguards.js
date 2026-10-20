'use strict';
// ============================================================================
// tests/test_reply_send_safeguards.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// Scar: Hugh Durlam's Oct 20 camera-proposal email had an obsolete AI draft in
// Communications (false statements, no PDF) AND the approved reply with the
// verified PDF in the Draft Queue. Either Send would have gone out; both could
// have. Pins, on the REAL routes (POST /api/email-drafts/:id/send,
// POST /api/email-triage/:id/send) and the REAL Graph reply sender:
//   - one reply per inbound email across BOTH paths (atomic claim, migration 539):
//     repeated and simultaneous Sends never send twice;
//   - Communications refuses while a Draft Queue reply waits, and shows it;
//   - the Draft Queue sends exactly the reviewed package (stale approvals refused);
//   - attachments fail closed: missing, changed, or not on the Graph reply;
//   - the threaded reply goes to the reviewed recipients only, in the thread.
//   node tests/test_reply_send_safeguards.js
// ============================================================================
const assert = require('node:assert/strict');
const crypto = require('crypto');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 't'; process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'c'; process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 's';
let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e && e.message); } });
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---- in-memory Supabase: tables + storage; reply_send_claims enforces its PRIMARY KEY ----
const DB = {}; const STORE = {}; let claimsTableMissing = false;
const rows = (t) => (DB[t] = DB[t] || []);
function query(table) {
  const st = { op: 'select', f: [], single: false, payload: null };
  const run = () => {
    if (table === 'reply_send_claims' && claimsTableMissing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.reply_send_claims' in the schema cache" } };
    if (st.op === 'insert') {
      const list = Array.isArray(st.payload) ? st.payload : [st.payload];
      if (table === 'reply_send_claims' && list.some((p) => rows(table).some((r) => r.reply_key === p.reply_key))) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "reply_send_claims_pkey"' } };
      const ins = list.map((p) => ({ id: p.id || crypto.randomUUID(), ...p })); rows(table).push(...ins);
      return { data: st.single ? ins[0] : ins, error: null };
    }
    const hit = rows(table).filter((r) => st.f.every((g) => g(r)));
    if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.payload)); return { data: st.single ? hit[0] || null : hit, error: null }; }
    return { data: st.single ? hit[0] || null : hit, error: null };
  };
  const q = {
    select() { return q; }, insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    eq(c, v) { st.f.push((r) => r[c] === v); return q; }, neq(c, v) { st.f.push((r) => r[c] !== v); return q; }, in(c, v) { st.f.push((r) => v.includes(r[c])); return q; },
    is(c, v) { st.f.push((r) => (r[c] == null) === (v === null)); return q; }, ilike() { return q; }, or() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; },
    order() { return q; }, limit() { return q; }, range() { return q; },
    maybeSingle() { st.single = true; return q; }, single() { st.single = true; return q; },
    then(a, b) { return Promise.resolve(run()).then(a, b); },
  };
  return q;
}
const storage = { from: (bucket) => ({ download: async (p) => {
  const v = STORE[`${bucket}/${p}`];
  if (!v) return { data: null, error: { message: 'Object not found' } };
  return { data: { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) }, error: null };
} }) };
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => ({ from: (t) => query(t), storage, rpc: async () => ({ data: null, error: null }) }) });
// The proofreader fixes 'teh' -> 'the': if it ever ran during a send, the test would see it.
stub('../lib/email/proofread', { proofreadEmailBody: async (t) => ({ text: String(t).replace(/\bteh\b/g, 'the') }) });
stub('../lib/email/graph_attachments', { fetchMessageText: async () => '', fetchMessageRecipients: async () => ({ to: [], cc: [] }), fetchAllAttachmentBuffers: async () => [] });
// Communications is admin-gated (router.use); the test signs in as Ed.
const realAuth = require('../api/_require_admin');
const ED = { user: { id: 'u1' }, role: 'admin', email: 'egojara@bedrocktx.com', full_name: 'Ed Gojara' };
stub('../api/_require_admin', { ...realAuth, getAuthedUser: async () => ED, requireAdmin: async () => ED, requireOwner: async () => ED, requireStaff: async () => ED });

// ---- Graph: record every send; scriptable failures and delay ----
const realGS = require('../lib/email/graph_send');
const calls = []; let graphMode = 'ok'; let graphDelayMs = 0;
stub('../lib/email/graph_send', { ...realGS, isConfigured: () => true,
  sendReplyAs: async (o) => {
    if (graphDelayMs) await new Promise((r) => setTimeout(r, graphDelayMs));
    if (graphMode === 'attach_fail') { const e = new Error('attachment_failed: report.pdf (500)'); e.step = 'attach'; e.preSend = true; throw e; }
    if (graphMode === 'network_drop') throw new Error('socket hang up');
    calls.push({ kind: 'sendReplyAs', ...o }); return { sent: true, recipients: { to: [o.to].filter(Boolean), cc: [] } };
  },
  sendAs: async (o) => { calls.push({ kind: 'sendAs', ...o }); return { ok: true }; } });

const ReplyGuard = require('../lib/email/reply_guard');
const express = require('express');
const app = express(); app.use(express.json({ limit: '2mb' }));
app.use('/api/email-drafts', require('../api/email_drafts'));
app.use('/api/email-triage', require('../api/email_triage').router);
let base;

// ---- the Hugh fixture ----
const HUGH = '23f24791-f236-434b-8c1b-3768b4202753';
const DRAFT = 'e88a2c79-e888-4c49-bc00-35c6d95a9398';
const PDF = Buffer.from('%PDF-1.7 Canyon Gate comparative evaluation, final version');
const PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');
const PATH = 'email_drafts/amanda/x/Canyon-Gate_Evaluation.pdf';
const BODY = 'Hugh,\n\nThank you for forwarding the additional Taylor Security proposals. I\'ve completed the preliminary reevaluation and attached a comparative report.';
function reset() {
  for (const k of Object.keys(DB)) delete DB[k]; for (const k of Object.keys(STORE)) delete STORE[k];
  calls.length = 0; graphMode = 'ok'; graphDelayMs = 0; claimsTableMissing = false;
  STORE[`documents/${PATH}`] = PDF;
  DB.email_messages = [{ id: HUGH, mailbox: 'amandaalbright@bedrocktx.com', graph_id: 'AAMk-hugh-oct20', direction: 'inbound', sender_email: 'president@canyongateatcincoranch.com', sender_name: 'President HOA', subject: 'RE: Camera Proposals', persona: 'amanda', triage_status: 'needs_review', received_at: '2026-10-20T13:30:34Z', recipients: ['amandaalbright@bedrocktx.com'], body_full: 'Amanda, I just had these two proposals come in from Taylor Security.', community_id: 'cg', extracted: { reply_in_draft_queue: { outbound_draft_id: DRAFT } } }];
  DB.outbound_email_drafts = [{ id: DRAFT, persona: 'amanda', from_mailbox: 'amandaalbright@bedrocktx.com', to_email: 'president@canyongateatcincoranch.com', to_name: 'President HOA', cc: null, subject: 'RE: Camera Proposals', body_text: BODY, body_html: null, community_name: 'Canyon Gate at Cinco Ranch', community_id: 'cg',
    attachments: [{ name: 'Canyon-Gate_Evaluation.pdf', mime: 'application/pdf', size: PDF.length, bucket: 'documents', storage_path: PATH, sha256: PDF_SHA }], draft_kind: 'amanda_reply', source_email_ref: HUGH, status: 'draft', created_at: '2026-10-20T17:47:47Z' }];
  DB.reply_send_claims = [];
}
const draftRow = () => DB.outbound_email_drafts.find((d) => d.id === DRAFT);
async function http(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || ''; const j = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, j, headers: r.headers };
}
const sendDQ = (extra) => http('POST', `/api/email-drafts/${DRAFT}/send`, { approved_by: 'egojara@bedrocktx.com', approved_package_sha256: ReplyGuard.packageHash(draftRow()), ...(extra || {}) });
const sendComms = () => http('POST', `/api/email-triage/${HUGH}/send`, { body: 'Hugh, an old inaccurate reply.', to: 'president@canyongateatcincoranch.com', persona: 'amanda' });

// ---- Draft Queue: review surface ----
check('Draft Queue shows the attachment and the package fingerprint; list rows carry both (Amanda\'s outbox)', async () => {
  reset();
  const one = await http('GET', `/api/email-drafts/${DRAFT}`);
  assert.equal(one.status, 200); assert.equal(one.j.draft.package_sha256, ReplyGuard.packageHash(draftRow()));
  assert.equal(one.j.draft.attachments[0].sha256, PDF_SHA);
  const list = await http('GET', '/api/email-drafts?status=draft&persona=amanda');
  const row = list.j.drafts.find((d) => d.id === DRAFT);
  assert.ok(row && row.attachments && row.attachments[0].name === 'Canyon-Gate_Evaluation.pdf', 'list includes attachments');
  assert.equal(row.package_sha256, one.j.draft.package_sha256);
});
check('Draft Queue opens the EXACT attached bytes (sha header), and refuses a changed file', async () => {
  reset();
  const r = await http('GET', `/api/email-drafts/${DRAFT}/attachments/0`);
  assert.equal(r.status, 200); assert.ok(Buffer.compare(r.j, PDF) === 0, 'same bytes'); assert.equal(r.headers.get('x-attachment-sha256'), PDF_SHA);
  assert.match(r.headers.get('content-disposition'), /inline; filename="Canyon-Gate_Evaluation.pdf"/);
  STORE[`documents/${PATH}`] = Buffer.from('%PDF tampered');
  const bad = await http('GET', `/api/email-drafts/${DRAFT}/attachments/0`);
  assert.equal(bad.status, 409); assert.equal(bad.j.error, 'attachment_changed');
});

// ---- the approved send: threaded, exact recipients, PDF attached, once ----
check('approved send: ONE threaded reply in Hugh\'s thread, to Hugh only, no Cc, with the verified PDF', async () => {
  reset();
  const r = await sendDQ();
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(calls.length, 1); const c = calls[0];
  assert.equal(c.kind, 'sendReplyAs'); assert.equal(c.sourceGraphId, 'AAMk-hugh-oct20'); assert.equal(c.sourceMailbox, 'amandaalbright@bedrocktx.com');
  assert.equal(c.from, 'amandaalbright@bedrocktx.com'); assert.equal(c.to, 'president@canyongateatcincoranch.com', 'recipient pinned to the reviewed one'); assert.equal(c.cc, undefined);
  const file = c.attachments.find((a) => a.name === 'Canyon-Gate_Evaluation.pdf');
  assert.ok(file && Buffer.from(file.contentBytes, 'base64').equals(PDF), 'the exact PDF bytes are attached');
  assert.ok(c.html.includes('Thank you for forwarding'), 'the reviewed body');
  assert.equal(draftRow().status, 'sent'); assert.equal(DB.email_messages.find((m) => m.id === HUGH).triage_status, 'handled');
  const claim = DB.reply_send_claims.find((x) => x.reply_key === 'email:' + HUGH);
  assert.equal(claim.status, 'sent'); assert.equal(claim.send_path, 'draft_queue'); assert.equal(claim.package_sha256, ReplyGuard.packageHash(draftRow()));
});
check('repeat Send (either path) after it went out: refused, nothing sent again', async () => {
  reset();
  assert.equal((await sendDQ()).status, 200);
  const again = await http('POST', `/api/email-drafts/${DRAFT}/send`, { approved_package_sha256: ReplyGuard.packageHash(draftRow()) });
  assert.equal(again.status, 409); assert.equal(again.j.error, 'already_sent');
  const comms = await sendComms();
  assert.equal(comms.status, 409); assert.equal(comms.j.error, 'already_replied', JSON.stringify(comms.j));
  assert.equal(calls.length, 1);
});
check('simultaneous Sends of the same reply: exactly one goes out', async () => {
  reset(); graphDelayMs = 60;
  const pkg = ReplyGuard.packageHash(draftRow());
  const [a, b, c] = await Promise.all([0, 1, 2].map(() => http('POST', `/api/email-drafts/${DRAFT}/send`, { approved_package_sha256: pkg })));
  const codes = [a.status, b.status, c.status].sort();
  assert.deepEqual(codes, [200, 409, 409], JSON.stringify([a.j, b.j, c.j]));
  assert.equal(calls.length, 1, 'one Graph send');
  assert.ok([a, b, c].filter((x) => x.status === 409).every((x) => ['send_in_progress', 'already_replied', 'already_sent'].includes(x.j.error)));
});

// ---- Communications vs the waiting Draft Queue reply (the superseded draft) ----
check('Communications refuses a conflicting reply while the Draft Queue reply waits, and points to it', async () => {
  reset();
  const r = await sendComms();
  assert.equal(r.status, 409); assert.equal(r.j.error, 'draft_queue_reply_pending');
  assert.equal(r.j.draft_id, DRAFT); assert.equal(r.j.link, '/admin/draft-queue?id=' + DRAFT);
  assert.equal(calls.length, 0); assert.equal(DB.email_messages.find((m) => m.id === HUGH).triage_status, 'needs_review');
});
check('Communications list marks the email with its waiting Draft Queue reply; the superseded draft is not offered', async () => {
  reset();
  const map = await ReplyGuard.activeDraftsFor({ from: (t) => query(t) }, [HUGH, 'other']);
  assert.equal(map[HUGH].id, DRAFT); assert.equal(map.other, undefined);
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'communications.html'), 'utf8');
  assert.ok(/\$\{m\.pending_draft_queue_reply\?pendingReplyHtml\(m\):m\.extracted&&m\.extracted\.draft\?draftBoxHtml\(/.test(html), 'a waiting reply replaces the inline draft box');
  assert.ok(html.includes('Open reply in Draft Queue') && html.includes("j.error === 'draft_queue_reply_pending'"), 'the Reply button and a refusal both point to the Draft Queue');
  const tr = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'email_triage.js'), 'utf8');
  assert.ok(/pending_draft_queue_reply: pendingReply/.test(tr), 'the inbox payload carries the waiting reply');
});

// ---- stale approvals ----
check('stale approval: an edit after review, or a send without the reviewed fingerprint, is refused', async () => {
  reset();
  const reviewed = ReplyGuard.packageHash(draftRow());
  const missing = await http('POST', `/api/email-drafts/${DRAFT}/send`, {});
  assert.equal(missing.status, 409); assert.equal(missing.j.error, 'approval_package_required');
  draftRow().body_text = BODY + '\n\nP.S. changed after review';
  const stale = await http('POST', `/api/email-drafts/${DRAFT}/send`, { approved_package_sha256: reviewed });
  assert.equal(stale.status, 409); assert.equal(stale.j.error, 'stale_approval');
  draftRow().body_text = BODY; draftRow().cc = 'treasurer@canyongateatcincoranch.com';
  assert.equal((await http('POST', `/api/email-drafts/${DRAFT}/send`, { approved_package_sha256: reviewed })).j.error, 'stale_approval', 'a recipient change is stale too');
  assert.equal(calls.length, 0);
  // Saving on the review screen returns the new fingerprint; that version sends.
  const put = await http('PUT', `/api/email-drafts/${DRAFT}`, { cc: '' });
  assert.equal(put.status, 200); assert.equal(put.j.package_sha256, ReplyGuard.packageHash(draftRow()));
  assert.equal((await http('POST', `/api/email-drafts/${DRAFT}/send`, { approved_package_sha256: put.j.package_sha256 })).status, 200);
  assert.equal(calls.length, 1);
});

// ---- attachments fail closed ----
check('missing attachment: nothing sent, draft kept with the reason, and a later send still works', async () => {
  reset(); delete STORE[`documents/${PATH}`];
  const r = await sendDQ();
  assert.equal(r.status, 502); assert.equal(r.j.error, 'attachment_unavailable');
  assert.equal(calls.length, 0); assert.equal(draftRow().status, 'draft'); assert.match(draftRow().send_error, /could not be loaded/);
  assert.equal(DB.reply_send_claims.length, 0, 'no claim taken before the files were in hand');
  STORE[`documents/${PATH}`] = PDF;
  assert.equal((await sendDQ()).status, 200); assert.equal(calls.length, 1);
});
check('attachment changed since review (bytes or size): nothing sent', async () => {
  reset(); STORE[`documents/${PATH}`] = Buffer.from('%PDF-1.7 an earlier version of the report');
  const r = await sendDQ();
  assert.equal(r.status, 409); assert.equal(r.j.error, 'attachment_changed'); assert.equal(calls.length, 0);
});
check('Graph could not attach the file (before /send): nothing sent, safe to retry', async () => {
  reset(); graphMode = 'attach_fail';
  const r = await sendDQ();
  assert.equal(r.status, 502); assert.equal(calls.length, 0);
  const claim = DB.reply_send_claims[0]; assert.equal(claim.status, 'failed'); assert.equal(claim.uncertain, false);
  graphMode = 'ok';
  assert.equal((await sendDQ()).status, 200); assert.equal(calls.length, 1); assert.equal(DB.reply_send_claims[0].attempts, 2);
});
check('a send that dropped mid-flight is UNCERTAIN: no resend until a person confirms Sent Items', async () => {
  reset(); graphMode = 'network_drop';
  assert.equal((await sendDQ()).status, 502);
  assert.equal(DB.reply_send_claims[0].uncertain, true);
  graphMode = 'ok';
  const blocked = await sendDQ();
  assert.equal(blocked.status, 409); assert.equal(blocked.j.error, 'previous_send_unconfirmed'); assert.equal(blocked.j.needs_confirmation, true);
  const comms = await (async () => { draftRow().status = 'discarded'; const x = await sendComms(); draftRow().status = 'draft'; return x; })();
  assert.equal(comms.j.error, 'previous_send_unconfirmed', 'Communications honors the same guard');
  assert.equal(calls.length, 0);
  assert.equal((await sendDQ({ confirm_after_uncertain: true })).status, 200); assert.equal(calls.length, 1);
});
check('guard not installed (migration 539 not applied): sending pauses, nothing sent', async () => {
  reset(); claimsTableMissing = true;
  const r = await sendDQ();
  assert.equal(r.status, 503); assert.equal(r.j.error, 'send_guard_not_installed'); assert.equal(calls.length, 0);
});

// ---- Communications sends exactly what was approved (Ed 2026-10-20) ----
const OTHER = '6b1f0c2e-1d2a-4b9c-9e1a-0c5d2f7a8b90';
function addOtherEmail(extra) {
  DB.email_messages.push({ id: OTHER, mailbox: 'claire@bedrocktx.com', graph_id: 'AAMk-other', direction: 'inbound', sender_email: 'owner@example.com', sender_name: 'A Homeowner', subject: 'Pool hours', persona: 'claire', triage_status: 'needs_review', received_at: '2026-10-20T12:00:00Z', recipients: ['claire@bedrocktx.com'], body_full: 'What are the pool hours?', extracted: {}, ...(extra || {}) });
}
const sendOther = (body, extra) => http('POST', `/api/email-triage/${OTHER}/send`, { body, to: 'owner@example.com', persona: 'claire', ...(extra || {}) });
check('Communications sends the approved text verbatim: no spelling rewrite during Send', async () => {
  reset(); addOtherEmail();
  const r = await sendOther('Hi, teh pool opens at 9.');
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(calls.length, 1); assert.ok(calls[0].html.includes('teh pool opens'), 'the approved text, unchanged');
  assert.equal(calls[0].to, 'owner@example.com'); assert.equal(calls[0].cc, undefined);
  assert.equal(DB.reply_send_claims.find((c) => c.reply_key === 'email:' + OTHER).send_path, 'communications');
  const again = await sendOther('Hi again.');
  assert.equal(again.status, 409); assert.equal(again.j.error, 'already_replied'); assert.equal(calls.length, 1);
});
check('spelling is checked BEFORE approval: /proofread returns the correction and sends nothing; pages call it first', async () => {
  reset();
  const r = await http('POST', '/api/email-triage/proofread', { body: 'Hi, teh pool opens at 9.' });
  assert.equal(r.status, 200); assert.equal(r.j.text, 'Hi, the pool opens at 9.'); assert.equal(r.j.changed, true);
  assert.equal(calls.length, 0);
  const fs = require('fs'); const p = (f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  const comms = p('public/communications.html');
  const send = comms.slice(comms.indexOf('async function doSend('), comms.indexOf('async function doSend(') + 3000);
  assert.ok(send.indexOf('proofreadBeforeSend(') > -1 && send.indexOf('proofreadBeforeSend(') < send.indexOf('/send`'), 'reply: proofread before the send call');
  assert.ok(/_pf\.changed\)\{\s*_dt\.value = _pf\.text;[\s\S]{0,400}return;/.test(send), 'a correction is shown and nothing is sent');
  assert.ok(/proofreadBeforeSend\(body\);\s*\n\s*if\(_pf\.changed\)\{ document\.getElementById\('nmBody'\)\.value=_pf\.text;/.test(comms), 'compose: same rule');
  assert.ok(/email-triage\/proofread[\s\S]{0,400}ccBody[\s\S]{0,300}return;/.test(p('public/index.html')), 'legacy compose: same rule');
  const api = p('api/email_triage.js');
  assert.equal((api.match(/proofreadEmailBody\(/g) || []).length, 1, 'the only proofread call is the pre-approval /proofread endpoint');
  assert.ok(!/translateForResident\(/.test(api), 'no translation during a send');
});
check('a homeowner who prefers another language: refused (translation must be reviewed first), nothing sent', async () => {
  reset(); addOtherEmail({ resolved_contact_id: 'c-es' }); DB.contacts = [{ id: 'c-es', preferred_language: 'es' }];
  const r = await sendOther('Hi, the pool opens at 9.');
  assert.equal(r.status, 409); assert.equal(r.j.error, 'translation_review_required'); assert.equal(calls.length, 0);
  assert.equal(DB.reply_send_claims.length, 0);
});
check('Communications attachments fail closed: a chosen file that cannot load stops the send', async () => {
  reset(); addOtherEmail();
  const r = await sendOther('Hi, the form is attached.', { attach_uploads: [{ name: 'form.pdf', storage_path: `email_outbound_attachments/${OTHER}/form.pdf`, mime: 'application/pdf' }] });
  assert.equal(r.status, 502); assert.equal(r.j.error, 'attachment_unavailable'); assert.equal(calls.length, 0);
  STORE[`documents/email_outbound_attachments/${OTHER}/form.pdf`] = Buffer.from('%PDF form');
  const ok = await sendOther('Hi, the form is attached.', { attach_uploads: [{ name: 'form.pdf', storage_path: `email_outbound_attachments/${OTHER}/form.pdf`, mime: 'application/pdf' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.ok(calls[0].attachments.some((a) => a.name === 'form.pdf'));
});

// ---- the REAL Graph reply sender: threading + attachments fail closed ----
function graphStub(script) {
  const log = [];
  return { log, fetch: async (url, opt = {}) => {
    const u = String(url); const m = (opt.method || 'GET').toUpperCase(); log.push(`${m} ${u.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/[^/]+/, '')}`);
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body || {}) });
    if (u.includes('login.microsoftonline.com')) return res(200, { access_token: 'tok', expires_in: 3600 });
    if (u.endsWith('/createReply')) return res(201, { id: 'draft-1', body: { content: '<div>quoted Oct 20 thread</div>' } });
    if (m === 'PATCH') { script.patched = JSON.parse(opt.body); return res(200, {}); }
    if (m === 'GET' && u.includes('$select=toRecipients')) return res(200, { toRecipients: (script.patched.toRecipients || []), ccRecipients: script.patched.ccRecipients || [] });
    if (m === 'POST' && /\/attachments$/.test(u)) { if (script.attachThrows) throw new Error('ETIMEDOUT'); return res(script.attachStatus || 201, {}); }
    if (m === 'GET' && u.includes('/attachments?')) return res(200, { value: script.listed || [] });
    if (m === 'DELETE') return res(204, {});
    if (u.endsWith('/send')) return res(202, {});
    return res(404, {});
  } };
}
async function realReply(script) {
  const g = graphStub(script); const realFetch = global.fetch; global.fetch = g.fetch;
  stub('../lib/demo/outbound_guard', { guardOutbound: async () => ({ blocked: false }) });
  try {
    const out = await realGS.sendReplyAs({ from: 'amandaalbright@bedrocktx.com', sourceMailbox: 'amandaalbright@bedrocktx.com', sourceGraphId: 'AAMk-hugh-oct20', to: 'president@canyongateatcincoranch.com',
      html: '<p>Hugh,</p>', attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'headshot.png', isInline: true, contentBytes: 'AA==' }, { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Canyon-Gate_Evaluation.pdf', contentBytes: PDF.toString('base64') }] });
    return { out, log: g.log };
  } catch (e) { return { err: e, log: g.log }; } finally { global.fetch = realFetch; }
}
check('real reply sender: replies IN the thread, to the reviewed recipient, attaches, verifies, then sends once', async () => {
  const r = await realReply({ listed: [{ name: 'Canyon-Gate_Evaluation.pdf', isInline: false }] });
  assert.ok(!r.err, r.err && r.err.message);
  const path = r.log.filter((l) => !l.includes('login.microsoftonline'));
  assert.match(path[0], /^POST \/messages\/AAMk-hugh-oct20\/createReply$/, 'createReply on Hugh\'s message');
  assert.ok(path.some((l) => /^PATCH \/messages\/draft-1$/.test(l)));
  assert.equal(path.filter((l) => /\/send$/.test(l)).length, 1, 'one send');
  assert.ok(path.indexOf(path.find((l) => l.includes('/attachments?'))) < path.indexOf(path.find((l) => /\/send$/.test(l))), 'attachments verified before send');
  assert.deepEqual(r.out.recipients, { to: ['president@canyongateatcincoranch.com'], cc: [] });
});
check('real reply sender: a failed attachment upload deletes the draft and never sends', async () => {
  const r = await realReply({ attachStatus: 500 });
  assert.ok(r.err && r.err.code === 'attachment_failed' && r.err.preSend === true);
  assert.ok(r.log.some((l) => /^DELETE \/messages\/draft-1$/.test(l))); assert.ok(!r.log.some((l) => /\/send$/.test(l)));
});
check('real reply sender: no clear answer from Graph on an attachment (timeout) deletes the draft and never sends', async () => {
  const r = await realReply({ attachThrows: true });
  assert.ok(r.err && r.err.code === 'attachment_failed' && r.err.preSend === true, r.err && r.err.message);
  assert.ok(r.log.some((l) => /^DELETE \/messages\/draft-1$/.test(l))); assert.ok(!r.log.some((l) => /\/send$/.test(l)));
});
check('real reply sender: an attachment missing from the draft afterwards deletes it and never sends', async () => {
  const r = await realReply({ listed: [] });
  assert.ok(r.err && r.err.code === 'attachment_not_on_reply', r.err && r.err.message);
  assert.ok(r.log.some((l) => /^DELETE \/messages\/draft-1$/.test(l))); assert.ok(!r.log.some((l) => /\/send$/.test(l)));
});

(async () => {
  const server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
  for (const p of pending) await p();
  server.closeAllConnections(); server.close();
  console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exitCode = fail ? 1 : 0;
})();
