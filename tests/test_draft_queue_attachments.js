// tests/test_draft_queue_attachments.js  (Ed 2026-10-16)
// Draft Queue attachment review: GET/DELETE/replace on
// /api/email-drafts/:id/attachments/:index, and /send refusing to go out when a
// listed attachment cannot be read. Runs the REAL routers over HTTP against an
// in-memory database + storage. Nothing is sent: Graph is a counting stub, and
// no network or production service is touched.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const express = require('express');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake-key';

// ---- in-memory Supabase: one shared state for every createClient() ----------
const T = { outbound_email_drafts: [], email_messages: [], staff_document_reviews: [] };
const STORE = new Map();   // `${bucket}/${path}` -> Buffer
function fakeFrom(t) {
  const f = []; let mode = 'select'; let payload = null; let single = false; let lim = null;
  const q = {
    select() { return q; }, order() { return q; }, limit(n) { lim = n; return q; }, range() { return q; },
    eq(c, v) { f.push((r) => r[c] === v); return q; }, is(c, v) { f.push((r) => (r[c] == null) === (v == null)); return q; },
    in(c, v) { f.push((r) => v.includes(r[c])); return q; }, ilike(c, v) { f.push((r) => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return q; },
    or() { return q; }, not() { return q; }, neq(c, v) { f.push((r) => r[c] !== v); return q; },
    update(p) { mode = 'update'; payload = p; return q; }, insert(p) { mode = 'insert'; payload = p; return q; },
    maybeSingle() { single = true; return q; }, single() { single = true; return q; },
    then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
  };
  function exec() {
    const rows = T[t] || (T[t] = []);
    if (mode === 'insert') { const row = { id: crypto.randomUUID(), ...payload }; rows.push(row); return { data: single ? row : [row], error: null }; }
    let out = rows.filter((r) => f.every((p) => p(r)));
    if (mode === 'update') { for (const r of out) Object.assign(r, JSON.parse(JSON.stringify(payload))); }
    if (lim != null) out = out.slice(0, lim);
    const copy = out.map((r) => JSON.parse(JSON.stringify(r)));
    return { data: single ? copy[0] || null : copy, error: null };
  }
  return q;
}
const storageCalls = { upload: [], remove: [] };
function fakeStorage(bucket) {
  return {
    async download(p) {
      const b = STORE.get(`${bucket}/${p}`);
      if (!b) return { data: null, error: { message: 'Object not found' } };
      return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }, error: null };
    },
    async upload(p, buf) { storageCalls.upload.push(`${bucket}/${p}`); STORE.set(`${bucket}/${p}`, Buffer.from(buf)); return { data: { path: p }, error: null }; },
    async remove(paths) { for (const p of paths) { storageCalls.remove.push(`${bucket}/${p}`); STORE.delete(`${bucket}/${p}`); } return { data: [], error: null }; },
  };
}
const fakeClient = { from: fakeFrom, storage: { from: fakeStorage }, auth: { getUser: async () => ({ data: { user: null }, error: { message: 'no' } }) } };
const sbPath = require.resolve('@supabase/supabase-js');
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => fakeClient } };

// ---- staff session: "Bearer staff-token" is a signed-in staffer -------------
const authPath = require.resolve('../api/_require_admin');
const STAFF = { user: { id: 'u-staff' }, role: 'staff', email: 'staff@bedrocktx.com', full_name: 'Test Staff' };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  getAuthedUser: async (req) => (String(req.headers.authorization || '') === 'Bearer staff-token' ? STAFF : null),
  requireAdmin: async () => null, requireStaff: async () => null, requireOwner: async () => null, OWNER_EMAIL: 'owner@example.test',
} };

// ---- Graph: counting stub, never sends ---------------------------------------
const sends = [];
const gsPath = require.resolve('../lib/email/graph_send');
const realGs = require('../lib/email/graph_send');
require.cache[gsPath].exports = { ...realGs,
  isConfigured: () => true,
  sendAs: async (o) => { sends.push(o); return { ok: true }; },
  sendReplyAs: async (o) => { sends.push(o); return { ok: true }; },
};

const router = require('../api/email_drafts');
const QA = require('../lib/email/queued_attachments');

// ---- fixtures ----------------------------------------------------------------
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const DOCX = Buffer.from('PK\u0003\u0004 fake docx bytes for the test');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DRAFT = '11111111-2222-4333-8444-555555555555';
const SHARED_PATH = 'rfp/test-rfp/Test_RFP.pdf';   // a shared stored document (never deleted)
function seed() {
  T.outbound_email_drafts.length = 0; T.email_messages.length = 0; STORE.clear(); sends.length = 0;
  storageCalls.upload.length = 0; storageCalls.remove.length = 0;
  STORE.set(`documents/${SHARED_PATH}`, PDF);
  STORE.set(`documents/email_outbound_attachments/drafts/${DRAFT}/1_Scope.docx`, DOCX);
  T.outbound_email_drafts.push({
    id: DRAFT, status: 'draft', persona: 'claire', draft_kind: 'vendor_outreach', to_email: 'vendor@example.test', subject: 'Test RFP',
    body_text: 'Hello,\n\nPlease see the attached.', community_id: null, community_name: 'Test Community',
    attachments: [
      { storage_path: SHARED_PATH, bucket: 'documents', name: 'Test_RFP.pdf', mime: 'application/pdf', size: PDF.length },
      { storage_path: `email_outbound_attachments/drafts/${DRAFT}/1_Scope.docx`, name: 'Scope.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: DOCX.length },
    ],
  });
}
const draftRow = () => T.outbound_email_drafts.find((d) => d.id === DRAFT);

let base;
const H = { Authorization: 'Bearer staff-token' };
const J = { ...H, 'Content-Type': 'application/json' };
async function call(p, o = {}) { return fetch(base + p, o); }

const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('AUTH: no staff session is refused (403) and returns no bytes', async () => {
  seed();
  for (const hdr of [{}, { Authorization: 'Bearer wrong' }]) {
    const r = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { headers: hdr });
    assert.strictEqual(r.status, 403);
    const j = await r.json(); assert.strictEqual(j.error, 'sign_in_required');
    assert.ok(!r.headers.get('X-Attachment-SHA256'));
  }
  const del = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expect_name: 'Test_RFP.pdf' }) });
  assert.strictEqual(del.status, 403);
  assert.strictEqual(draftRow().attachments.length, 2, 'nothing removed without a session');
});

check('BYTES: the exact stored file comes back, hash matches storage, inline PDF, no storage path leaked', async () => {
  seed();
  const r = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { headers: H });
  assert.strictEqual(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.equals(PDF), 'byte-for-byte the stored file');
  assert.strictEqual(r.headers.get('X-Attachment-SHA256'), sha(STORE.get(`documents/${SHARED_PATH}`)));
  assert.strictEqual(r.headers.get('X-Attachment-Size'), String(PDF.length));
  assert.strictEqual(r.headers.get('Content-Type'), 'application/pdf');
  assert.match(r.headers.get('Content-Disposition'), /^inline; filename="Test_RFP\.pdf"/);
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  const all = JSON.stringify([...r.headers.entries()]);
  assert.ok(!all.includes('rfp/test-rfp') && !all.includes('email_outbound_attachments'), 'no storage path in headers');
  const dl = await call(`/api/email-drafts/${DRAFT}/attachments/0?download=1`, { headers: H });
  assert.match(dl.headers.get('Content-Disposition'), /^attachment;/);
});

check('BYTES: a Word file is served as a download only (never inline)', async () => {
  seed();
  const r = await call(`/api/email-drafts/${DRAFT}/attachments/1`, { headers: H });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('Content-Disposition'), /^attachment; filename="Scope\.docx"/);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(DOCX));
});

check('BOUNDS: bad index, bad draft id, unknown draft are 404', async () => {
  seed();
  assert.strictEqual((await call(`/api/email-drafts/${DRAFT}/attachments/7`, { headers: H })).status, 404);
  assert.strictEqual((await call(`/api/email-drafts/${DRAFT}/attachments/-1`, { headers: H })).status, 404);
  assert.strictEqual((await call(`/api/email-drafts/not-a-uuid/attachments/0`, { headers: H })).status, 404);
  assert.strictEqual((await call(`/api/email-drafts/99999999-2222-4333-8444-555555555555/attachments/0`, { headers: H })).status, 404);
});

check('REMOVE: takes the file off the draft; a shared stored document is NOT deleted from storage', async () => {
  seed();
  const stale = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { method: 'DELETE', headers: J, body: JSON.stringify({ expect_name: 'Scope.docx' }) });
  assert.strictEqual(stale.status, 409, 'name mismatch refuses');
  const r = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { method: 'DELETE', headers: J, body: JSON.stringify({ expect_name: 'Test_RFP.pdf' }) });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.deepStrictEqual(j.attachments.map((a) => a.name), ['Scope.docx']);
  assert.ok(!JSON.stringify(j).includes('storage_path'), 'response never carries storage paths');
  assert.deepStrictEqual(draftRow().attachments.map((a) => a.name), ['Scope.docx']);
  assert.ok(STORE.has(`documents/${SHARED_PATH}`), 'the shared RFP file is untouched');
  assert.strictEqual(storageCalls.remove.length, 0);
});

check('REMOVE: a file the Draft Queue stored for this draft is deleted from storage too', async () => {
  seed();
  const r = await call(`/api/email-drafts/${DRAFT}/attachments/1`, { method: 'DELETE', headers: J, body: JSON.stringify({ expect_name: 'Scope.docx' }) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(draftRow().attachments.map((a) => a.name), ['Test_RFP.pdf']);
  assert.deepStrictEqual(storageCalls.remove, [`documents/email_outbound_attachments/drafts/${DRAFT}/1_Scope.docx`]);
});

check('REPLACE: new file stored under the draft, the draft points at it, and preview serves the new bytes', async () => {
  seed();
  const NEW = Buffer.from('%PDF-1.4\n% replacement RFP v3\n%%EOF\n');
  const fd = new FormData(); fd.append('expect_name', 'Test_RFP.pdf'); fd.append('file', new Blob([NEW], { type: 'application/pdf' }), 'Test_RFP_v3.pdf');
  const r = await call(`/api/email-drafts/${DRAFT}/attachments/0/replace`, { method: 'POST', headers: H, body: fd });
  assert.strictEqual(r.status, 200, await r.clone().text());
  const j = await r.json();
  assert.strictEqual(j.sha256, sha(NEW));
  assert.deepStrictEqual(j.attachments.map((a) => a.name), ['Test_RFP_v3.pdf', 'Scope.docx']);
  const a0 = draftRow().attachments[0];
  assert.ok(a0.storage_path.startsWith(`email_outbound_attachments/drafts/${DRAFT}/`));
  assert.strictEqual(a0.size, NEW.length); assert.strictEqual(a0.mime, 'application/pdf');
  assert.ok(STORE.has(`documents/${SHARED_PATH}`), 'the shared original is not deleted');
  const g = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { headers: H });
  assert.ok(Buffer.from(await g.arrayBuffer()).equals(NEW));
  assert.strictEqual(g.headers.get('X-Attachment-SHA256'), sha(NEW));
});

check('REPLACE/REMOVE: refused on a sent draft', async () => {
  seed(); draftRow().status = 'sent';
  const r = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { method: 'DELETE', headers: J, body: JSON.stringify({ expect_name: 'Test_RFP.pdf' }) });
  assert.strictEqual(r.status, 409);
  const fd = new FormData(); fd.append('expect_name', 'Test_RFP.pdf'); fd.append('file', new Blob([PDF]), 'x.pdf');
  assert.strictEqual((await call(`/api/email-drafts/${DRAFT}/attachments/0/replace`, { method: 'POST', headers: H, body: fd })).status, 409);
  assert.strictEqual(storageCalls.upload.length, 0, 'nothing uploaded for a sent draft');
  assert.strictEqual(draftRow().attachments.length, 2);
});

check('SEND: refuses (409) when a listed attachment is missing; nothing sent, draft stays unsent with the reason', async () => {
  seed();
  STORE.delete(`documents/${SHARED_PATH}`);
  const r = await call(`/api/email-drafts/${DRAFT}/send`, { method: 'POST', headers: J, body: '{}' });
  assert.strictEqual(r.status, 409);
  const j = await r.json();
  assert.strictEqual(j.error, 'attachment_unavailable');
  assert.deepStrictEqual(j.missing, ['Test_RFP.pdf']);
  assert.strictEqual(sends.length, 0, 'Graph was never called');
  assert.strictEqual(draftRow().status, 'draft');
  assert.match(draftRow().send_error, /Not sent\. This attachment could not be read from storage: "Test_RFP\.pdf"/);
  assert.ok(!/—/.test(draftRow().send_error), 'no em dash in Ed-facing text');
});

check('SEND: refuses when an attachment changed after the reviewer opened it', async () => {
  seed();
  const r = await call(`/api/email-drafts/${DRAFT}/send`, { method: 'POST', headers: J, body: JSON.stringify({ reviewed_attachments: [{ index: 0, sha256: sha(Buffer.from('an older version')) }] }) });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).error, 'attachment_changed');
  assert.strictEqual(sends.length, 0); assert.strictEqual(draftRow().status, 'draft');
});

check('SEND: with every file present, Graph gets exactly the bytes the preview served', async () => {
  seed();
  const g = await call(`/api/email-drafts/${DRAFT}/attachments/0`, { headers: H });
  const reviewedSha = g.headers.get('X-Attachment-SHA256');
  const r = await call(`/api/email-drafts/${DRAFT}/send`, { method: 'POST', headers: J, body: JSON.stringify({ reviewed_attachments: [{ index: 0, sha256: reviewedSha }] }) });
  assert.strictEqual(r.status, 200, await r.clone().text());
  assert.strictEqual(sends.length, 1);
  const files = sends[0].attachments.filter((a) => a.name === 'Test_RFP.pdf' || a.name === 'Scope.docx');
  assert.strictEqual(files.length, 2);
  assert.strictEqual(sha(Buffer.from(files[0].contentBytes, 'base64')), reviewedSha);
  assert.ok(Buffer.from(files[1].contentBytes, 'base64').equals(DOCX));
  assert.strictEqual(draftRow().status, 'sent');
});

check('LIB: describe() never exposes storage path or bucket; only PDF and raster images are inline', async () => {
  const d = QA.describe({ storage_path: 'secret/path.pdf', bucket: 'documents', name: 'a.pdf', mime: 'application/pdf', size: 3 }, 0);
  assert.ok(!('storage_path' in d) && !('bucket' in d));
  assert.strictEqual(QA.canInline('application/pdf'), true);
  assert.strictEqual(QA.canInline('image/png'), true);
  for (const m of ['text/html', 'image/svg+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) assert.strictEqual(QA.canInline(m), false, m);
  assert.strictEqual(QA.mimeOf({ name: 'x.PDF', mime: 'application/octet-stream' }), 'application/pdf');
  assert.strictEqual(QA.isDraftOwned(DRAFT, { storage_path: SHARED_PATH }), false);
  assert.strictEqual(QA.isDraftOwned(DRAFT, { storage_path: `email_outbound_attachments/drafts/${DRAFT}/x.pdf` }), true);
  assert.strictEqual(QA.isDraftOwned(DRAFT, { storage_path: `email_outbound_attachments/drafts/${DRAFT}x/x.pdf` }), false);
  assert.match(QA.contentDisposition('Résumé "x".pdf', true), /^inline; filename="R_sum_ _x_\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%22x%22\.pdf$/);
});

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/email-drafts', router);
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass++; console.log('  ok  ', n); }
    catch (e) { fail++; console.log('  FAIL', n, '\n       ', e && e.message); }
  }
  srv.close();
  console.log(`\ndraft_queue_attachments: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
