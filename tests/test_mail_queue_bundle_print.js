// tests/test_mail_queue_bundle_print.js — Issue #5 regression (Ed 2026-09-28).
// Drives the REAL Mail Queue lock-and-batch handler (api/enforcement.js) with
// an in-memory Supabase fake. Case: one property, TWO approved first-class
// courtesy_1 letters, each violation with its own close-up photo plus a shared
// wide photo.
//
// Expected: the merged print batch holds ONE envelope that has both violations
// (numbered 1 and 2) and both evidence photos, and every member seals the SAME
// combined bytes (sha256). On the pre-fix code the batch had one violation and
// no photo, and each member sealed a different one-violation letter.
// No dotenv: a unit test must never hold production keys. With the real
// OPENAI_API_KEY loaded, the citation lookup made a live embeddings call
// (found by the TEST_NO_PROD guard, Issue #27 follow-up).
require('./_support/no_prod_network');
const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const { createCanvas } = require('canvas');

const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
function jpeg(color, w = 300, h = 400) {
  const c = createCanvas(w, h); const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(10, 10, 40, 40);
  return c.toBuffer('image/jpeg');
}

// ---------------- seed ----------------
const C = 'c1', P = 'p1', V1 = 'v1', V2 = 'v2', O1 = 'o1', O2 = 'o2';
const seed = {
  communities: [{ id: C, name: 'Test Lakes', legal_name: 'Test Lakes Homeowners Association, Inc.', letter_sender_name: 'Manager', letter_sender_title: 'Community Manager',
    letter_fee_courtesy_1_cents: 0, letter_fee_courtesy_2_cents: 2500, letter_fee_certified_209_cents: 3500, letter_cure_days_courtesy: 14, bundle_certified_letters_separately: false }],
  v_current_property_owners: [{ property_id: P, community_id: C, street_address: '100 Test Lane', unit: null, city: 'Houston', state: 'TX', zip: '77001', lot_number: '1', owner_name: 'Test Owner', owner_mailing_address: '100 Test Lane, Houston, TX 77001' }],
  properties: [{ id: P, community_id: C, street_address: '100 Test Lane', city: 'Houston', state: 'TX', zip: '77001' }],
  enforcement_categories: [{ id: 'cat1', slug: 'prune_trees', label: 'Prune Trees', description: 'Trees must be trimmed.' }, { id: 'cat2', slug: 'address_numbers', label: 'Address Numbers', description: 'Address numbers must be visible.' }],
  violations: [
    { id: V1, property_id: P, community_id: C, current_stage: 'courtesy_1', primary_category_id: 'cat1', opened_at: '2026-09-28T13:23:00Z', opened_from_observation_id: O1, cure_days_override: null, source: 'inspection',
      enforcement_categories: { slug: 'prune_trees', label: 'Prune Trees', description: 'Trees must be trimmed.' } },
    { id: V2, property_id: P, community_id: C, current_stage: 'courtesy_1', primary_category_id: 'cat2', opened_at: '2026-09-28T13:21:00Z', opened_from_observation_id: O2, cure_days_override: null, source: 'inspection',
      enforcement_categories: { slug: 'address_numbers', label: 'Address Numbers', description: 'Address numbers must be visible.' } },
  ],
  property_observations: [
    { id: O1, violation_id: V1, ai_description: 'Tree overhangs the sidewalk.', severity: 'moderate', created_at: '2026-09-28T13:23:00Z', inspection_photo_id: 'ph1', inspection_photos: { captured_at: '2026-09-28T18:23:00Z', storage_path: 'photos/close1.jpg', paired_wide_photo_id: 'w1' } },
    { id: O2, violation_id: V2, ai_description: 'Address numbers not visible.', severity: 'minor', created_at: '2026-09-28T13:21:00Z', inspection_photo_id: 'ph2', inspection_photos: { captured_at: '2026-09-28T18:21:00Z', storage_path: 'photos/close2.jpg', paired_wide_photo_id: 'w1' } },
  ],
  inspection_photos: [
    { id: 'ph1', storage_path: 'photos/close1.jpg', captured_at: '2026-09-28T18:23:00Z', paired_wide_photo_id: 'w1' },
    { id: 'ph2', storage_path: 'photos/close2.jpg', captured_at: '2026-09-28T18:21:00Z', paired_wide_photo_id: 'w1' },
    { id: 'w1', storage_path: 'photos/wide.jpg', captured_at: '2026-09-28T18:20:00Z' },
  ],
  interactions: [
    { id: 'i1', type: 'letter_courtesy_1', delivery_method: 'first_class_mail', status: 'approved', printed_at: null, sent_at: null, community_id: C, property_id: P, violation_id: V1, observation_id: O1, bundle_id: 'b1', content: 'drafts/b1.pdf', subject: 'Courtesy notice' },
    { id: 'i2', type: 'letter_courtesy_1', delivery_method: 'first_class_mail', status: 'approved', printed_at: null, sent_at: null, community_id: C, property_id: P, violation_id: V2, observation_id: O2, bundle_id: 'b1', content: 'drafts/b1.pdf', subject: 'Courtesy notice' },
  ],
};
const PHOTOS = { 'photos/close1.jpg': jpeg('#3a7'), 'photos/close2.jpg': jpeg('#a73'), 'photos/wide.jpg': jpeg('#37a', 400, 300) };

// ---------------- in-memory Supabase fake ----------------
const db = JSON.parse(JSON.stringify(seed));
const writes = { uploads: [], inserts: [], updates: [] };
function builder(table) {
  const st = { f: [], op: 'select', payload: null, rows: null };
  const has = (r, c) => Object.prototype.hasOwnProperty.call(r, c);
  const filtered = () => (db[table] || []).filter((r) => st.f.every((fn) => fn(r)));
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; }, gt() { return q; }, ilike() { return q; }, or() { return q; },
    eq(c, v) { st.f.push((r) => !has(r, c) || r[c] === v); return q; },
    neq(c, v) { st.f.push((r) => !has(r, c) || r[c] !== v); return q; },
    in(c, vs) { st.f.push((r) => !has(r, c) || vs.includes(r[c])); return q; },
    is(c, v) { st.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
    not(c, op, v) { st.f.push((r) => (op === 'is' && v === null ? r[c] != null : true)); return q; },
    insert(p) { st.op = 'insert'; st.rows = (Array.isArray(p) ? p : [p]).map((r) => ({ id: `${table}-${Math.random().toString(36).slice(2, 8)}`, ...r })); (db[table] = db[table] || []).push(...st.rows); writes.inserts.push({ table, rows: st.rows }); return q; },
    upsert(p) { return q.insert(p); },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    async maybeSingle() { return q._res(true); }, async single() { return q._res(true); },
    then(res, rej) { return Promise.resolve(q._res(false)).then(res, rej); },
    _res(one) {
      if (st.op === 'insert') return { data: one ? st.rows[0] : st.rows, error: null };
      if (st.op === 'update') { const rows = filtered(); rows.forEach((r) => Object.assign(r, st.payload)); writes.updates.push({ table, ids: rows.map((r) => r.id), payload: st.payload }); return { data: one ? rows[0] || null : rows, error: null, count: rows.length }; }
      if (st.op === 'delete') return { data: null, error: null };
      const rows = filtered();
      return { data: one ? rows[0] || null : rows, error: null, count: rows.length };
    },
  };
  return q;
}
const fake = {
  from: builder,
  rpc: async () => ({ data: null, error: null }),
  storage: { from(bucket) { return {
    upload: async (path, buf) => { writes.uploads.push({ bucket, path, buf: Buffer.from(buf) }); return { data: { path }, error: null }; },
    download: async (path) => {
      const up = [...writes.uploads].reverse().find((u) => u.bucket === bucket && u.path === path);
      const buf = up ? up.buf : PHOTOS[path];
      return buf ? { data: { arrayBuffer: async () => buf }, error: null } : { data: null, error: { message: 'not found' } };
    },
    createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed/${path}` }, error: null }),
    remove: async () => ({ data: null, error: null }),
  }; } },
};

const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fake };
  if (/_acting_user$/.test(request)) return { requireActingUser: async () => ({ id: 'u-test', full_name: 'Test Operator' }), getActingUser: async () => ({ id: 'u-test' }), actorDisplayName: () => 'Test Operator' };
  return realLoad.apply(this, arguments);
};
// Left active: the handler requires _acting_user (and lazily other modules) at call time.
const { router } = require('../api/enforcement');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function callHandler(handle, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; }, getHeader(k) { return headers[k.toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, json: o, headers }); return this; },
      end(buf) { resolve({ status: this.statusCode, body: buf, headers }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b, headers }); return this; },
    };
    Promise.resolve(handle({ body, headers: {}, query: {}, params: {} }, res, reject)).catch(reject);
  });
}

async function pdfFacts(buf) {
  const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
  const doc = await PDFDocument.load(buf);
  const imgs = []; const seen = new Set();
  const walk = (resD) => {
    if (!resD) return; const xo = resD.lookup(PDFName.of('XObject')); if (!(xo instanceof PDFDict)) return;
    for (const [, ref] of xo.entries()) {
      if (seen.has(String(ref))) continue; seen.add(String(ref));
      const o = doc.context.lookup(ref); if (!o || !o.dict) continue;
      const st = String(o.dict.get(PDFName.of('Subtype')));
      if (st === '/Image') imgs.push(`${o.dict.get(PDFName.of('Width'))}x${o.dict.get(PDFName.of('Height'))}`);
      else if (st === '/Form') walk(o.dict.lookup(PDFName.of('Resources')));
    }
  };
  for (const p of doc.getPages()) walk(p.node.Resources());
  const text = (await require('pdf-parse')(Buffer.from(buf))).text;
  return { pages: doc.getPageCount(), images: imgs, text };
}

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

t('REAL lock-and-batch: a 2-violation envelope prints ONE combined letter with both violations and both photos', async () => {
  const handle = handlerFor('post', '/mail-queue/lock-and-batch');
  const r = await callHandler(handle, { delivery_method: 'first_class_mail', community_id: C, interaction_ids: ['i1', 'i2'], postmark_date: '2026-09-28' });
  const skipped = decodeURIComponent(r.headers['x-bedrock-skipped-detail'] || '%5B%5D');
  assert.strictEqual(r.status, 200, `status ${r.status} ${JSON.stringify(r.json || '')} skipped=${skipped}`);
  assert.strictEqual(String(r.headers['x-bedrock-included']), '2', `skipped=${skipped}`);
  const bundleUp = writes.uploads.find((u) => u.bucket === 'violation-letters' && /\/bundle-courtesy_1-postmark-20260928-/.test(u.path));
  assert.ok(bundleUp, 'the combined letter was built and uploaded');
  const batch = await pdfFacts(r.body);
  const bundle = await pdfFacts(bundleUp.buf);
  // The print batch is exactly the one combined envelope.
  assert.strictEqual(batch.pages, bundle.pages, 'batch has exactly one envelope (the combined letter, once)');
  assert.match(batch.text, /(^|\n)\s*1\.\s+(Prune Trees|Address Numbers)/);
  assert.match(batch.text, /(^|\n)\s*2\.\s+(Prune Trees|Address Numbers)/);
  assert.ok(/Prune Trees/.test(batch.text) && /Address Numbers/.test(batch.text), 'both violations on paper');
  const photos = batch.images.filter((d) => ['300x400', '400x300'].includes(d));
  assert.ok(photos.filter((d) => d === '300x400').length >= 2, `both close-up photos on paper (images: ${batch.images.join(',')})`);
});

t('every member SEALS the same combined bytes, equal to the uploaded bundle file', async () => {
  const bundleUp = writes.uploads.find((u) => u.bucket === 'violation-letters' && /\/bundle-/.test(u.path));
  const seals = writes.uploads.filter((u) => u.bucket === 'sent-letters-archive');
  assert.strictEqual(seals.length, 2, `two members sealed (got ${seals.length})`);
  const shas = new Set(seals.map((s) => sha(s.buf)));
  assert.strictEqual(shas.size, 1, 'both members sealed identical bytes');
  assert.strictEqual([...shas][0], sha(bundleUp.buf), 'sealed bytes == the combined letter');
  // Record + paper agree: both interactions point at the combined file.
  const i1 = db.interactions.find((x) => x.id === 'i1'), i2 = db.interactions.find((x) => x.id === 'i2');
  assert.strictEqual(i1.content, bundleUp.path); assert.strictEqual(i2.content, bundleUp.path);
  assert.strictEqual(i1.status, 'sent'); assert.ok(i1.printed_at && i2.printed_at);
});

t('fail-closed guard: bytes that differ from the combined letter are refused (sha256, not identity)', () => {
  const { bundleRecord, bundleBytesIntact } = require('../lib/enforcement/bundle_print_guard');
  const br = bundleRecord(Buffer.from('%PDF-combined'), 'p/bundle.pdf');
  assert.strictEqual(bundleBytesIntact(Buffer.from('%PDF-combined'), br), true);          // equal bytes, different Buffer object
  assert.strictEqual(bundleBytesIntact(Buffer.from('%PDF-single-violation'), br), false);
  assert.strictEqual(bundleBytesIntact(null, br), false);
  // Ordering: the guard runs BEFORE the member's first write (upload / sent / seal / receipt / append).
  const src = require('fs').readFileSync(require.resolve('../api/enforcement'), 'utf8');
  const start = src.indexOf("router.post('/mail-queue/lock-and-batch'");
  const body = src.slice(start, src.indexOf('router.', start + 50) > 0 ? src.indexOf("\nrouter.", start + 50) : undefined);
  const guard = body.indexOf('bundleBytesIntact(pdfBuffer, _br)');
  assert.ok(guard > 0, 'guard present in lock-and-batch');
  for (const marker of ["from(LETTERS_BUCKET)", "status: 'sent'", 'await _sealSentLetter(', "from('delivery_receipts').insert", 'out.copyPages(src']) {
    const i = body.indexOf(marker);
    assert.ok(i > guard, `guard precedes ${marker}`);
  }
  assert.ok(/if \(_br\) \{\s*pdfBuffer = _br\.pdfBuffer; letterPath = _br\.letterPath;\s*\} else if \(isSelfHelp10Day\) \{/.test(body), 'one if / else-if / else chain');
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall mail-queue bundle print checks passed');
  process.exitCode = failed ? 1 : 0;
})();
