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
  for (const k of Object.keys(FAIL)) delete FAIL[k];
}
const FAIL = {};      // 'table:op' -> error message (failure injection)
const STORAGE = {};   // path -> Buffer
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
    const f = FAIL[table + ':' + st.op] || FAIL[table + ':*'];
    if (f) return { data: null, error: { message: f } };
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
const fakeSupabase = { from: (t) => query(t), storage: { from: () => ({ upload: async () => ({ error: null }),
  download: async (p) => STORAGE[p] ? { data: { arrayBuffer: async () => STORAGE[p] }, error: null } : { data: null, error: { message: 'not found' } } }) } };
const realSB = require('@supabase/supabase-js');
stub('@supabase/supabase-js', { ...realSB, createClient: () => fakeSupabase });

// ---------------------------------------------------------------- stubs
const OWNER_EMAIL = 'egojara@bedrocktx.com';
const USERS = { owner: { id: 'u1', role: 'admin', email: OWNER_EMAIL, full_name: 'Ed Gojara' }, admin: { id: 'u2', role: 'admin', email: 'other@bedrocktx.com' }, staff: { id: 'u3', role: 'staff', email: 'celina@bedrocktx.com', full_name: 'Celina Ruiz' }, staff2: { id: 'u4', role: 'staff', email: 'jordan@bedrocktx.com', full_name: 'Jordan Lee' } };
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
  fetchAllAttachmentBuffers: async () => Object.assign(mailboxFiles.map((f) => ({ ...f, isPdf: /\.pdf$/i.test(f.filename), isImage: false, isDoc: false, contentType: 'application/pdf' })), mailboxFiles.listError ? { listError: mailboxFiles.listError } : {}) });

let modelHandle = null;   // what Tessa's handler "decides"
const realTessa = require('../lib/ea/tessa');
stub('../lib/ea/tessa', { ...realTessa, handleForwarded: async (a) => modelHandle(a) });

let checkResult = null;
const realDC = require('../lib/ea/document_check');
stub('../lib/ea/document_check', { ...realDC, checkReturnedDocument: async ({ buffer, filename, expect }) => ({ advisory: realDC.normalizeCheck(checkResult, expect), expectSeen: expect, raw_extracted: checkResult, sha256: realDC.sha256(buffer), filename }) });

const filedCalls = [];
const realIntake = require('../lib/contracts/intake');
stub('../lib/contracts/intake', { ...realIntake, fileContractDocument: async (sb, o) => { filedCalls.push(o); const id = uuid(); if (FAIL['storage:upload']) throw Object.assign(new Error(FAIL['storage:upload']), { code: 'storage' }); const fp = 'mc-1/' + o.community_id + '/tax_return/' + realDC.sha256(o.buffer) + '.pdf'; STORAGE[fp] = o.buffer; DB.library_documents.push({ id, management_company_id: 'mc-1', community_id: o.community_id, category: o.category, title: o.title, file_path: fp, file_hash: realDC.sha256(o.buffer), file_name_normalized: 'August Meadows - ' + o.title + '.pdf' }); return { library_document_id: id, file_hash: realDC.sha256(o.buffer), reused: false }; } });

const tasks = [];
stub('../api/mission_control', { upsertAgentTask: async (o) => { const id = uuid(); tasks.push({ id, ...o }); DB.work_items.push({ id, status: 'new', assigned_to: o.assigned_to, notes: null, completed_at: null, source_ref: o.source_ref, library_document_id: o.library_document_id, title: o.title, next_step: o.next_step, why: o.why, evidence_required: o.evidence_required, community_id: o.community_id }); return { id, created: true }; } });

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
  assert.throws(() => D.applyOwnerVerify(steps, { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara' }), /could not prove which association/, 'no association evidence -> Ed must confirm it');
  const conflict = { ...steps, signature: { ...steps.signature, advisory: { verdict: 'uncertain', association_match: false } } };
  assert.throws(() => D.applyOwnerVerify(conflict, { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara' }), /does not match this association/);
  assert.equal(D.applyOwnerVerify(conflict, { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara', associationConfirmed: true }).signature.association_confirmed_by, 'Ed Gojara');
  const proven = { ...steps, signature: { ...steps.signature, advisory: { verdict: 'appears_signed', association_match: true } } };
  const v = D.applyOwnerVerify(proven, { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara' });
  assert.equal(v.signature.state, 'verified'); assert.equal(v.signature.verified_by, 'Ed Gojara'); assert.equal(v.signature.association_confirmed_by, 'document');
  const r = D.applyOwnerVerify(steps, { verdict: 'not_signed', sha256: 'abc', by: 'Ed Gojara' });
  assert.equal(r.signature.state, 'rejected');
  const again = D.applyReceived(r, { inboxId: 'in-3', attachments: ['signed.pdf'] });
  assert.equal(again.changed, true); assert.equal(again.steps.signature.state, 'pending', 'a new document starts the check over');
});
check('ENGINE: file only after verification; assign only after filing; assign a person', () => {
  let { steps } = D.applyReceived(fresh(), { inboxId: 'in-2', attachments: ['DOC000.pdf'] });
  steps = D.applyOwnerVerify(D.applyCheck(steps, { advisory: { association_match: true }, sha256: 'abc' }), { verdict: 'signed', sha256: 'abc', by: 'Ed Gojara' });
  assert.throws(() => D.applyAssigned(steps, { workItemId: 'w', assignedTo: 'Celina Ruiz' }), /File the verified return first/);
  steps = D.applyFiled(steps, { libraryDocumentId: 'doc-1', by: 'Ed Gojara' });
  assert.throws(() => D.applyFiled(steps, { libraryDocumentId: 'doc-2', by: 'Ed' }), /Already filed/);
  assert.throws(() => D.applyAssigned(steps, { workItemId: 'w', assignedTo: 'Tessa' }), /staff member by name/);
  steps = D.applyAssigned(steps, { workItemId: 'w-1', assignedTo: 'Celina Ruiz', by: 'Ed Gojara' });
  assert.equal(D.currentStep(steps), 'mailed'); assert.match(D.nextAction(steps), /Celina Ruiz to confirm/);
});
check('ENGINE: mailing needs an explicit record from the ASSIGNED person: date, method, tracking number for tracked methods', () => {
  const s = { ...fresh(), mail_assigned: { state: 'assigned', work_item_id: 'w-1', assigned_to: 'Celina Ruiz', at: '2026-10-20T15:00:00Z' } };
  const at = new Date('2026-10-21T20:00:00Z');
  const good = { mailed_on: '2026-10-21', method: 'certified_mail', tracking_number: '9407 1112 0620 1234 5678 90' };
  assert.throws(() => D.applyMailingConfirmed(s, { record: good, by: 'Tessa', at }), /named person/);
  assert.throws(() => D.applyMailingConfirmed(s, { record: good, by: 'Jordan Lee', at }), /Only Celina Ruiz/);
  assert.throws(() => D.applyMailingConfirmed(s, { record: { ...good, tracking_number: '' }, by: 'Celina Ruiz', at }), /certified-mail number/);
  assert.throws(() => D.applyMailingConfirmed(s, { record: { ...good, method: 'carrier pigeon' }, by: 'Celina Ruiz', at }), /how it was mailed/);
  assert.throws(() => D.applyMailingConfirmed(s, { record: { ...good, mailed_on: '2026-10-25' }, by: 'Celina Ruiz', at }), /future/);
  assert.throws(() => D.applyMailingConfirmed(s, { record: { ...good, mailed_on: '2026-10-19' }, by: 'Celina Ruiz', at }), /before the task was assigned/);
  assert.throws(() => D.applyMailingConfirmed(s, { record: {}, by: 'Celina Ruiz', at }), /date it was mailed/);
  assert.throws(() => D.applyMailingConfirmed(fresh(), { record: good, by: 'Celina Ruiz', at }), /not been assigned/);
  const ok = D.applyMailingConfirmed(s, { record: good, by: 'celina ruiz', at });
  assert.equal(ok.mailed.state, 'confirmed_by_staff'); assert.equal(ok.mailed.tracking_number, '9407111206201234567890'); assert.equal(ok.mailed.method, 'certified_mail');
  assert.equal(D.applyMailingConfirmed(s, { record: { mailed_on: '2026-10-21', method: 'first_class' }, by: 'Ed Gojara', isOwner: true, at }).mailed.tracking_number, null, 'untracked method, Ed may confirm');
  assert.throws(() => D.applyMailingConfirmed(ok, { record: good, by: 'Celina Ruiz', at }), /already confirmed/);
});
check('ENGINE: a task closed without a mailing record is NOT mailed and alerts Ed', () => {
  const s = { ...fresh(), received: { state: 'received_unverified' }, signature: { state: 'verified' }, filed: { state: 'filed' }, mail_assigned: { state: 'assigned', assigned_to: 'Celina Ruiz', at: '2026-10-20T15:00:00Z' }, meta: { ...fresh().meta, deadline: null } };
  const a = D.dueAlerts(s, { now: '2026-10-21T15:00:00Z', taskClosed: true });
  assert.deepEqual(a.map((x) => x.kind), ['closed_without_mailing_record']); assert.equal(D.currentStep(s), 'mailed');
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
  const E = (r, ein) => realDC.normalizeCheck(r, { form: '1120-H', tax_year: '2025', entity: 'August Meadows Community Association', ein });
  const page = { verdict: 'appears_signed', signature_visible: true, form: '1120-H', tax_year: '2025', entity_name: 'AUGUST MEADOWS COMMUNITY ASSOCIATION', ein: '12-3456789' };
  assert.equal(E(page, '123456789').association_match, true, 'name + EIN match');
  assert.equal(E(page, '98-7654321').association_match, false, 'EIN conflicts'); assert.equal(E(page, '98-7654321').verdict, 'uncertain');
  assert.equal(E({ ...page, ein: '' }, '123456789').association_match, null, 'EIN unreadable: not proven');
  assert.equal(E({ ...page, entity_name: 'Waterview Estates HOA' }, null).association_match, false, 'another association on the page');
  assert.equal(E(page, null).association_match, true, 'no EIN on file: the printed name is the evidence');
  assert.ok(E(page, null).concerns.some((c) => /No EIN is on file/.test(c)));
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
app.use('/api/tessa-mailing', require('../api/tessa_mailing').router);
app.use('/api/documents', require('../api/documents').router);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
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
  assert.equal(r.j.delegation.steps.signature.association_confirmed_by, 'document', 'the printed name proved August Meadows');
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
check("ROUTES: the task's Open link is the mailing page; staff see the instructions and title only, never Ed's email", async () => {
  const w = DB.work_items[0];
  assert.equal(w.action_url, `/app/irs-mailing?task=${w.id}`);
  const r = await call('GET', `/api/tessa-mailing/${w.id}`, 'staff');
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.match(r.j.document.title, /2025 Form 1120-H \(signed\)/); assert.equal(r.j.mailed, null);
  assert.ok(!/Please print, sign and scan|ventanaland|paulgrover|DOC000/i.test(JSON.stringify(r.j)), 'no correspondence, no sender, no source file name');
  assert.ok(r.j.methods.length >= 4 && r.j.methods.every((m, i, a) => !i || a[i - 1].label.localeCompare(m.label) <= 0), 'methods listed alphabetically');
});
check('ROUTES: only the assigned person (or Ed) can open the return or confirm mailing; anyone else is refused', async () => {
  const w = DB.work_items[0];
  for (const [m, p] of [['GET', `/api/tessa-mailing/${w.id}`], ['GET', `/api/tessa-mailing/${w.id}/document`], ['POST', `/api/tessa-mailing/${w.id}/confirm`]]) {
    assert.equal((await call(m, p, 'staff2', m === 'GET' ? undefined : { mailed_on: TODAY, method: 'first_class' })).status, 403, `another staff member ${m} ${p}`);
    assert.equal((await call(m, p, null, m === 'GET' ? undefined : {})).status, 403, `signed out ${m} ${p}`);
  }
  assert.equal((await call('GET', `/api/tessa-mailing/${uuid()}`, 'staff')).status, 404, 'not a mailing task');
  assert.equal(DB.ea_followups.find((x) => x.id === delegationId).steps.mailed.state, 'pending');
});
check('ROUTES: the assignee opens exactly the filed return (and the opening is audited)', async () => {
  const w = DB.work_items[0];
  const r = await fetch(`${base}/api/tessa-mailing/${w.id}/document`, { headers: { 'x-test-user': 'staff' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf'); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), PDF_SIGNED.toString());
  const ev = DB.ea_followup_events.filter((e) => e.event === 'document_opened');
  assert.equal(ev.length, 1); assert.equal(ev[0].actor, 'Celina Ruiz'); assert.equal(ev[0].detail.library_document_id, w.library_document_id);
});
check('ROUTES: closing the Mission Control task without a mailing record is NOT mailed; Tessa tells Ed', async () => {
  const D2 = require('../lib/ea/delegation_store');
  const w = DB.work_items[0];
  Object.assign(w, { status: 'done', completed_at: new Date().toISOString() });
  DB.work_item_events.push({ work_item_id: w.id, event: 'status_changed', actor: 'Celina Ruiz', created_at: new Date().toISOString() });
  const texts = [];
  await D2.tick(fakeSupabase, { textOwner: async (t) => { texts.push(t); return { ok: true }; } });
  const d = DB.ea_followups.find((x) => x.id === delegationId);
  assert.equal(d.steps.mailed.state, 'pending'); assert.notEqual(d.status, 'done');
  assert.ok(texts.some((t) => /nobody recorded the mailing date/.test(t)), texts.join(' | '));
  Object.assign(w, { status: 'new', completed_at: null });
});
check('ROUTES: an incomplete mailing record is refused with every missing piece named; nothing advances', async () => {
  const w = DB.work_items[0];
  const r = await call('POST', `/api/tessa-mailing/${w.id}/confirm`, 'staff', { method: 'certified_mail' });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'bad_mailing_record');
  assert.ok(r.j.errors.some((e) => /date it was mailed/.test(e)) && r.j.errors.some((e) => /certified-mail number/.test(e)), JSON.stringify(r.j.errors));
  assert.equal(DB.ea_followups.find((x) => x.id === delegationId).steps.mailed.state, 'pending');
  assert.equal(DB.ea_followup_events.filter((e) => e.event === 'mailing_confirmed').length, 0);
});
check('ROUTES: the assignee records date, method and certified number: mailed, task closed with evidence, audited', async () => {
  const w = DB.work_items[0];
  const r = await call('POST', `/api/tessa-mailing/${w.id}/confirm`, 'staff', { mailed_on: TODAY, method: 'certified_mail', tracking_number: '9407 1112 0620 1234 5678 90', notes: 'Receipt in the AM tax folder' });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.task_closed, true);
  const d = DB.ea_followups.find((x) => x.id === delegationId);
  assert.equal(d.status, 'done'); assert.equal(d.steps.mailed.by, 'Celina Ruiz'); assert.equal(d.steps.mailed.tracking_number, '9407111206201234567890');
  assert.equal(w.status, 'done'); assert.match(w.notes, /Mailed .* by Celina Ruiz, Certified Mail #9407111206201234567890/);
  const ev = DB.work_item_events.find((e) => e.event === 'closed_by_evidence');
  assert.equal(ev.actor, 'Celina Ruiz'); assert.equal(ev.detail.tracking_number, '9407111206201234567890');
  assert.equal((await call('POST', `/api/tessa-mailing/${w.id}/confirm`, 'staff', { mailed_on: TODAY, method: 'first_class' })).status, 409, 'not twice');
});
check('AUDIT: every step names who authorized it, the exact file approved and filed, and who confirmed mailing', async () => {
  const ev = (await call('GET', `/api/tessa/delegations/${delegationId}/events`, 'owner')).j.events;
  assert.deepEqual(ev.map((e) => e.event), ['delegated', 'document_received', 'document_checked', 'signature_verified', 'filed', 'mailing_assigned', 'document_opened', 'alert_sent', 'mailing_confirmed']);
  const by =Object.fromEntries(ev.map((e) => [e.event, e]));
  assert.equal(by.delegated.actor, 'Ed Gojara'); assert.equal(by.delegated.detail.community_id, AM.id);
  assert.equal(by.document_received.actor, 'tessa'); assert.equal(by.document_received.detail.verified, false);
  assert.equal(by.document_checked.detail.requested_by, 'Ed Gojara'); assert.equal(by.document_checked.detail.sha256, checkedSha); assert.equal(by.document_checked.detail.filename, 'DOC000.pdf');
  assert.equal(by.signature_verified.actor, 'Ed Gojara'); assert.equal(by.signature_verified.detail.sha256, checkedSha); assert.equal(by.signature_verified.detail.association_confirmed_by, 'document');
  assert.equal(by.filed.actor, 'Ed Gojara'); assert.equal(by.filed.detail.file_hash, checkedSha, 'the filed file IS the approved file'); assert.equal(by.filed.detail.category, 'tax_return');
  assert.equal(by.mailing_assigned.actor, 'Ed Gojara'); assert.equal(by.mailing_assigned.detail.assigned_to, 'Celina Ruiz');
  assert.equal(by.document_opened.actor, 'Celina Ruiz');
  assert.equal(by.mailing_confirmed.actor, 'Celina Ruiz'); assert.equal(by.mailing_confirmed.detail.method, 'certified_mail'); assert.equal(by.mailing_confirmed.detail.mailed_on, TODAY);
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

// A delegation advanced to "received" for the failure / association tests.
async function receivedDelegation() {
  reset(); const ed = seed({ ...ED_REQUEST, graph_id: 'g-ed-' + uuid() }); seed({ ...PAUL_REPLY, graph_id: 'g-p-' + uuid() });
  const r = await call('POST', `/api/tessa/inbox/${ed.id}/delegate`, 'owner', { community_id: AM.id, expected_from: 'paulgrover@ventanaland.com', document_label: '2025 Form 1120-H', tax_year: '2025' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return r.j.delegation.id;
}
const stepsOf = (id) => JSON.parse(JSON.stringify(DB.ea_followups.find((x) => x.id === id).steps));
check('ASSOCIATION: a file name is never proof; if the return names another association, Ed must confirm (or it stops)', async () => {
  const id = await receivedDelegation();
  mailboxFiles = [{ filename: 'DOC000.pdf', buffer: PDF_SIGNED }];
  checkResult = { verdict: 'appears_signed', signature_visible: true, form: '1120-H', tax_year: '2025', entity_name: 'Waterview Estates Homeowners Association' };
  const c = await call('POST', `/api/tessa/delegations/${id}/check`, 'owner', {});
  assert.equal(c.j.advisory.association_match, false); assert.equal(c.j.advisory.verdict, 'uncertain');
  const v = await call('POST', `/api/tessa/delegations/${id}/verify`, 'owner', { verdict: 'signed', sha256: c.j.sha256 });
  assert.equal(v.status, 409); assert.equal(v.j.error, 'association_unconfirmed'); assert.equal(stepsOf(id).signature.state, 'checked');
  const ok = await call('POST', `/api/tessa/delegations/${id}/verify`, 'owner', { verdict: 'signed', sha256: c.j.sha256, association_confirmed: true });
  assert.equal(ok.status, 200); assert.equal(ok.j.delegation.steps.signature.association_confirmed_by, 'Ed Gojara');
  const e = DB.ea_followup_events.find((x) => x.event === 'signature_verified');
  assert.equal(e.detail.advisory_association_match, false); assert.equal(e.detail.association_confirmed_by, 'Ed Gojara', 'the override is on the record');
});
check('ASSOCIATION: with an EIN on file, a mismatched EIN on the return blocks the automatic match', async () => {
  const id = await receivedDelegation();
  AM.ein = '12-3456789';
  try {
    mailboxFiles = [{ filename: 'DOC000.pdf', buffer: PDF_SIGNED }];
    checkResult = { verdict: 'appears_signed', signature_visible: true, form: '1120-H', tax_year: '2025', entity_name: 'August Meadows Community Association', ein: '98-7654321' };
    const realCheck = require('../lib/ea/document_check');
    // the route passes the association's EIN to the check
    const c = await call('POST', `/api/tessa/delegations/${id}/check`, 'owner', {});
    assert.equal(c.status, 200, JSON.stringify(c.j));
    assert.equal(c.j.advisory.association_match, false, 'the route compared the EIN on file'); assert.equal(c.j.advisory.verdict, 'uncertain'); void realCheck;
  } finally { delete AM.ein; }
});
check('FAILURE: before migration 537 the delegation routes say so and change nothing', async () => {
  const id = await receivedDelegation(); const before = stepsOf(id);
  FAIL['ea_followups:select'] = 'column ea_followups.kind does not exist';
  const r = await call('GET', '/api/tessa/delegations', 'owner');
  assert.equal(r.status, 409); assert.equal(r.j.error, 'migration_537_required');
  const c = await call('POST', `/api/tessa/delegations/${id}/check`, 'owner', {});
  assert.equal(c.status, 409); assert.equal(c.j.error, 'migration_537_required');
  delete FAIL['ea_followups:select'];
  assert.deepEqual(stepsOf(id), before);
});
check('FAILURE: Tessa\'s mailbox unreadable -> a clear 502, the step does not move', async () => {
  const id = await receivedDelegation(); const before = stepsOf(id);
  const saved = mailboxFiles; mailboxFiles = Object.assign([], { listError: 'attachment list failed (HTTP 403)' });
  const r = await call('POST', `/api/tessa/delegations/${id}/check`, 'owner', {});
  mailboxFiles = saved;
  assert.equal(r.status, 502); assert.equal(r.j.error, 'document_unavailable'); assert.match(r.j.detail, /HTTP 403/);
  assert.deepEqual(stepsOf(id), before); assert.equal(DB.ea_followup_events.filter((e) => e.event === 'document_checked').length, 0);
});
async function verifiedDelegation() {
  const id = await receivedDelegation();
  mailboxFiles = [{ filename: 'DOC000.pdf', buffer: PDF_SIGNED }];
  checkResult = { verdict: 'appears_signed', signature_visible: true, form: '1120-H', tax_year: '2025', entity_name: 'August Meadows Community Association' };
  const c = await call('POST', `/api/tessa/delegations/${id}/check`, 'owner', {});
  await call('POST', `/api/tessa/delegations/${id}/verify`, 'owner', { verdict: 'signed', sha256: c.j.sha256 });
  assert.equal(stepsOf(id).signature.state, 'verified');
  return id;
}
check('FAILURE: a storage write failure files nothing and leaves the return verified-but-unfiled', async () => {
  const id = await verifiedDelegation(); const n = filedCalls.length;
  FAIL['storage:upload'] = 'storage unavailable';
  const r = await call('POST', `/api/tessa/delegations/${id}/file`, 'owner', {});
  delete FAIL['storage:upload'];
  assert.equal(r.status, 502); assert.equal(r.j.error, 'filing_failed'); assert.match(r.j.detail, /Nothing was filed/);
  assert.equal(stepsOf(id).filed.state, 'pending'); assert.equal(DB.ea_followup_events.filter((e) => e.event === 'filed').length, 0);
  assert.equal(filedCalls.length, n + 1, 'it was attempted');
});
check('FAILURE: if the filed return cannot be marked signed + internal-only, it is not counted as filed', async () => {
  const id = await verifiedDelegation();
  FAIL['library_documents:update'] = 'permission denied for table library_documents';
  const r = await call('POST', `/api/tessa/delegations/${id}/file`, 'owner', {});
  delete FAIL['library_documents:update'];
  assert.equal(r.status, 502); assert.equal(r.j.error, 'filing_failed'); assert.equal(stepsOf(id).filed.state, 'pending');
  const retry = await call('POST', `/api/tessa/delegations/${id}/file`, 'owner', {});
  assert.equal(retry.status, 200, 'a retry completes it');
});
check('FAILURE: if the audit entry cannot be written, the step does not advance', async () => {
  const id = await verifiedDelegation();
  FAIL['ea_followup_events:insert'] = 'permission denied for table ea_followup_events';
  const r = await call('POST', `/api/tessa/delegations/${id}/file`, 'owner', {});
  delete FAIL['ea_followup_events:insert'];
  assert.equal(r.status, 500); assert.equal(r.j.error, 'audit_write_failed'); assert.equal(stepsOf(id).filed.state, 'pending');
});
check('FAILURE: the mailing task cannot be created or linked -> nothing is assigned', async () => {
  const id = await verifiedDelegation();
  await call('POST', `/api/tessa/delegations/${id}/file`, 'owner', {});
  FAIL['work_items:update'] = 'permission denied for table work_items';
  const r = await call('POST', `/api/tessa/delegations/${id}/assign-mailing`, 'owner', { assigned_to: 'Celina Ruiz' });
  delete FAIL['work_items:update'];
  assert.equal(r.status, 502); assert.equal(stepsOf(id).mail_assigned.state, 'pending');
});
check('FAILURE: the filed return missing from storage -> the assignee gets a clear error, nothing advances', async () => {
  const id = await verifiedDelegation();
  await call('POST', `/api/tessa/delegations/${id}/file`, 'owner', {});
  await call('POST', `/api/tessa/delegations/${id}/assign-mailing`, 'owner', { assigned_to: 'Celina Ruiz' });
  const w = DB.work_items[DB.work_items.length - 1];
  const doc = DB.library_documents.find((x) => x.id === w.library_document_id);
  const keep = STORAGE[doc.file_path]; delete STORAGE[doc.file_path];
  const r = await call('GET', `/api/tessa-mailing/${w.id}/document`, 'staff');
  STORAGE[doc.file_path] = keep;
  assert.equal(r.status, 502); assert.equal(r.j.error, 'document_unavailable'); assert.equal(DB.ea_followup_events.filter((e) => e.event === 'document_opened').length, 0);
});

// ============================================================ RESTRICTED DOCUMENTS
console.log('Restricted association records');
const BEDROCK_MC = require('../lib/company').BEDROCK_MGMT_CO_ID;
function seedDocs() {
  const mc = BEDROCK_MC || 'mc-1';
  const tax = { id: uuid(), management_company_id: mc, community_id: AM.id, category: 'tax_return', title: '2025 Form 1120-H (signed)', file_path: 'p/tax.pdf', file_name_normalized: 'tax.pdf', status: 'current', uploaded_at: '2026-10-20' };
  const bylaws = { id: uuid(), management_company_id: mc, community_id: AM.id, category: 'bylaws', title: 'Bylaws', file_path: 'p/bylaws.pdf', file_name_normalized: 'bylaws.pdf', status: 'current', uploaded_at: '2026-01-01' };
  DB.library_documents.push(tax, bylaws); STORAGE['p/tax.pdf'] = Buffer.from('%PDF tax'); STORAGE['p/bylaws.pdf'] = Buffer.from('%PDF bylaws');
  return { tax, bylaws };
}
check('RESTRICTED: staff cannot list, open, download or preview a signed tax return in Documents; other documents are unchanged', async () => {
  reset(); const { tax, bylaws } = seedDocs();
  const list = await call('GET', `/api/documents?community_id=${AM.id}&include_legacy=false`, 'staff');
  assert.equal(list.status, 200, JSON.stringify(list.j));
  const ids = JSON.stringify(list.j);
  assert.ok(ids.includes(bylaws.id) && !ids.includes(tax.id), 'listed without the tax return');
  for (const p of [`/api/documents/${tax.id}`, `/api/documents/${tax.id}/download`, `/api/documents/${tax.id}/preview`]) assert.equal((await call('GET', p, 'staff')).status, 404, p);
  assert.equal((await call('GET', `/api/documents/${bylaws.id}`, 'staff')).status, 200);
});
check('RESTRICTED: the owner still sees the tax return in Documents', async () => {
  reset(); const { tax } = seedDocs();
  const list = await call('GET', `/api/documents?community_id=${AM.id}&include_legacy=false`, 'owner');
  assert.ok(JSON.stringify(list.j).includes(tax.id));
  assert.equal((await call('GET', `/api/documents/${tax.id}`, 'owner')).status, 200);
});
check('RESTRICTED: a signed tax return is never attached to an outgoing email from the generic attach path', async () => {
  reset(); const { tax, bylaws } = seedDocs();
  const { getDocAttachment } = require('../lib/email/doc_attachment');
  assert.equal(await getDocAttachment(tax.id), null);
  assert.ok(await getDocAttachment(bylaws.id), 'ordinary documents still attach');
});
check('RESTRICTED: the Communications document search and viewer exclude restricted records', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/email_triage.js'), 'utf8');
  assert.ok(/\.filter\(\(d\) => !isRestricted\(d\)\)/.test(src), 'search filters restricted');
  assert.ok(/require\('\.\.\/lib\/documents\/restricted'\)\.mayOpen\(req, doc\)/.test(src), 'viewer checks restricted');
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
