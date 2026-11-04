'use strict';
// ============================================================================
// tests/test_rfp_download_read_only.js  (Ed 2026-10-20) — an RFP download never writes
// ----------------------------------------------------------------------------
// Production had three shapes of stored RFP (read-only survey 2026-10-20):
//   legacy scopeItems documents (most), the Canyon Gate camera RFP 9857e2cc
//   (schema trusted.rfp.v2, versions 1-3 with hashes and an audit trail), the 2027
//   Landscape RFP e01a0001 (its own structured shape), and old rows with none.
// The old route regenerated with the model and UPDATED structured_rfp for every shape
// but the first. Pins: every branch only reads; nothing calls the model; the stored
// document (and its audit/version history) is byte-for-byte unchanged; the legacy
// Word download still works; every refusal says why and that nothing changed.
//   node tests/test_rfp_download_read_only.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const { decideRfpDownload, makeRfpDownloadHandler } = require('../lib/vendors/rfp_download');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });

// ---- production-shaped fixtures (content abridged; shapes and keys as stored) ----
const LEGACY = { id: '070ef99d-0000-4000-8000-000000000001', community: 'Lakes of Pine Forest', vendor_type: 'Landscaping', structured_rfp: { title: 'RFP', scopeItems: [{ item: 'Mowing', frequency: 'Weekly' }] } };
const CAMERA_V2 = { id: '9857e2cc-766b-450a-815a-c574e7572643', community: 'Canyon Gate at Cinco Ranch', vendor_type: 'Security', structured_rfp: {
  schema: 'trusted.rfp.v2', version: 3, title: 'Request for Proposals: Security Camera System Replacement and Expansion', document_status: 'draft_for_review',
  content_sha256: '0adf447227f5c5302cb9a95a485d0816d65145dfb6bd832917301c1fac89a121',
  audit: [
    { at: '2026-10-16T19:29:59.410Z', by: 'scripts/save_rfp_document.js', action: 'rfp_drafted', version: 1, content_sha256: '42e5dda86e5d23b418bb0bf696953f12403f73bb90dd2a40a46871a6ae7ac66e', previous_sha256: null },
    { at: '2026-10-16T19:40:16.419Z', by: 'scripts/save_rfp_document.js', action: 'rfp_redrafted', version: 2, content_sha256: '868d45d9a95a7d7ab2abb1be5622d124f48bcdbd05161703a79fb662a1010490', previous_sha256: '42e5dda86e5d23b418bb0bf696953f12403f73bb90dd2a40a46871a6ae7ac66e' },
    { at: '2026-10-16T20:30:27.646Z', by: 'scripts/save_rfp_document.js', action: 'rfp_redrafted', version: 3, content_sha256: '0adf447227f5c5302cb9a95a485d0816d65145dfb6bd832917301c1fac89a121', previous_sha256: '868d45d9a95a7d7ab2abb1be5622d124f48bcdbd05161703a79fb662a1010490' },
  ], sections: [{ heading: 'Scope' }], camera_schedule: [], compliance_matrix: [], clarification_items: [] } };
const LANDSCAPE = { id: 'e01a0001-0000-4000-8000-000000000003', community: 'Waterview Estates', vendor_type: 'Landscape', structured_rfp: { summary: '2027 Landscape Maintenance Services', reporting: {}, evaluation: { criteria: [] }, submission: {}, performance: {} } };
const NONE = { id: 'ceca75ad-0000-4000-8000-000000000004', community: 'Waterview Estates', vendor_type: 'Pool', structured_rfp: null, scope_summary: 'Pool management scope' };
const EMPTY = { ...NONE, id: 'f4c14260-0000-4000-8000-000000000005', structured_rfp: {} };
const ROWS = Object.fromEntries([LEGACY, CAMERA_V2, LANDSCAPE, NONE, EMPTY].map((r) => [r.id, r]));

// ---- a database that records EVERY operation ----
function fakeSupabase({ failRead = false } = {}) {
  const ops = [];
  const sb = {
    ops,
    from(table) {
      const st = { table, op: 'select', id: null };
      const q = {
        select() { return q; }, eq(c, v) { if (c === 'id') st.id = v; return q; },
        insert() { st.op = 'insert'; return q; }, update() { st.op = 'update'; return q; }, upsert() { st.op = 'upsert'; return q; }, delete() { st.op = 'delete'; return q; },
        maybeSingle() { return q; }, single() { return q; },
        then(res, rej) { ops.push({ table, op: st.op }); if (failRead) return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res, rej);
          return Promise.resolve({ data: st.op === 'select' ? (ROWS[st.id] || null) : null, error: null }).then(res, rej); },
      };
      return q;
    },
    storage: { from() { ops.push({ table: 'storage', op: 'any' }); return { upload: async () => ({}), remove: async () => ({}) }; } },
  };
  return sb;
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, send(b) { r.body = b; return r; } };
  return r;
}
const quiet = { error() {}, warn() {}, log() {} };
async function download(id, opts = {}) {
  const sb = fakeSupabase(opts); const renders = [];
  const generateDocx = opts.generateDocx || (async (s) => { renders.push(s); return Buffer.from('DOCX'); });
  const res = fakeRes();
  await makeRfpDownloadHandler({ supabase: sb, generateDocx, log: quiet })({ params: { bidRequestId: id } }, res);
  return { res, ops: sb.ops, renders };
}
const onlyReads = (ops) => ops.every((o) => o.table === 'bid_requests' && o.op === 'select');

console.log('RFP download is read-only');
check('LEGACY: a stored scopeItems document still downloads as Word, rendered from the stored document, with reads only', async () => {
  const { res, ops, renders } = await download(LEGACY.id);
  assert.equal(res.statusCode, 200); assert.match(res.headers['content-type'], /wordprocessingml/); assert.match(res.headers['content-disposition'], /Lakes_of_Pine_Forest_RFP_Landscaping\.docx/);
  assert.equal(renders.length, 1); assert.equal(renders[0], LEGACY.structured_rfp, 'the stored object itself, not a regenerated one');
  assert.ok(onlyReads(ops), JSON.stringify(ops));
});
check('CANYON GATE v2: refused (409) with a plain reason; nothing written; nothing rendered or regenerated', async () => {
  const before = JSON.parse(JSON.stringify(CAMERA_V2.structured_rfp));
  const { res, ops, renders } = await download(CAMERA_V2.id);
  assert.equal(res.statusCode, 409); assert.equal(res.body.error, 'stored_document_not_downloadable_here');
  assert.match(res.body.detail, /structured RFP document/); assert.match(res.body.detail, /Nothing was changed/);
  assert.ok(onlyReads(ops), JSON.stringify(ops)); assert.equal(renders.length, 0);
  assert.deepEqual(CAMERA_V2.structured_rfp, before, 'version history and audit trail untouched');
  assert.equal(CAMERA_V2.structured_rfp.audit.length, 3); assert.equal(CAMERA_V2.structured_rfp.content_sha256, before.content_sha256);
});
check('LANDSCAPE (another structured shape): refused, nothing written (the old route would have overwritten it too)', async () => {
  const before = JSON.parse(JSON.stringify(LANDSCAPE.structured_rfp));
  const { res, ops } = await download(LANDSCAPE.id);
  assert.equal(res.statusCode, 409); assert.match(res.body.detail, /newer format/); assert.ok(onlyReads(ops));
  assert.deepEqual(LANDSCAPE.structured_rfp, before);
});
check('NO STORED DOCUMENT (null or {}): refused; a download never creates one', async () => {
  for (const id of [NONE.id, EMPTY.id]) {
    const { res, ops, renders } = await download(id);
    assert.equal(res.statusCode, 409, id); assert.equal(res.body.error, 'no_stored_document'); assert.match(res.body.detail, /never creates one/);
    assert.ok(onlyReads(ops)); assert.equal(renders.length, 0);
  }
});
check('ERRORS: unknown id 404, read failure 500, render failure 500; never a write', async () => {
  const a = await download('00000000-0000-4000-8000-00000000dead'); assert.equal(a.res.statusCode, 404); assert.ok(onlyReads(a.ops));
  const b = await download(LEGACY.id, { failRead: true }); assert.equal(b.res.statusCode, 500); assert.match(b.res.body.detail, /Nothing was changed/); assert.ok(onlyReads(b.ops));
  const c = await download(LEGACY.id, { generateDocx: async () => { throw new Error('docx boom'); } }); assert.equal(c.res.statusCode, 500); assert.match(c.res.body.detail, /Nothing was changed/); assert.ok(onlyReads(c.ops));
});
check('DECISION: pure function classifies every production shape', () => {
  assert.equal(decideRfpDownload(LEGACY).action, 'render');
  for (const r of [CAMERA_V2, LANDSCAPE, NONE, EMPTY]) assert.equal(decideRfpDownload(r).action, 'refuse', r.id);
  assert.equal(decideRfpDownload(null).status, 404);
  assert.equal(decideRfpDownload({ structured_rfp: { scopeItems: [] } }).action, 'refuse', 'an empty scopeItems list is not a document');
});
check('STATIC: the download route and its module contain no write, no model call, no storage', () => {
  const mod = fs.readFileSync(path.join(ROOT, 'lib/vendors/rfp_download.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\.(?:update|insert|upsert|delete)\s*\(|storage|buildStructuredRFP|anthropic|aiRoute/.test(mod), 'module is read-only');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const line = server.split(/\r?\n/).find((l) => l.includes("app.get('/download-rfp/:bidRequestId'"));
  assert.ok(line && /makeRfpDownloadHandler\(\{ supabase, generateDocx: generateRFPDocx \}\)/.test(line), 'route delegates to the read-only handler');
  assert.equal((server.match(/app\.get\('\/download-rfp\//g) || []).length, 1, 'exactly one download route');
});
check('STATIC: explicit RFP creation still exists elsewhere (generation was not removed, only taken out of Download)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok((server.match(/await buildStructuredRFP\(/g) || []).length >= 2);
});
check('PAGE: the Download button shows the plain reason when a download is refused', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(/alert\(err\.detail \|\| \('Error: ' \+ \(err\.error \|\| 'Could not download'\)\)\)/.test(html));
});

(async () => { for (const t of pending) await t(); console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; })();
