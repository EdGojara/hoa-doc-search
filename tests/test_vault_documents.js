// tests/test_vault_documents.js  (Ed 2026-10-28, migration 550) — Owner Vault
// documents keep their promises:
//   - only the owner reaches any document route (the router-level seal);
//   - a file is stored byte-for-byte with its sha256, under owner-vault/, and
//     filed under the house naming convention when no name is given;
//   - the same file twice for a company is a 409 naming the copy already filed;
//   - a storage failure saves nothing; a record failure takes the file back out;
//   - edits change only the editable fields (never the stored file or path);
//     there is no delete route, only archive / restore;
//   - the categories in code are exactly the migration's CHECK list.
// Runs the real router against in-memory stubs (no network, no database).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
process.env.SUPABASE_URL = 'http://localhost:1';
process.env.SUPABASE_KEY = 'service-key';

const DOCS = require('../lib/vault/documents');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('PASS ', name); };

// ---- pure helpers ------------------------------------------------------------------
ok('filed name follows Entity_Document-Type_Date.ext', () => {
  assert.strictEqual(DOCS.suggestFiledName({ entityName: 'Bedrock Association Management, LLC', title: 'Business Use Letter, City of Sugar Land', documentDate: '2026-10-28', originalFilename: 'x.PDF' }),
    'Bedrock_Association_Management_Business_Use_Letter_City_of_Sugar_Land_2026-10-28.pdf');
  assert.strictEqual(DOCS.suggestFiledName({ entityName: 'Bedrock Association Management, LLC', title: 'Form 1120-S', taxYear: 2025, originalFilename: 'return.pdf' }),
    'Bedrock_Association_Management_Form_1120_S_2025.pdf');
  assert.strictEqual(DOCS.suggestFiledName({ entityName: 'Bedrock Association Management, LLC', title: 'Bedrock Association Management Office Lease', originalFilename: 'lease.pdf' }),
    'Bedrock_Association_Management_Office_Lease.pdf', 'entity words are not repeated');
  assert.strictEqual(DOCS.suggestFiledName({ entityName: 'Smith & Co, Inc.', title: '', originalFilename: '' }), 'Smith_and');
});
ok('a typed filed name loses path characters and keeps the extension', () => {
  assert.strictEqual(DOCS.cleanFiledName('../../etc/Lease 2026', 'a.pdf'), '.. .. etc Lease 2026.pdf');
  assert.strictEqual(DOCS.cleanFiledName('Lease.pdf', 'a.pdf'), 'Lease.pdf');
  assert.strictEqual(DOCS.cleanFiledName('   ', 'a.pdf'), '');
});
ok('field validation refuses bad dates, years and categories', () => {
  assert.deepStrictEqual(DOCS.validateFields({ title: 'x' }).fields, { title: 'x', category: 'other' });
  assert.strictEqual(DOCS.validateFields({ title: '' }).error, 'title_required');
  assert.strictEqual(DOCS.validateFields({ title: 'x', category: 'nope' }).error, 'invalid_category');
  assert.strictEqual(DOCS.validateFields({ title: 'x', document_date: '2026-02-30' }).error, 'invalid_document_date');
  assert.strictEqual(DOCS.validateFields({ title: 'x', tax_year: '25' }).error, 'invalid_tax_year');
  assert.deepStrictEqual(DOCS.validateFields({ tax_year: '' }, { partial: true }).fields, { tax_year: null });
});
ok('the categories in code are exactly the migration CHECK list', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '550_vault_documents.sql'), 'utf8');
  const m = /category\s+text[\s\S]*?CHECK \(category IN \(([^)]*)\)\)/.exec(sql);
  const inSql = m[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1)).sort();
  assert.deepStrictEqual(Object.keys(DOCS.CATEGORIES).sort(), inSql);
});

// ---- router against stubs ----------------------------------------------------------
let TABLES, STORE, CALLS, FAIL;
function reset() {
  TABLES = { vault_entities: [{ id: 'e1', name: 'Bedrock Association Management, LLC' }], vault_documents: [], vault_access_log: [] };
  STORE = {}; CALLS = { uploads: [], removes: [], updates: [] }; FAIL = {};
}
function builder(table) {
  const st = { filters: [], isNull: [], notNull: [] };
  const rows = () => (TABLES[table] || []).filter((r) => st.filters.every(([k, v]) => r[k] === v) && st.isNull.every((k) => r[k] == null) && st.notNull.every((k) => r[k] != null));
  const b = {
    select(cols) { if (cols && cols !== '*') st.cols = cols.split(',').map((c) => c.trim()); return b; }, order() { return b; }, limit() { return b; },
    eq(k, v) { st.filters.push([k, v]); return b; },
    is(k) { st.isNull.push(k); return b; },
    not(k) { st.notNull.push(k); return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    insert(row) {
      return { select: () => ({ single: () => {
        if (table === 'vault_documents' && FAIL.insert) return Promise.resolve({ data: null, error: { message: FAIL.insert } });
        const r = { id: 'd' + ((TABLES[table] || []).length + 1), created_at: 'now', archived_at: null, ...row };
        (TABLES[table] = TABLES[table] || []).push(r); return Promise.resolve({ data: r, error: null });
      } }), then: (res) => { (TABLES[table] = TABLES[table] || []).push(row); return Promise.resolve({ error: null }).then(res); } };
    },
    update(patch) {
      CALLS.updates.push({ table, patch });
      const u = { eq(k, v) { st.filters.push([k, v]); return u; }, select() { return u; },
        maybeSingle() { const r = rows()[0]; if (r) Object.assign(r, patch); return Promise.resolve({ data: r || null, error: null }); } };
      return u;
    },
    then(res, rej) { const pick = (r) => (st.cols ? Object.fromEntries(st.cols.map((c) => [c, r[c]])) : r); return Promise.resolve({ data: rows().map(pick), error: null }).then(res, rej); },
  };
  return b;
}
const storage = { from: () => ({
  upload: async (p, buf) => { CALLS.uploads.push(p); if (FAIL.upload) return { error: { message: 'bucket down' } }; STORE[p] = Buffer.from(buf); return { error: null }; },
  remove: async (ps) => { CALLS.removes.push(...ps); ps.forEach((p) => delete STORE[p]); return { error: null }; },
  createSignedUrl: async (p, ttl, opts) => ({ data: { signedUrl: `https://signed/${p}?ttl=${ttl}${opts && opts.download ? '&download=' + opts.download : ''}` }, error: null }),
}) };
require.cache[require.resolve('@supabase/supabase-js')] = { id: 'stub', filename: 'stub', loaded: true, exports: { createClient: () => ({ from: builder, storage }) } };
require.cache[require.resolve('../api/_require_admin')] = { id: 'stub2', filename: 'stub2', loaded: true, exports: {
  requireOwner: async (req, res) => {
    if (req.headers.authorization === 'Bearer owner') return { email: 'owner@example.test', full_name: 'Owner' };
    res.status(403).json({ error: 'owner_only' }); return null;
  },
} };
reset();
const app = express();
app.use('/api/vault', require('../api/vault').router);
const server = http.createServer(app);

function call(method, url, { token = 'owner', json, form } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    let body = null;
    if (json) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; }
    if (form) {
      const bd = '----b' + crypto.randomBytes(6).toString('hex'); const parts = [];
      for (const [k, v] of Object.entries(form.fields || {})) parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      if (form.file) parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="${form.file.name}"\r\nContent-Type: application/pdf\r\n\r\n`), form.file.data, Buffer.from('\r\n'));
      parts.push(Buffer.from(`--${bd}--\r\n`)); body = Buffer.concat(parts); headers['content-type'] = 'multipart/form-data; boundary=' + bd;
    }
    if (body) headers['content-length'] = body.length;
    const req = http.request({ method, host: '127.0.0.1', port: server.address().port, path: '/api/vault' + url, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PDF = Buffer.from('%PDF-1.4 the signed letter \u0000ÿ bytes');
  try {
    let r = await call('GET', '/entities/e1/documents', { token: 'staff' });
    assert.strictEqual(r.status, 403); pass++; console.log('PASS  a staff sign-in is refused (403) before any document route');
    r = await call('POST', '/entities/e1/documents', { token: null, form: { file: { name: 'a.pdf', data: PDF } } });
    assert.strictEqual(r.status, 403); assert.strictEqual(CALLS.uploads.length, 0); pass++; console.log('PASS  an anonymous upload is refused and nothing is stored');

    r = await call('POST', '/entities/e1/documents', { form: { file: { name: 'letter.pdf', data: PDF }, fields: { title: 'Business Use Letter, City of Sugar Land', category: 'government', document_date: '2026-10-28' } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = r.body.document;
    assert.strictEqual(d.filename, 'Bedrock_Association_Management_Business_Use_Letter_City_of_Sugar_Land_2026-10-28.pdf');
    assert.strictEqual(d.sha256, crypto.createHash('sha256').update(PDF).digest('hex'));
    assert.strictEqual(d.size_bytes, PDF.length);
    assert.ok(d.storage_path.startsWith('owner-vault/e1/documents/'));
    assert.ok(STORE[d.storage_path].equals(PDF), 'stored bytes are identical');
    assert.strictEqual(d.created_by, 'owner@example.test');
    pass++; console.log('PASS  a document is stored byte-for-byte under owner-vault/ with its sha256 and the convention name');

    r = await call('POST', '/entities/e1/documents', { form: { file: { name: 'again.pdf', data: PDF }, fields: { title: 'Again' } } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.document.id, d.id); assert.strictEqual(CALLS.uploads.length, 1);
    pass++; console.log('PASS  the same file twice is a 409 naming the copy already filed, and nothing new is stored');

    r = await call('POST', '/entities/nope/documents', { form: { file: { name: 'x.pdf', data: Buffer.from('other') } } });
    assert.strictEqual(r.status, 404); pass++; console.log('PASS  an unknown company is a 404');
    r = await call('POST', '/entities/e1/documents', { form: { file: { name: 'x.pdf', data: Buffer.from('other') }, fields: { category: 'bogus' } } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'invalid_category'); pass++; console.log('PASS  a bad category is a 400 before anything is stored');

    FAIL.upload = true;
    r = await call('POST', '/entities/e1/documents', { form: { file: { name: 'y.pdf', data: Buffer.from('second') } } });
    assert.strictEqual(r.status, 500); assert.strictEqual(r.body.error, 'could_not_store_file'); assert.strictEqual(TABLES.vault_documents.length, 1);
    pass++; console.log('PASS  a storage failure saves no record');
    FAIL.upload = false; FAIL.insert = 'boom';
    r = await call('POST', '/entities/e1/documents', { form: { file: { name: 'z.pdf', data: Buffer.from('third') } } });
    assert.strictEqual(r.status, 500); assert.strictEqual(CALLS.removes.length, 1); assert.strictEqual(STORE[CALLS.removes[0]], undefined);
    pass++; console.log('PASS  a record failure takes the stored file back out');
    FAIL.insert = null;

    r = await call('PATCH', '/documents/' + d.id, { json: { title: 'City letter', storage_path: 'evil', sha256: 'x', entity_id: 'e2', filename: 'Bedrock_City_Letter' } });
    assert.strictEqual(r.status, 200);
    const patch = CALLS.updates[CALLS.updates.length - 1].patch;
    assert.deepStrictEqual(Object.keys(patch).sort(), ['filename', 'title']);
    assert.strictEqual(patch.filename, 'Bedrock_City_Letter.pdf');
    pass++; console.log('PASS  an edit changes only the editable fields, never the stored file, hash or company');

    r = await call('PATCH', '/documents/' + d.id, { json: { archived: true } });
    assert.ok(r.body.document.archived_at);
    r = await call('GET', '/entities/e1/documents'); assert.strictEqual(r.body.documents.length, 0);
    r = await call('GET', '/entities/e1/documents?archived=1'); assert.strictEqual(r.body.documents.length, 1);
    r = await call('PATCH', '/documents/' + d.id, { json: { archived: false } }); assert.strictEqual(r.body.document.archived_at, null);
    pass++; console.log('PASS  archive moves a document to the archive list and restore brings it back');

    r = await call('DELETE', '/documents/' + d.id);
    assert.strictEqual(r.status, 404); assert.ok(STORE[d.storage_path]);
    pass++; console.log('PASS  there is no delete route; the file stays');

    r = await call('GET', '/documents/' + d.id + '/open?download=1');
    assert.ok(/ttl=300/.test(r.body.url) && /download=Bedrock_City_Letter\.pdf/.test(r.body.url));
    pass++; console.log('PASS  open gives a five-minute link that downloads under the filed name');

    const list = await call('GET', '/entities/e1/documents');
    assert.ok(list.body.documents.every((x) => !('storage_path' in x)));
    pass++; console.log('PASS  the list never exposes storage paths');
  } catch (e) {
    console.log('FAIL ', e.message); server.close(); process.exit(1);
  }
  server.close();
  console.log(`\n${pass} passed, 0 failed`);
})();
