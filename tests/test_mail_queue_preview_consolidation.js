// tests/test_mail_queue_preview_consolidation.js — 5127 Waterview Meadow regression (Ed 2026-10-21).
// Drives the REAL Mail Queue handlers (api/enforcement.js) with an in-memory
// Supabase fake, the same harness as test_mail_queue_bundle_print.js.
//
// The incident: two manual courtesy_1 violations at one house were drafted and
// approved as two separate letters. Lock+Print stamped one bundle_id on both,
// then the combined letter failed (the mildew item had no finding text), so both
// were held with the bundle_id left behind. "Skip lock · download PDFs" then
// stamped them printed with no postmark, which moved them to Locked, where only
// Confirm-mailed remained.
//
// Checks:
//   1. two courtesy violations at one property (one with NO finding text) print
//      as ONE letter listing each violation separately, each with its own date;
//   2. courtesy + certified, and first-class + certified, never share an envelope;
//   3. Preview renders the combined letter and changes nothing;
//   4. a combined letter that can't be built leaves bundle_id untouched;
//   5. the retired download-without-lock path writes nothing;
//   6. Confirm-mailed never marks a never-postmarked letter mailed.
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');
const { createCanvas } = require('canvas');

function jpeg(color, w = 300, h = 400) {
  const c = createCanvas(w, h); const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  return c.toBuffer('image/jpeg');
}

// ---------------- seed: the 5127 Waterview Meadow shape ----------------
const C = 'c1', P = 'p1', P2 = 'p2', V1 = 'v1', V2 = 'v2', O1 = 'o1', O2 = 'o2';
const SEED = {
  communities: [{ id: C, name: 'Test Lakes', legal_name: 'Test Lakes Homeowners Association, Inc.', letter_sender_name: 'Manager', letter_sender_title: 'Community Manager',
    letter_fee_courtesy_1_cents: 0, letter_fee_courtesy_2_cents: 2500, letter_fee_certified_209_cents: 3500, letter_cure_days_courtesy_1: 15, bundle_certified_letters_separately: false }],
  v_current_property_owners: [{ property_id: P, community_id: C, street_address: '5127 Test Meadow Drive', unit: null, city: 'Richmond', state: 'TX', zip: '77407', lot_number: '1', owner_name: 'Test Owner', owner_mailing_address: '2018 Elsewhere Rd, Houston, TX 77062' }],
  properties: [{ id: P, community_id: C, street_address: '5127 Test Meadow Drive', city: 'Richmond', state: 'TX', zip: '77407' }],
  enforcement_categories: [{ id: 'cat1', slug: 'fence_damage', label: 'Fence damage', description: 'Damaged fence' }, { id: 'cat2', slug: 'mildew_mold_visible', label: 'Mildew / mold (visible)', description: 'Mildew or mold' }],
  violations: [
    { id: V1, property_id: P, community_id: C, current_stage: 'courtesy_1', primary_category_id: 'cat1', opened_at: '2026-10-21T14:37:27Z', opened_from_observation_id: O1, cure_days_override: null, source: 'manual_entry',
      enforcement_categories: { slug: 'fence_damage', label: 'Fence damage', description: 'Damaged fence' } },
    { id: V2, property_id: P, community_id: C, current_stage: 'courtesy_1', primary_category_id: 'cat2', opened_at: '2026-10-21T14:34:46Z', opened_from_observation_id: O2, cure_days_override: 30, source: 'manual_entry',
      enforcement_categories: { slug: 'mildew_mold_visible', label: 'Mildew / mold (visible)', description: 'Mildew or mold' } },
  ],
  property_observations: [
    { id: O1, violation_id: V1, ai_description: null, reviewer_notes: 'The fence appears to be detached on one side and is at risk of falling.', severity: 'severe', created_at: '2026-10-21T14:37:27Z', inspection_photo_id: 'ph1', inspection_photos: { captured_at: '2026-10-21T14:37:00Z', storage_path: 'photos/close1.jpg', paired_wide_photo_id: null } },
    // The mildew item: NO finding text at all (the case that held the envelope).
    { id: O2, violation_id: V2, ai_description: null, reviewer_notes: null, severity: 'moderate', created_at: '2026-10-21T14:34:46Z', inspection_photo_id: 'ph2', inspection_photos: { captured_at: '2026-10-21T14:34:00Z', storage_path: 'photos/close2.jpg', paired_wide_photo_id: null } },
  ],
  inspection_photos: [
    { id: 'ph1', storage_path: 'photos/close1.jpg', captured_at: '2026-10-21T14:37:00Z', paired_wide_photo_id: null },
    { id: 'ph2', storage_path: 'photos/close2.jpg', captured_at: '2026-10-21T14:34:00Z', paired_wide_photo_id: null },
  ],
  // Two separately drafted + approved letters, separate PDFs, NO bundle_id.
  interactions: [
    { id: 'i1', type: 'letter_courtesy_1', delivery_method: 'first_class_mail', status: 'approved', printed_at: null, sent_at: null, postmark_date: null, mailed_at: null, community_id: C, property_id: P, violation_id: V1, observation_id: O1, bundle_id: null, content: 'v1/courtesy_1-draft.pdf', subject: 'Courtesy notice' },
    { id: 'i2', type: 'letter_courtesy_1', delivery_method: 'first_class_mail', status: 'approved', printed_at: null, sent_at: null, postmark_date: null, mailed_at: null, community_id: C, property_id: P, violation_id: V2, observation_id: O2, bundle_id: null, content: 'v2/courtesy_1-draft.pdf', subject: 'Courtesy notice' },
  ],
};
const PHOTOS = { 'photos/close1.jpg': jpeg('#3a7'), 'photos/close2.jpg': jpeg('#a73') };

// ---------------- in-memory Supabase fake (resettable) ----------------
let db, writes;
function reset(mutate) {
  db = JSON.parse(JSON.stringify(SEED));
  if (mutate) mutate(db);
  writes = { uploads: [], inserts: [], updates: [] };
}
reset();
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
async function onePagePdf(label) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage().drawText(label, { x: 50, y: 700, size: 12, font: f });
  return Buffer.from(await d.save());
}
let DRAFT_PDFS = {};
const fake = {
  from: builder,
  rpc: async () => ({ data: null, error: null }),
  storage: { from(bucket) { return {
    upload: async (path, buf) => { writes.uploads.push({ bucket, path, buf: Buffer.from(buf) }); return { data: { path }, error: null }; },
    download: async (path) => {
      const up = [...writes.uploads].reverse().find((u) => u.bucket === bucket && u.path === path);
      const buf = up ? up.buf : (PHOTOS[path] || DRAFT_PDFS[path]);
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
const enforcement = require('../api/enforcement');
const { router, _groupLettersIntoEnvelopes } = enforcement;

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function call(method, path, body) {
  const handle = handlerFor(method, path);
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
const pdfText = async (buf) => (await require('pdf-parse')(Buffer.from(buf))).text;
const writeCount = () => writes.uploads.length + writes.inserts.length + writes.updates.length;

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

t('multiple courtesy violations at one property print as ONE letter listing each separately (one has no finding text)', async () => {
  reset();
  const r = await call('post', '/mail-queue/lock-and-batch', { delivery_method: 'first_class_mail', community_id: C, interaction_ids: ['i1', 'i2'], postmark_date: '2026-10-21' });
  const skipped = decodeURIComponent(r.headers['x-bedrock-skipped-detail'] || '%5B%5D');
  assert.strictEqual(r.status, 200, `status ${r.status} ${JSON.stringify(r.json || '')} skipped=${skipped}`);
  assert.strictEqual(String(r.headers['x-bedrock-included']), '2', `skipped=${skipped}`);
  const bundleUp = writes.uploads.find((u) => u.bucket === 'violation-letters' && /\/bundle-courtesy_1-postmark-20261021-/.test(u.path));
  assert.ok(bundleUp, 'one combined letter was built and uploaded');
  const text = await pdfText(r.body);
  assert.match(text, /(^|\n)\s*1\.\s+(Fence damage|Mildew)/);
  assert.match(text, /(^|\n)\s*2\.\s+(Fence damage|Mildew)/);
  assert.ok(/detached on one side/.test(text), 'the fence item keeps its own description');
  assert.ok(/Mildew \/ mold \(visible\) observed at this property/.test(text), 'the item with no text gets the category sentence instead of blocking the envelope');
  const perItem = text.match(/Correct this item on or before:/g) || [];
  assert.strictEqual(perItem.length, 2, 'each violation states its own deadline');
  assert.ok(/November 5, 2026/.test(text) && /November 20, 2026/.test(text), 'fence = 15-day default, mildew = its 30-day override');
  const i1 = db.interactions.find((x) => x.id === 'i1'), i2 = db.interactions.find((x) => x.id === 'i2');
  assert.ok(i1.bundle_id && i1.bundle_id === i2.bundle_id, 'one envelope id on both');
  assert.strictEqual(i1.content, bundleUp.path); assert.strictEqual(i2.content, bundleUp.path);
  // Individual records are kept: two interaction rows, two violations, each with its own cure date.
  assert.strictEqual(db.interactions.filter((x) => x.property_id === P).length, 2);
  assert.ok(db.violations.find((v) => v.id === V1).cure_period_ends_at && db.violations.find((v) => v.id === V2).cure_period_ends_at);
});

t('mixed mailing requirements never share an envelope (courtesy vs certified §209, first-class vs certified)', async () => {
  reset();
  const letters = [
    { id: 'a', type: 'letter_courtesy_1', delivery_method: 'first_class_mail', property_id: P, community_id: C, violation_id: V1 },
    { id: 'b', type: 'letter_courtesy_1', delivery_method: 'first_class_mail', property_id: P, community_id: C, violation_id: V2 },
    { id: 'c', type: 'letter_209', delivery_method: 'certified_mail', property_id: P, community_id: C, violation_id: V1 },
    { id: 'd', type: 'letter_courtesy_1', delivery_method: 'certified_mail', property_id: P, community_id: C, violation_id: V2 },
  ];
  const groups = [...(await _groupLettersIntoEnvelopes(letters)).values()].map((g) => g.map((x) => x.id).sort().join(','));
  assert.deepStrictEqual(groups.sort(), ['a,b', 'c', 'd'], `envelopes: ${JSON.stringify(groups)}`);
});

t('Preview renders the combined letter and changes NOTHING', async () => {
  reset();
  DRAFT_PDFS = {};
  const before = JSON.stringify(db);
  const r = await call('post', '/mail-queue/preview', { delivery_method: 'first_class_mail', community_id: C });
  assert.strictEqual(r.status, 200, `status ${r.status} ${JSON.stringify(r.json || '')}`);
  assert.strictEqual(String(r.headers['x-bedrock-envelopes']), '1', 'one envelope');
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(r.headers['x-bedrock-preview-problems'])), []);
  const text = await pdfText(r.body);
  assert.ok(/PREVIEW - NOT FOR MAILING/.test(text), 'every page is stamped PREVIEW');
  assert.ok(/Fence damage/.test(text) && /Mildew/.test(text), 'both violations in the one preview letter');
  assert.strictEqual(writeCount(), 0, `no writes at all (${JSON.stringify(writes.updates.map((u) => u.payload))})`);
  assert.strictEqual(JSON.stringify(db), before, 'database identical before and after');
  const i1 = db.interactions.find((x) => x.id === 'i1');
  assert.strictEqual(i1.status, 'approved'); assert.strictEqual(i1.printed_at, null); assert.strictEqual(i1.bundle_id, null);
});

t('Preview of one-violation envelopes uses the stored letter and still writes nothing', async () => {
  reset((d) => { d.interactions = d.interactions.filter((x) => x.id === 'i1'); });
  DRAFT_PDFS = { 'v1/courtesy_1-draft.pdf': await onePagePdf('Stored reviewed letter') };
  const r = await call('post', '/mail-queue/preview', { delivery_method: 'first_class_mail', community_id: C });
  assert.strictEqual(r.status, 200);
  assert.ok(/Stored reviewed letter/.test(await pdfText(r.body)));
  assert.strictEqual(writeCount(), 0);
});

t('a combined letter that cannot be built leaves bundle_id and status untouched (held, nothing written)', async () => {
  reset((d) => { d.v_current_property_owners = []; }); // no owner of record -> combined render fails
  const r = await call('post', '/mail-queue/lock-and-batch', { delivery_method: 'first_class_mail', community_id: C, interaction_ids: ['i1', 'i2'], postmark_date: '2026-10-21' });
  assert.notStrictEqual(r.status, 200, 'nothing printed');
  for (const id of ['i1', 'i2']) {
    const row = db.interactions.find((x) => x.id === id);
    assert.strictEqual(row.bundle_id, null, `${id} bundle_id unchanged`);
    assert.strictEqual(row.status, 'approved'); assert.strictEqual(row.printed_at, null);
  }
  assert.ok(!writes.updates.some((u) => u.table === 'interactions' && u.payload && 'bundle_id' in u.payload), 'no bundle_id write on a held envelope');
});

t('download-without-lock is retired: 410 and no print stamp', async () => {
  reset();
  const r = await call('post', '/mail-queue/batch-pdf', { delivery_method: 'first_class_mail', community_id: C });
  assert.strictEqual(r.status, 410);
  assert.strictEqual(writeCount(), 0);
  assert.ok(db.interactions.every((x) => x.printed_at === null));
});

t('Confirm-mailed never marks a never-postmarked (unlocked) letter mailed', async () => {
  reset((d) => { for (const x of d.interactions) { x.printed_at = '2026-10-21T19:55:41.779Z'; x.bundle_id = 'b-held'; } });
  const r = await call('post', '/mail-queue/confirm-mailed', { delivery_method: 'first_class_mail', printed_at: '2026-10-21T19:55:41.779Z', community_id: C });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.confirmed, 0);
  assert.strictEqual(r.json.not_postmarked, 2);
  assert.strictEqual(writeCount(), 0, 'the held batch is left exactly as it is');
  assert.ok(db.interactions.every((x) => x.status === 'approved' && x.mailed_at == null && x.sent_at == null));
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall mail-queue preview/consolidation checks passed');
  process.exitCode = failed ? 1 : 0;
})();
