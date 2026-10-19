'use strict';
// ============================================================================
// tests/test_tessa_delegation.js  (Ed 2026-10-19) — Copied (FYI) + delegated follow-through
// ----------------------------------------------------------------------------
// Fixture: Paul Grover's real thread, read-only (bodies abridged, addresses kept):
//   Oct 15 Ed -> Paul, Cc Tessa, "Tax return", attached the August Meadows 2025
//          Form 1120-H: "print, sign and scan back to me and we will mail it to the IRS".
//   Oct 19 Paul -> Ed, Cc Tessa, "RE: Tax return", DOC000.pdf, no new text.
// Pins:
//   FYI      a Cc row is "Copied (FYI)" (new 'fyi' status, or a legacy untouched
//            'dismissed' row), never an automatic draft; Ed can act on it.
//   ENGINE   who may move each step; an attachment is never assumed signed; only
//            Ed verifies (exact file); only a staff PERSON confirms mailing.
//   ROUTES   the REAL api/tessa.js router over an in-memory database, Graph and
//            the model stubbed: the whole Paul flow, owner-only, nothing sent.
//   PRIVACY  migration 537 locks every Tessa table to the server; the staff task
//            carries no email content.
//   node tests/test_tessa_delegation.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const http = require('http');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 't'; process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'c'; process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 's';

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });
const ROOT = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// ---------------------------------------------------------------- in-memory DB
const DB = {};
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const AM = { id: 'a0000000-0000-4000-8000-0000000000a1', name: 'August Meadows', active: true, management_company_id: 'mc-1' };
function reset() {
  for (const k of Object.keys(DB)) delete DB[k];
  DB.communities = [AM, { id: 'a0000000-0000-4000-8000-0000000000b2', name: 'Canyon Gate', active: true, management_company_id: 'mc-1' }, { id: 'a0000000-0000-4000-8000-0000000000c3', name: 'Waterview', active: true, management_company_id: 'mc-1' }];
  DB.board_members = []; DB.ea_inbox = []; DB.ea_followups = []; DB.ea_followup_events = []; DB.work_items = []; DB.work_item_events = []; DB.library_documents = [];
}
const likeRe = (p) => new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
function query(table) {
  const st = { op: 'select', filters: [], order: null, limit: null, single: false, payload: null, sel: '*', returning: false };
  const rows = () => (DB[table] = DB[table] || []);
  const match = (r) => st.filters.every((f) => f(r));
  const project = (r) => {
    const out = { ...r };
    const m = /(\w+):(\w+)\(([^)]*)\)/.exec(st.sel || '');
    if (m) { const ref = (DB.communities || []).find((c) => c.id === r[m[2]]); out[m[1]] = ref ? { name: ref.name } : null; }
    return out;
  };
  const run = () => {
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => {
        const now = new Date().toISOString();
        const row = { id: uuid(), created_at: now, updated_at: now, ...p };
        if (table === 'ea_inbox' && !['needs_review', 'replied', 'dismissed', 'fyi'].includes(row.status || 'needs_review')) throw Object.assign(new Error('violates check constraint "ea_inbox_status_check"'));
        return row;
      });
      rows().push(...list);
      return { data: st.single ? list[0] : list, error: null };
    }
    if (st.op === 'update') { const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: st.single ? hit[0] || null : hit, error: null }; }
    let out = rows().filter(match);
    if (st.order) out = out.slice().sort((a, b) => (String(a[st.order.col]) < String(b[st.order.col]) ? -1 : 1) * (st.order.asc ? 1 : -1));
    if (st.limit) out = out.slice(0, st.limit);
    out = out.map(project);
    return { data: st.single ? out[0] || null : out, error: null };
  };
  const q = {
    select(s) { if (st.op === 'select') st.sel = s; else st.returning = true; return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return q; }, neq(c, v) { st.filters.push((r) => r[c] !== v); return q; },
    in(c, v) { st.filters.push((r) => v.includes(r[c])); return q; }, ilike(c, v) { const re = likeRe(v); st.filters.push((r) => re.test(String(r[c] || ''))); return q; },
    gte(c, v) { st.filters.push((r) => String(r[c] || '') >= String(v)); return q; }, like() { return q; }, not() { return q; },
    order(c, o = {}) { st.order = { col: c, asc: o.ascending !== false }; return q; }, limit(n) { st.limit = n; return q; },
    maybeSingle() { st.single = true; return q; }, single() { st.single = true; return q; },
    then(res, rej) { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.resolve({ data: null, error: { message: e.message } }).then(res, rej); } },
  };
  return q;
}
const fakeSupabase = { from: (t) => query(t), storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: { message: 'none' } }) }) } };
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => fakeSupabase });

// ---------------------------------------------------------------- stubs
const OWNER_EMAIL = 'egojara@bedrocktx.com';
const USERS = { owner: { id: 'u1', role: 'admin', email: OWNER_EMAIL, full_name: 'Ed Gojara' }, admin: { id: 'u2', role: 'admin', email: 'other@bedrocktx.com' }, staff: { id: 'u3', role: 'staff', email: 'celina@bedrocktx.com', full_name: 'Celina Ruiz' } };
const userFor = (req) => USERS[String(req.headers['x-test-user'] || '')] || null;
const realAuth = require('../api/_require_admin');
stub('../api/_require_admin', { ...realAuth, OWNER_EMAIL, getAuthedUser: async (req) => userFor(req),
  requireOwner: async (req, res) => { const u = userFor(req); if (!u || u.email !== OWNER_EMAIL) { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
  requireAdmin: async (req, res) => { const u = userFor(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
  requireStaff: async (req, res) => { const u = userFor(req); if (!u) { res.status(403).json({ error: 'sign_in_required' }); return null; } return u; } });

const sent = [];
const realGS = require('../lib/email/graph_send');
stub('../lib/email/graph_send', { ...realGS, isConfigured: () => true, getToken: async () => 'tok', sendAs: async (o) => { sent.push(o); return { ok: true }; }, sendReplyAs: async (o) => { sent.push(o); return { ok: true }; } });

const PDF_SIGNED = Buffer.from('%PDF-1.4 signed 1120-H August Meadows 2025');
let mailboxFiles = [];
const realGA = require('../lib/email/graph_attachments');
stub('../lib/email/graph_attachments', { ...realGA,
  fetchAttachmentNames: async () => mailboxFiles.map((f) => f.filename),
  fetchAllAttachmentBuffers: async () => mailboxFiles.map((f) => ({ ...f, isPdf: /\.pdf$/i.test(f.filename), isImage: false, isDoc: false, contentType: 'application/pdf' })) });

let modelHandle = null;   // what Tessa's handler "decides"
const realTessa = require('../lib/ea/tessa');
stub('../lib/ea/tessa', { ...realTessa, handleForwarded: async (a) => modelHandle(a) });

let checkResult = null;
const realDC = require('../lib/ea/document_check');
stub('../lib/ea/document_check', { ...realDC, checkReturnedDocument: async ({ buffer, filename }) => ({ advisory: realDC.normalizeCheck(checkResult, { form: '1120-H', tax_year: '2025', entity: 'August Meadows' }), raw_extracted: checkResult, sha256: realDC.sha256(buffer), filename }) });

const filedCalls = [];
const realIntake = require('../lib/contracts/intake');
stub('../lib/contracts/intake', { ...realIntake, fileContractDocument: async (sb, o) => { filedCalls.push(o); const id = uuid(); DB.library_documents.push({ id, community_id: o.community_id, category: o.category, title: o.title }); return { library_document_id: id, file_hash: realDC.sha256(o.buffer), reused: false }; } });

const tasks = [];
stub('../api/mission_control', { upsertAgentTask: async (o) => { const id = uuid(); tasks.push({ id, ...o }); DB.work_items.push({ id, status: 'new', assigned_to: o.assigned_to, notes: null, completed_at: null }); return { id, created: true }; } });

// ---------------------------------------------------------------- fixtures (Paul, read-only shape)
const ED_REQUEST = { graph_id: 'g-ed-1015', from_email: 'egojara@bedrocktx.com', from_name: 'Ed Gojara', subject: 'Tax return', received_at: '2026-10-15T21:34:43+00:00',
  to_recipients: ['paulgrover@ventanaland.com'], cc_recipients: ['tessa@bedrocktx.com'], addressed_as: 'cc', status: 'dismissed', draft_body: null,
  body_full: 'Hi Paul,\n\nPlease print, sign and scan back to me and we will mail it to the IRS. It is technically due today but if you can get it back to me today or tomorrow, we will send it.',
  attachment_names: ['August_Meadows_Community_Association_2025_Form_1120-H_FINAL.pdf'], conversation_id: 'conv-tax' };
const PAUL_REPLY = { graph_id: 'g-paul-1019', from_email: 'paulgrover@ventanaland.com', from_name: 'paulgrover ventanaland.com', subject: 'RE: Tax return', received_at: '2026-10-19T16:22:34+00:00',
  to_recipients: ['egojara@bedrocktx.com'], cc_recipients: ['tessa@bedrocktx.com'], addressed_as: 'cc', status: 'dismissed', draft_body: null,
  body_full: 'From: Ed Gojara <egojara@bedrocktx.com>\nSent: Thursday, October 15, 2026 4:35 PM\nSubject: Tax return\n\nHi Paul, Please print, sign and scan back...', attachment_names: ['DOC000.pdf'], conversation_id: 'conv-tax' };
const seed = (r) => { const now = '2026-10-19T16:36:07.286Z'; const row = { id: uuid(), created_at: now, updated_at: now, ...r }; DB.ea_inbox.push(row); return row; };

const D = require('../lib/ea/delegation');
const { isCopiedFyi } = require('../lib/ea/tessa_inbox');

// ============================================================ FYI
console.log('Copied (FYI)');
check('FYI: Paul\'s real row (dismissed, Cc, never touched since filed) shows as Copied (FYI)', () => {
  assert.equal(isCopiedFyi({ ...PAUL_REPLY, created_at: '2026-10-19T16:36:07.286252+00:00', updated_at: '2026-10-19T16:36:07.286252+00:00' }), true);
});
check('FYI: the new fyi status is FYI; a To message, a drafted one, or one Ed set aside later is not', () => {
  assert.equal(isCopiedFyi({ status: 'fyi' }), true);
  const base = { ...PAUL_REPLY, created_at: '2026-10-19T16:36:07Z', updated_at: '2026-10-19T16:36:07Z' };
  assert.equal(isCopiedFyi({ ...base, addressed_as: 'to' }), false);
  assert.equal(isCopiedFyi({ ...base, draft_body: 'Hi' }), false);
  assert.equal(isCopiedFyi({ ...base, updated_at: '2026-10-20T09:00:00Z' }), false, 'Ed dismissed it on purpose');
  assert.equal(isCopiedFyi({ ...base, status: 'replied' }), false);
  assert.equal(isCopiedFyi(null), false);
});
check('FYI: ingest still drafts nothing on Cc and now stores it as fyi (with the old-way fallback before 537)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/ea/tessa_inbox.js'), 'utf8');
  assert.ok(/const shouldDraft = addressedAs === 'to';/.test(src), 'Cc never auto-drafts');
  assert.ok(/status: shouldDraft \? 'needs_review' : 'fyi'/.test(src));
  assert.ok(/insert\(\{ \.\.\.row, status: 'dismissed' \}\)/.test(src), 'never lose a message before the migration');
  assert.ok(/attachment_names: m\.hasAttachments \? await attachmentNames\(mailbox, graphId\) : null/.test(src), 'names only, never bytes');
});
check('FYI: a copied message is not counted as "needs your review" in Ed\'s text', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/ea/tessa_inbox.js'), 'utf8');
  assert.ok(/if \(row\.status === 'needs_review'\) \{ stats\.needs_review/.test(src));
});

// ============================================================ ENGINE
console.log('Delegation engine');
const fresh = () => D.newSteps({ requestedBy: 'Ed Gojara', sourceInboxId: 'in-1', sourceSubject: 'Tax return', expectedFrom: 'PaulGrover@ventanaland.com', documentLabel: '2025 Form 1120-H', taxYear: '2025', deadline: '2026-10-15' });
check('ENGINE: Paul\'s reply is recognised: same person, same thread, a PDF', () => {
  const s = fresh();
  assert.equal(D.matchesReturn(s, PAUL_REPLY), true);
  assert.equal(D.matchesReturn(s, { ...PAUL_REPLY, from_email: 'someone@else.com' }), false, 'another sender');
  assert.equal(D.matchesReturn(s, { ...PAUL_REPLY, attachment_names: ['image001.png'] }), false, 'no PDF');
  assert.equal(D.matchesReturn(s, { ...PAUL_REPLY, subject: 'Lunch Friday?' }), false, 'another thread');
  assert.equal(D.matchesReturn({ ...s, meta: { ...s.meta, source_conversation_id: 'conv-tax' } }, { ...PAUL_REPLY, subject: 'Signed copy' }), true, 'same conversation, new subject');
});
check('ENGINE: a returned PDF is RECEIVED, never assumed signed', () => {
  const { steps } = D.applyReceived(fresh(), { inboxId: 'in-2', attachments: PAUL_REPLY.attachment_names, at: PAUL_REPLY.received_at });
  assert.equal(steps.received.state, 'received_unverified'); assert.equal(steps.signature.state, 'pending');
  assert.equal(D.currentStep(steps), 'signature'); assert.match(D.nextAction(steps), /Check it, then confirm/);
});
check('ENGINE: Tessa\'s check is advisory: even "appears signed" leaves the step for Ed', () => {
  let { steps } = D.applyReceived(fresh(), { inboxId: 'in-2', attachments: ['DOC000.pdf'] });
  steps = D.applyCheck(steps, { advisory: { verdict: 'appears_signed' }, sha256: 'abc', filename: 'DOC000.pdf' });
  assert.equal(steps.signature.state, 'checked'); assert.equal(D.currentStep(steps), 'signature');
  assert.throws(() => D.assertCanFile(steps), /confirmed/);
  assert.throws(() => D.applyCheck(fresh(), { advisory: {}, sha256: 'x' }), /Nothing has come back/);
});
check('ENGINE: only a named person verifies, and only the exact file that was checked', () => {
  let { steps } = D.applyReceived(fresh(), { inboxId: 'in-2', attachments: ['DOC000.pdf'] });
  steps = D.applyCheck(steps, { advisory: { verdict: 'appears_signed' }, sha256: 'abc', filename: 'DOC000.pdf' });
  assert.throws(() => D.applyOwnerVerify(steps, { verdict: 'signed', sha256: 'other', by: 'Ed Gojara' }), /not the file/);
  assert.throws(() => D.applyOwnerVerify(steps, { verdict: 'signed', sha256: 'abc', by: 'tessa' }), /named person/);
  assert.throws(() => D.applyOwnerVerify(D.applyReceived(fresh(), { inboxId: 'x', attachments: ['a.pdf'] }).steps, { verdict: 'signed', sha256: 'abc', by: 'Ed' }), /Check the document first/);
  const v = D.applyOwnerVerify(steps, { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara' });
  assert.equal(v.signature.state, 'verified'); assert.equal(v.signature.verified_by, 'Ed Gojara');
  const r = D.applyOwnerVerify(steps, { verdict: 'not_signed', sha256: 'abc', by: 'Ed Gojara' });
  assert.equal(r.signature.state, 'rejected');
  const again = D.applyReceived(r, { inboxId: 'in-3', attachments: ['signed.pdf'] });
  assert.equal(again.changed, true); assert.equal(again.steps.signature.state, 'pending', 'a new document starts the check over');
});
check('ENGINE: file only after verification; assign only after filing; assign a person', () => {
  let { steps } = D.applyReceived(fresh(), { inboxId: 'in-2', attachments: ['DOC000.pdf'] });
  steps = D.applyOwnerVerify(D.applyCheck(steps, { advisory: {}, sha256: 'abc' }), { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara' });
  assert.throws(() => D.applyAssigned(steps, { workItemId: 'w', assignedTo: 'Celina Ruiz' }), /File the verified return first/);
  steps = D.applyFiled(steps, { libraryDocumentId: 'doc-1', by: 'Ed Gojara' });
  assert.throws(() => D.applyFiled(steps, { libraryDocumentId: 'doc-2', by: 'Ed' }), /Already filed/);
  assert.throws(() => D.applyAssigned(steps, { workItemId: 'w', assignedTo: 'Tessa' }), /staff member by name/);
  steps = D.applyAssigned(steps, { workItemId: 'w-1', assignedTo: 'Celina Ruiz', by: 'Ed Gojara' });
  assert.equal(D.currentStep(steps), 'mailed'); assert.match(D.nextAction(steps), /Celina Ruiz to confirm/);
});
check('ENGINE: mailing is confirmed only by the staff person who closed the task, never by Tessa or an agent', () => {
  let s = fresh(); s = { ...s, mail_assigned: { state: 'assigned', work_item_id: 'w-1', assigned_to: 'Celina Ruiz', at: '2026-10-20T15:00:00Z' } };
  assert.equal(D.applyMailedFromTask(s, { task: { status: 'in_progress' }, closedBy: 'Celina Ruiz' }).changed, false);
  assert.equal(D.applyMailedFromTask(s, { task: { status: 'done' }, closedBy: 'agent' }).changed, false);
  assert.equal(D.applyMailedFromTask(s, { task: { status: 'done' }, closedBy: 'Tessa McCall' }).changed, false);
  const ok = D.applyMailedFromTask(s, { task: { status: 'done', completed_at: '2026-10-21T18:00:00Z', notes: 'Certified 9407 1111' }, closedBy: 'Celina Ruiz' });
  assert.equal(ok.changed, true); assert.equal(ok.steps.mailed.state, 'confirmed_by_staff'); assert.equal(ok.steps.mailed.by, 'Celina Ruiz');
});
check('ENGINE: late or stuck alerts Ed, at most once per kind every 48h', () => {
  const s = fresh();
  const a1 = D.dueAlerts(s, { dueDate: '2026-10-16', now: '2026-10-19T15:00:00Z' });
  assert.deepEqual(a1.map((a) => a.kind).sort(), ['deadline', 'return_overdue']);
  const s2 = D.markAlerted(s, a1.map((a) => a.kind), '2026-10-19T15:00:00Z');
  assert.equal(D.dueAlerts(s2, { dueDate: '2026-10-16', now: '2026-10-20T15:00:00Z' }).length, 0, 'not again within 48h');
  assert.equal(D.dueAlerts(s2, { dueDate: '2026-10-16', now: '2026-10-21T16:00:00Z' }).length, 2, 'again after 48h');
  assert.equal(D.dueAlerts(s, { dueDate: '2026-10-30', now: '2026-10-19T15:00:00Z' }).filter((a) => a.kind === 'return_overdue').length, 0, 'not yet due');
  const m = { ...s, received: { state: 'received_unverified' }, signature: { state: 'verified' }, filed: { state: 'filed' }, mail_assigned: { state: 'assigned', assigned_to: 'Celina Ruiz', at: '2026-10-20T15:00:00Z' }, meta: { ...s.meta, deadline: null } };
  assert.equal(D.dueAlerts(m, { now: '2026-10-22T15:00:00Z' }).length, 0, 'mailing within 3 days');
  assert.equal(D.dueAlerts(m, { now: '2026-10-24T15:00:00Z' })[0].kind, 'mailing_overdue');
});
check('CHECK: the model\'s read is downgraded to uncertain when it cannot show a signature or the document does not match', () => {
  const N = (r) => realDC.normalizeCheck(r, { form: '1120-H', tax_year: '2025', entity: 'August Meadows' });
  assert.equal(N({ verdict: 'appears_signed', signature_visible: true, form: 'Form 1120-H', tax_year: '2025', entity_name: 'August Meadows Community Association' }).verdict, 'appears_signed');
  assert.equal(N({ verdict: 'appears_signed', signature_visible: false, form: '1120-H', tax_year: '2025' }).verdict, 'uncertain');
  const y = N({ verdict: 'appears_signed', signature_visible: true, form: '1120-H', tax_year: '2024', entity_name: 'August Meadows' }); assert.equal(y.verdict, 'uncertain'); assert.ok(y.concerns.some((c) => /2024/.test(c)));
  assert.equal(N({ verdict: 'appears_signed', signature_visible: true, form: '1120-H', tax_year: '2025', entity_name: 'Canyon Gate HOA' }).verdict, 'uncertain');
  assert.equal(N({ verdict: 'verified' }).verdict, 'uncertain', 'no other verdicts exist');
  assert.equal(N(null).verdict, 'uncertain');
});
check('PLAN: Tessa never invents a date or a task deadline', () => {
  assert.equal(realTessa.normalizeDelegate({ due_date: '2026-10-16' }, { context: 'please get it back' }).due_date, null);
  assert.equal(realTessa.normalizeDelegate({ due_date: '2026-10-16' }, { context: 'today or tomorrow' }).due_date, '2026-10-16');
  assert.equal(realTessa.normalizeDelegate({ due_date: '2026-02-30' }, { context: 'by 2/30' }).due_date, null);
  assert.equal(realTessa.normalizeDelegate({ tax_year: 'last year' }).tax_year, null);
  assert.equal(realTessa.normalizeFollowup({ title: 'File it', due_date: '2026-11-15' }, { instruction: 'remind me' }).due_date, null);
});

// ============================================================ ROUTES (the Paul flow)
const express = require('express');
const { router } = require('../api/tessa');
const app = express(); app.use('/api/tessa', router);
let base;
async function call(method, p, user, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
console.log('Delegation routes (Paul\'s thread)');
let edRow, paulRow, delegationId, checkedSha;
check('ROUTES: every Tessa inbox and delegation route refuses anyone but the owner', async () => {
  reset(); edRow = seed(ED_REQUEST);
  const id = edRow.id;
  const routes = [['GET', '/api/tessa/inbox?status=all'], ['POST', `/api/tessa/inbox/${id}/handle`], ['POST', `/api/tessa/inbox/${id}/delegate`], ['POST', `/api/tessa/inbox/${id}/followup`],
    ['GET', '/api/tessa/delegations'], ['GET', `/api/tessa/delegations/${id}/events`], ['POST', `/api/tessa/delegations/${id}/check`], ['POST', `/api/tessa/delegations/${id}/verify`],
    ['POST', `/api/tessa/delegations/${id}/file`], ['POST', `/api/tessa/delegations/${id}/assign-mailing`]];
  for (const [m, p] of routes) for (const u of ['staff', 'admin', null]) assert.equal((await call(m, p, u, m === 'GET' ? undefined : {})).status, 403, `${u} ${m} ${p}`);
});
check('ROUTES: the inbox marks both of Paul\'s thread messages Copied (FYI)', async () => {
  reset(); edRow = seed(ED_REQUEST); paulRow = seed(PAUL_REPLY);
  const r = await call('GET', '/api/tessa/inbox?status=all', 'owner');
  assert.equal(r.status, 200); assert.ok(r.j.inbox.every((i) => i.copied_fyi === true));
});
check('ROUTES: "track it to the end" proposes a plan: August Meadows (from the attachment name), Paul, nothing saved yet', async () => {
  modelHandle = async () => ({ action: 'delegate', delegate: { document_label: '2025 Form 1120-H', form: '1120-H', tax_year: '2025', due_date: '2026-10-16', deadline: '2026-10-15' }, subject: '', body: '' });
  const r = await call('POST', `/api/tessa/inbox/${edRow.id}/handle`, 'owner', { instruction: 'Track Paul\'s signed return until it is mailed' });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.action, 'delegate');
  assert.equal(r.j.plan.community.name, 'August Meadows'); assert.equal(r.j.plan.community.how, 'the attachment name');
  assert.equal(r.j.plan.expected_from, 'paulgrover@ventanaland.com');
  assert.equal(DB.ea_followups.length, 0, 'nothing tracked until Ed confirms');
  assert.equal(DB.ea_inbox.find((x) => x.id === edRow.id).status, 'dismissed', 'the email is unchanged');
});
check('ROUTES: Ed confirms; Tessa tracks it and finds Paul\'s Oct 19 reply as RECEIVED (unverified)', async () => {
  const bad = await call('POST', `/api/tessa/inbox/${edRow.id}/delegate`, 'owner', { expected_from: 'paulgrover@ventanaland.com', document_label: '2025 Form 1120-H' });
  assert.equal(bad.status, 400); assert.equal(bad.j.error, 'community_required');
  const r = await call('POST', `/api/tessa/inbox/${edRow.id}/delegate`, 'owner', { community_id: AM.id, expected_from: 'paulgrover@ventanaland.com', document_label: '2025 Form 1120-H', tax_year: '2025', due_date: '2026-10-16', deadline: '2026-10-15' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const d = r.j.delegation; delegationId = d.id;
  assert.equal(d.kind, 'signed_return'); assert.equal(d.community_id, AM.id);
  assert.equal(d.steps.received.state, 'received_unverified'); assert.equal(d.steps.received.inbox_id, paulRow.id);
  assert.deepEqual(d.steps.received.attachments, ['DOC000.pdf']);
  assert.equal(d.current_step, 'signature');
  assert.deepEqual(DB.ea_followup_events.map((e) => e.event), ['delegated', 'document_received']);
  assert.equal((await call('POST', `/api/tessa/inbox/${edRow.id}/delegate`, 'owner', { community_id: AM.id, expected_from: 'paulgrover@ventanaland.com' })).status, 409, 'not twice');
});
check('ROUTES: filing before the signature is confirmed is refused', async () => {
  const r = await call('POST', `/api/tessa/delegations/${delegationId}/file`, 'owner', {});
  assert.equal(r.status, 409); assert.equal(r.j.error, 'not_verified'); assert.equal(filedCalls.length, 0);
});
check('ROUTES: Tessa checks DOC000.pdf: advisory only, with the file fingerprint', async () => {
  mailboxFiles = [{ filename: 'DOC000.pdf', buffer: PDF_SIGNED }];
  checkResult = { verdict: 'appears_signed', signature_visible: true, form: 'Form 1120-H', tax_year: '2025', entity_name: 'August Meadows Community Association', concerns: [] };
  const r = await call('POST', `/api/tessa/delegations/${delegationId}/check`, 'owner', {});
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.advisory.verdict, 'appears_signed'); checkedSha = r.j.sha256;
  assert.equal(r.j.delegation.steps.signature.state, 'checked'); assert.equal(r.j.delegation.current_step, 'signature', 'still Ed\'s call');
});
check('ROUTES: Ed confirms on the exact file (a different fingerprint is refused)', async () => {
  assert.equal((await call('POST', `/api/tessa/delegations/${delegationId}/verify`, 'owner', { verdict: 'signed', sha256: 'deadbeef' })).status, 409);
  const r = await call('POST', `/api/tessa/delegations/${delegationId}/verify`, 'owner', { verdict: 'signed', sha256: checkedSha });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.delegation.steps.signature.verified_by, 'Ed Gojara');
});
check('ROUTES: filing refuses a file that changed in the mailbox since Ed verified it', async () => {
  mailboxFiles = [{ filename: 'DOC000.pdf', buffer: Buffer.from('%PDF different bytes') }];
  const r = await call('POST', `/api/tessa/delegations/${delegationId}/file`, 'owner', {});
  assert.equal(r.status, 409); assert.equal(r.j.error, 'hash_mismatch'); assert.equal(filedCalls.length, 0);
  mailboxFiles = [{ filename: 'DOC000.pdf', buffer: PDF_SIGNED }];
});
check('ROUTES: the verified return is filed in August Meadows\' tax records, signed, internal only', async () => {
  const r = await call('POST', `/api/tessa/delegations/${delegationId}/file`, 'owner', {});
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(filedCalls.length, 1); assert.equal(filedCalls[0].community_id, AM.id); assert.equal(filedCalls[0].category, 'tax_return');
  assert.match(filedCalls[0].title, /2025 Form 1120-H \(signed\)/);
  const doc = DB.library_documents.find((x) => x.id === r.j.library_document_id);
  assert.equal(doc.approval_status, 'signed'); assert.equal(doc.member_scope, 'internal_only'); assert.equal(doc.period_label, '2025');
  assert.equal(r.j.delegation.current_step, 'mail_assigned');
});
check('ROUTES: Ed assigns a staff member; the task links the filed return and carries no email content', async () => {
  assert.equal((await call('POST', `/api/tessa/delegations/${delegationId}/assign-mailing`, 'owner', { assigned_to: 'Tessa' })).status, 400, 'not Tessa');
  assert.equal(tasks.length, 0, 'validated before any task exists');
  const r = await call('POST', `/api/tessa/delegations/${delegationId}/assign-mailing`, 'owner', { assigned_to: 'Celina Ruiz' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const t = tasks[0];
  assert.equal(t.assigned_to, 'Celina Ruiz'); assert.equal(t.community_id, AM.id); assert.equal(t.source_ref, `tessa:delegation:${delegationId}:mail`);
  assert.ok(t.library_document_id); assert.match(t.title, /Print and mail August Meadows 2025 Form 1120-H to the IRS/); assert.match(t.evidence_required, /Mailed date/);
  const blob = JSON.stringify(t);
  assert.ok(!/Please print, sign and scan|ventanaland|paulgrover/i.test(blob), 'the staff task carries none of Ed\'s correspondence');
  assert.equal(r.j.delegation.steps.mailed.state, 'pending', 'assigning is not mailing');
});
check('ROUTES: the tick confirms mailing only when a PERSON closed the task, and audits it', async () => {
  const D2 = require('../lib/ea/delegation_store');
  const w = DB.work_items[0];
  Object.assign(w, { status: 'done', completed_at: '2026-10-21T18:00:00Z', notes: 'Mailed certified, 9407 1111 2222' });
  DB.work_item_events.push({ work_item_id: w.id, event: 'status_changed', actor: 'agent', created_at: '2026-10-21T18:00:00Z' });
  let out = await D2.tick(fakeSupabase, { now: new Date('2026-10-21T19:00:00Z') });
  assert.equal(out.mailed_confirmed, 0, 'an agent closing it is not mailing');
  DB.work_item_events.push({ work_item_id: w.id, event: 'status_changed', actor: 'Celina Ruiz', created_at: '2026-10-21T18:05:00Z' });
  out = await D2.tick(fakeSupabase, { now: new Date('2026-10-21T19:00:00Z') });
  assert.equal(out.mailed_confirmed, 1);
  const d = DB.ea_followups.find((x) => x.id === delegationId);
  assert.equal(d.status, 'done'); assert.equal(d.steps.mailed.by, 'Celina Ruiz'); assert.match(d.steps.mailed.notes, /certified/);
  assert.deepEqual(DB.ea_followup_events.map((e) => e.event), ['delegated', 'document_received', 'document_checked', 'signature_verified', 'filed', 'mailing_assigned', 'mailing_confirmed']);
  const ev = await call('GET', `/api/tessa/delegations/${delegationId}/events`, 'owner');
  assert.equal(ev.j.events.length, 7);
});
check('ROUTES: an overdue return texts Ed once (the tick sends nothing else)', async () => {
  reset(); const row = seed({ ...ED_REQUEST, graph_id: 'g2' });
  await call('POST', `/api/tessa/inbox/${row.id}/delegate`, 'owner', { community_id: AM.id, expected_from: 'paulgrover@ventanaland.com', document_label: '2025 Form 1120-H', due_date: '2026-10-16' });
  const texts = [];
  const D2 = require('../lib/ea/delegation_store');
  await D2.tick(fakeSupabase, { now: new Date('2026-10-19T15:00:00Z'), textOwner: async (t) => { texts.push(t); return { ok: true }; } });
  await D2.tick(fakeSupabase, { now: new Date('2026-10-19T18:00:00Z'), textOwner: async (t) => { texts.push(t); return { ok: true }; } });
  assert.equal(texts.length, 1); assert.match(texts[0], /expected by 2026-10-16/);
});
check('ROUTES: the whole flow sent no email', () => { assert.equal(sent.length, 0); });
check('ROUTES: a follow-up proposal is saved only when Ed adds it, with the source email named', async () => {
  reset(); const row = seed(PAUL_REPLY);
  modelHandle = async () => ({ action: 'followup', followup: { title: 'Mail the 1120-H', detail: '', due_date: null, waiting_on: null, category: 'admin' }, subject: '', body: '' });
  const h = await call('POST', `/api/tessa/inbox/${row.id}/handle`, 'owner', { instruction: 'remind me to mail it' });
  assert.equal(h.j.action, 'followup'); assert.equal(DB.ea_followups.length, 0);
  const a = await call('POST', `/api/tessa/inbox/${row.id}/followup`, 'owner', { title: 'Mail the 1120-H', category: 'admin', due_date: '2026-10-22' });
  assert.equal(a.status, 200, JSON.stringify(a.j)); assert.match(DB.ea_followups[0].detail, /RE: Tax return/); assert.equal(DB.ea_followups[0].due_date, '2026-10-22');
});
check('ROUTES: asking for a reply on a copied email makes it a draft for review (still nothing sent)', async () => {
  reset(); const row = seed(PAUL_REPLY);
  modelHandle = async () => ({ action: 'reply', subject: 'Re: Tax return', body: 'Hi Paul, thank you. We have it.', mode: 'tessa' });
  const r = await call('POST', `/api/tessa/inbox/${row.id}/handle`, 'owner', { instruction: 'thank him' });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.status, 'needs_review');
  assert.equal(DB.ea_inbox[0].status, 'needs_review'); assert.equal(sent.length, 0);
});

// ============================================================ PRIVACY
console.log('Privacy');
check('PRIVACY: migration 537 revokes anon/authenticated and enables RLS (no policies) on all eight Tessa tables', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'migrations/537_tessa_copied_fyi_private.sql'), 'utf8');
  for (const t of ['ea_inbox', 'ea_followups', 'ea_contacts', 'ea_standing_tasks', 'tessa_outbox', 'ea_email_events', 'ea_contact_email_history', 'ea_followup_events']) {
    assert.ok(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`).test(sql), `${t} RLS`);
    assert.ok(new RegExp(`REVOKE ALL ON [^;]*\\b${t}\\b[^;]*FROM anon, authenticated`).test(sql), `${t} revoke`);
  }
  assert.ok(!/CREATE POLICY/i.test(sql)); assert.ok(/REVOKE UPDATE, DELETE, TRUNCATE ON ea_followup_events FROM service_role/.test(sql), 'audit is append-only');
});
check('PRIVACY: no page reads a Tessa table directly (everything goes through owner-only routes)', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((x) => /\.(html|js)$/.test(x))) {
    const s = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    assert.ok(!/from\(\s*['"](ea_inbox|ea_followups|ea_followup_events|ea_contacts|ea_standing_tasks|tessa_outbox)['"]/.test(s), f);
  }
});
check('PAGE: copied items render as "Copied (FYI)" with an instruction box, not a dead "dismissed" line', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/tessa.html'), 'utf8');
  assert.ok(/if\(it\.copied_fyi\) return ibFyiCard\(it\);/.test(h));
  assert.ok(/Copied \(FYI\)/.test(h)); assert.ok(/id="ib-instr-\$\{it\.id\}" placeholder="What should Tessa do with this\?"/.test(h));
  assert.ok(/Delegated to Tessa/.test(h) && /dlLoad\(\);/.test(h));
});

(async () => {
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  for (const t of pending) await t();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
