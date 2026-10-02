// ============================================================================
// tests/test_w9_queue_secure_form.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Step 1: the W-9 compliance queue (lib/tax/w9_queue.js, GET /api/ap/w9-queue).
// Step 2: a secure-form W-9 becomes the vendor's canonical W-9 document, once
// (lib/vendors/w9_documents.js + api/ach.js), plus the W-9-only link mode.
//
// Ed's list, each covered below:
//   duplicate secure-form submissions / retries   wrong-vendor token/document
//   W-9 replacement / supersession               emailed candidate = no mutation
//   cross-association vendor display             books-of-record / demo exclusion
//   nothing here can block a payment
// In-memory fakes only (a small PostgREST-shaped store that enforces the real
// unique indexes); the ACH routes run for real over HTTP with multipart bodies.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const code = (p) => src(p).replace(/\/\/.*$/gm, '');

// ---------------------------------------------------------------- fake store
let SEQ = 0;
const uid = () => `00000000-0000-4000-8000-${String(++SEQ).padStart(12, '0')}`;
function makeDb(seed = {}, { missing = [] } = {}) {
  const T = {}; for (const [k, v] of Object.entries(seed)) T[k] = v.map((r) => ({ ...r }));
  const writes = []; const storage = [];
  const hasMissing = (table, cols) => missing.some((m) => { const [t, c] = m.split('.'); return t === table && cols.includes(c); });
  const uniqueCheck = (table, rows) => {
    if (table === 'vendor_documents') {
      const cur = new Map(); const req = new Map();
      for (const r of rows) {
        if (r.doc_type === 'w9' && r.is_current) { if (cur.has(r.vendor_id)) return 'duplicate key value violates unique constraint "uq_vendor_w9_current"'; cur.set(r.vendor_id, 1); }
        if (r.vendor_ach_request_id) { if (req.has(r.vendor_ach_request_id)) return 'duplicate key value violates unique constraint "uq_vendor_documents_ach_request"'; req.set(r.vendor_ach_request_id, 1); }
      }
    }
    return null;
  };
  function q(table) {
    const f = []; let sel = '*'; let mode = 'select'; let payload = null; let single = null; let order = null; let range = null; let lim = null; let wantRows = false;
    const api = {
      select(s) { if (mode === 'select') sel = s || '*'; else wantRows = true; return api; },
      eq(c, v) { f.push((r) => r[c] === v); return api; }, neq(c, v) { f.push((r) => r[c] !== v); return api; },
      in(c, vs) { f.push((r) => vs.includes(r[c])); return api; },
      gte(c, v) { f.push((r) => String(r[c]) >= v); return api; }, lte(c, v) { f.push((r) => String(r[c]) <= v); return api; },
      not(c, op, v) { f.push((r) => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return api; },
      or() { return api; }, like(c, p) { const re = new RegExp('^' + p.replace(/%/g, '.*') + '$'); f.push((r) => re.test(r[c] || '')); return api; },
      ilike(c, p) { const re = new RegExp('^' + p.replace(/%/g, '.*') + '$', 'i'); f.push((r) => re.test(r[c] || '')); return api; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return api; }, range(a, b) { range = [a, b]; return api; }, limit(n) { lim = n; return api; },
      maybeSingle() { single = 'maybe'; return api; }, single() { single = 'one'; return api; },
      insert(row) { mode = 'insert'; payload = row; return api; }, update(p) { mode = 'update'; payload = p; return api; }, delete() { mode = 'delete'; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      T[table] = T[table] || [];
      const cols = sel === '*' ? [] : sel.split(',').map((s) => s.trim().split(':').pop().split('(')[0]);
      if (mode === 'select' && hasMissing(table, cols)) return { data: null, error: { message: `column ${table}.${cols.find((c) => hasMissing(table, [c]))} does not exist` } };
      if (mode === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || uid(), uploaded_at: new Date(Date.now() + SEQ).toISOString(), ...r }));
        const bad = Object.keys(rows[0]).find((c) => hasMissing(table, [c]));
        if (bad) return { data: null, error: { message: `column ${table}.${bad} does not exist` } };
        const err = uniqueCheck(table, T[table].concat(rows)); if (err) return { data: null, error: { code: '23505', message: err } };
        T[table].push(...rows); writes.push({ op: 'insert', table, rows });
        return { data: single ? rows[0] : rows, error: null };
      }
      let rows = T[table].filter((r) => f.every((p) => p(r)));
      if (mode === 'update') {
        const bad = Object.keys(payload).find((c) => hasMissing(table, [c]));
        if (bad) return { data: null, error: { message: `column ${table}.${bad} does not exist` } };
        const next = T[table].map((r) => (rows.includes(r) ? { ...r, ...payload } : r));
        const err = uniqueCheck(table, next); if (err) return { data: null, error: { code: '23505', message: err } };
        const changed = []; T[table] = next; for (const r of T[table]) if (rows.some((o) => o.id === r.id)) changed.push(r);
        writes.push({ op: 'update', table, payload, n: changed.length });
        return { data: single ? (changed[0] || null) : changed, error: null };
      }
      if (mode === 'delete') { T[table] = T[table].filter((r) => !rows.includes(r)); writes.push({ op: 'delete', table }); return { data: null, error: null }; }
      if (order) rows = [...rows].sort((a, b) => (String(a[order[0]]) < String(b[order[0]]) ? -1 : 1) * (order[1] ? 1 : -1));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (lim != null) rows = rows.slice(0, lim);
      if (single === 'one') return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      if (single === 'maybe') return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    return api;
  }
  return {
    T, writes, storage,
    from: (t) => q(t),
    storage: { from: () => ({ upload: async (p, buf) => { storage.push(p); return { data: { path: p }, error: null }; } }) },
  };
}

const MC = require('../lib/company').BEDROCK_MGMT_CO_ID;
const C1 = 'c-waterview', C2 = 'c-canyon', CEW = 'c-eaglewood', CDEMO = 'c-demo';
const COMMS = [
  { id: C1, name: 'Waterview', financials_active: true, books_of_record: 'trusted', is_demo: false, management_company_id: MC },
  { id: C2, name: 'Canyon Gate', financials_active: true, books_of_record: 'trusted', is_demo: false, management_company_id: MC },
  { id: CEW, name: 'Eaglewood', financials_active: false, books_of_record: 'vantaca', is_demo: false, management_company_id: MC },
  { id: CDEMO, name: 'Demo HOA', financials_active: true, books_of_record: 'trusted', is_demo: true, management_company_id: MC },
];
const V = (id, name, extra = {}) => ({ id, name, kind: 'vendor', w9_on_file: false, tax_classification: null, tax_reporting_status: 'unknown', is_mud: false, is_legal_counsel: false, is_medical_provider: false, management_company_id: MC, ...extra });
const PAY = (id, vendor_id, community_id, cents, method = 'check') => ({ id, vendor_id, community_id, amount_cents: cents, payment_method: method, status: 'completed', payment_date: '2026-03-01' });
function world(extra = {}) {
  return makeDb({
    communities: COMMS,
    management_companies: [{ id: MC, name: 'Bedrock Association Management' }],
    vendors: [
      V('v-lawn', 'Lawn Pros'), V('v-mud', 'County MUD 1', { is_mud: true }), V('v-bed', 'Bedrock Association Management, LLC'),
      V('v-saifee', 'Saifee Signs & Graphics'), V('v-ok', 'Done Vendor', { w9_on_file: true, tax_classification: 'individual_sole_proprietor', w9_uploaded_at: '2026-05-01T00:00:00Z' }),
    ],
    ap_payments: [
      PAY('p1', 'v-lawn', C1, 300000), PAY('p2', 'v-lawn', C2, 250000), PAY('p3', 'v-mud', C1, 500000, 'ach'),
      PAY('p4', 'v-bed', C1, 900000), PAY('p5', 'v-saifee', C2, 400000), PAY('p6', 'v-ok', C1, 900000),
      PAY('p7', 'v-lawn', CEW, 900000), PAY('p8', 'v-lawn', CDEMO, 900000),
    ],
    ap_payment_applications: [], ap_invoices: [
      { id: 'b1', vendor_id: 'v-mud', community_id: C1, total_cents: 10000, amount_paid_cents: 0, status: 'awaiting_approval', is_ach_autopay: true },
      { id: 'b-ew', vendor_id: 'v-lawn', community_id: CEW, total_cents: 900000, amount_paid_cents: 0, status: 'approved' },
      { id: 'b-demo', vendor_id: 'v-lawn', community_id: CDEMO, total_cents: 900000, amount_paid_cents: 0, status: 'approved' },
    ],
    vendor_documents: [], vendor_ach_requests: [],
    email_attachments: [{ id: 'att1', email_message_id: 'm1', sender_email: 'pm@canyongate.example', filename: 'Saifee Signs & Graphics - W9 2025.pdf', created_at: '2026-07-22T00:00:00Z' }],
    ...extra,
  });
}
const Q = () => require('../lib/tax/w9_queue');
const quiet = async (fn) => { const o = [console.warn, console.log]; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { [console.warn, console.log] = o; } };

// ================================================================ STEP 1: queue
check('queue: vendor is the unit; one vendor row with BOTH associations beneath it (cross-association)', async () => {
  const db = world(); const q = await quiet(() => Q().loadW9Queue(db, { year: 2026 }));
  const lawn = q.vendors.find((v) => v.vendor_id === 'v-lawn');
  assert.ok(lawn, 'lawn on queue'); assert.strictEqual(q.vendors.filter((v) => v.vendor_id === 'v-lawn').length, 1);
  assert.deepStrictEqual(lawn.associations.map((a) => a.association).sort(), ['Canyon Gate', 'Waterview']);
  assert.strictEqual(lawn.action, 'W-9 request needed');
});
check('queue: books-of-record elsewhere (Eaglewood) and demo tenants are excluded (payments AND open bills)', async () => {
  const q = await quiet(() => Q().loadW9Queue(world(), { year: 2026 }));
  const assocs = q.vendors.flatMap((v) => v.associations.map((a) => a.community_id));
  assert.ok(!assocs.includes(CEW) && !assocs.includes(CDEMO));
  const lawn = q.vendors.find((v) => v.vendor_id === 'v-lawn');
  assert.strictEqual(lawn.reportable_cents, 550000, 'Eaglewood + demo payments not counted');
});
check('queue: no-open-bill items are included (compliance queue, not only AP exceptions)', async () => {
  const q = await quiet(() => Q().loadW9Queue(world(), { year: 2026 }));
  const lawn = q.vendors.find((v) => v.vendor_id === 'v-lawn');
  assert.strictEqual(lawn.open_flagged_bills, 0); assert.ok(lawn.associations.length === 2);
});
check('queue: actions from STORED facts: MUD -> government; own entity -> Provide Bedrock W-9; candidate -> review; satisfied vendor absent', async () => {
  const q = await quiet(() => Q().loadW9Queue(world(), { year: 2026 }));
  const by = Object.fromEntries(q.vendors.map((v) => [v.vendor_id, v]));
  assert.strictEqual(by['v-mud'].action, 'Government exemption needs verification');
  assert.strictEqual(by['v-mud'].open_flagged_bills, 1); assert.strictEqual(by['v-mud'].associations[0].autopay, true);
  assert.strictEqual(by['v-bed'].action, 'Provide Bedrock W-9'); assert.strictEqual(by['v-bed'].flags.own_entity, true);
  assert.strictEqual(by['v-saifee'].action, 'W-9 candidate found: review');
  assert.strictEqual(by['v-saifee'].candidates[0].source, 'email_attachment');
  assert.ok(!by['v-ok'], 'a vendor with a W-9 + classification is not on the queue');
});
check('queue: the Bedrock label never clears or exempts; it clears only when its W-9 + classification are stored', async () => {
  const db = world(); db.T.vendors.find((v) => v.id === 'v-bed').w9_on_file = true; db.T.vendors.find((v) => v.id === 'v-bed').tax_classification = 'llc_partnership';
  db.T.vendors.find((v) => v.id === 'v-bed').w9_uploaded_at = '2027-01-01T00:00:00Z';
  const q = await quiet(() => Q().loadW9Queue(db, { year: 2026 }));
  assert.ok(!q.vendors.find((v) => v.vendor_id === 'v-bed'));
  assert.ok(!/exempt/i.test(code('lib/tax/w9_queue.js').match(/isOwnEntity[^\n]*/g).join(' ')), 'own-entity flag is display only');
});
check('queue: a corporate name is a clue only (Inc. stays "W-9 request needed")', async () => {
  const db = world(); db.T.vendors.push(V('v-inc', 'Acme Pools, Inc.')); db.T.ap_payments.push(PAY('p9', 'v-inc', C1, 300000));
  const q = await quiet(() => Q().loadW9Queue(db, { year: 2026 }));
  const v = q.vendors.find((x) => x.vendor_id === 'v-inc'); assert.strictEqual(v.action, 'W-9 request needed'); assert.ok(/clue only/.test(v.name_clue));
});
check('queue: an emailed candidate causes NO mutation (the whole queue load writes nothing)', async () => {
  const db = world(); await quiet(() => Q().loadW9Queue(db, { year: 2026 }));
  assert.deepStrictEqual(db.writes, [], 'queue performed writes: ' + JSON.stringify(db.writes));
  assert.strictEqual(db.T.vendors.find((v) => v.id === 'v-saifee').w9_on_file, false);
  assert.strictEqual(db.T.vendor_documents.length, 0);
});
check('queue: a received but unconfirmed W-9 is "review", even below threshold; confirming clears it; a NEWER W-9 reopens review', () => {
  const f = (vendor, docs) => Q().buildQueue({ year: 2026, vendors: new Map([[vendor.id, vendor]]), totals: new Map(), flaggedBills: [], w9Docs: docs, attachments: [], ownEntityNames: new Set(), communityNames: new Map(), methods: new Map(), unlinkedSecureForm: [] });
  const doc = { id: 'd1', vendor_id: 'v1', doc_type: 'w9', is_current: true, uploaded_at: '2026-10-02T10:00:00Z' };
  assert.strictEqual(f(V('v1', 'X'), [doc]).vendors[0].action, 'Classification/document review needed');
  assert.strictEqual(f(V('v1', 'X', { w9_on_file: true, tax_classification: 'c_corporation', w9_uploaded_at: '2026-10-02T11:00:00Z' }), [doc]).vendors.length, 0);
  assert.strictEqual(f(V('v1', 'X', { w9_on_file: true, tax_classification: 'c_corporation', w9_uploaded_at: '2026-09-01T00:00:00Z' }), [doc]).vendors[0].action, 'Classification/document review needed');
});
check('queue: an unlinked secure-form W-9 shows as a high-confidence candidate; one with no vendor is listed as unassigned', async () => {
  const db = world({ vendor_ach_requests: [
    { id: 'r1', vendor_id: 'v-lawn', vendor_name: 'Lawn Pros', w9_doc_name: 'w9.pdf', w9_doc_path: 'p/r1-w9.pdf', submitted_at: '2026-09-01', status: 'submitted' },
    { id: 'r2', vendor_id: null, vendor_name: 'Mystery', w9_doc_name: 'w9.pdf', w9_doc_path: 'p/r2-w9.pdf', submitted_at: '2026-09-02', status: 'submitted' },
  ] });
  const q = await quiet(() => Q().loadW9Queue(db, { year: 2026 }));
  const lawn = q.vendors.find((v) => v.vendor_id === 'v-lawn');
  assert.ok(lawn.candidates.some((c) => c.source === 'secure_form' && c.confidence === 'high'));
  assert.strictEqual(q.unassigned_candidates.length, 1);
});
check('queue: a read failure is LOUD (throws -> API 500 with a clear panel message), never a silent empty queue', async () => {
  const db = world(); const orig = db.from; db.from = (t) => (t === 'vendor_documents' ? { select() { return this; }, eq() { return this; }, order() { return this; }, range() { return Promise.resolve({ data: null, error: { message: 'boom' } }); } } : orig(t));
  await assert.rejects(() => quiet(() => Q().loadW9Queue(db, { year: 2026 })));
  assert.ok(/W-9 compliance queue could not load .*Payments are not affected/.test(src('public/index.html')));
});
// Query shape guard (Ed 2026-10-02: the first build took 4.4 s with 23 serial
// requests, re-reading vendors 5x and payments 3x). Each fact is read once; the
// request count does not grow with vendors or associations; no read puts the
// whole vendor table in an .in() list.
function counted(db) {
  const reads = []; const orig = db.from;
  db.from = (t) => {
    const qq = orig(t); const ins = qq.in; const entry = { table: t, inSizes: [] }; reads.push(entry);
    qq.in = (c, vs) => { entry.inSizes.push([c, vs.length]); return ins(c, vs); };
    return qq;
  };
  return reads;
}
function bigWorld(nVendors) {
  const db = world();
  for (let i = 0; i < nVendors; i++) {
    const id = `v-big-${i}`; db.T.vendors.push(V(id, `Big Vendor ${i}`));
    db.T.ap_payments.push(PAY(`pb-${i}-1`, id, C1, 300000), PAY(`pb-${i}-2`, id, C2, 300000));
    db.T.ap_invoices.push({ id: `bb-${i}`, vendor_id: id, community_id: C1, total_cents: 5000, amount_paid_cents: 0, status: 'awaiting_approval' });
  }
  return db;
}
check('query shape: each table read once per load (vendors twice: contact + tax), no per-vendor queries', async () => {
  const db = bigWorld(40); const reads = counted(db);
  const q = await quiet(() => Q().loadW9Queue(db, { year: 2026 }));
  assert.ok(q.vendors.length >= 40);
  const per = {}; for (const r of reads) per[r.table] = (per[r.table] || 0) + 1;
  const CAP = { communities: 1, vendors: 2, ap_payments: 1, vendor_documents: 1, email_attachments: 1, vendor_ach_requests: 1, management_companies: 1, ap_payment_applications: 1, ap_invoices: 3 };
  for (const [t, n] of Object.entries(per)) assert.ok(n <= (CAP[t] ?? 0), `${t} read ${n}x (cap ${CAP[t] ?? 0}): ${JSON.stringify(per)}`);
});
check('query shape: request count is the SAME for 5 and 200 vendors (no N+1), and no .in() exceeds 200 ids', async () => {
  const small = bigWorld(5); const rs = counted(small); await quiet(() => Q().loadW9Queue(small, { year: 2026 }));
  const large = bigWorld(200); const rl = counted(large); await quiet(() => Q().loadW9Queue(large, { year: 2026 }));
  // 200 vendors -> 400 payments: one extra 200-id chunk each for applications/categories is the only growth allowed.
  assert.ok(rl.length - rs.length <= 4, `requests grew from ${rs.length} to ${rl.length}`);
  for (const r of rl) for (const [c, n] of r.inSizes) assert.ok(n <= 200, `${r.table}.${c} .in() with ${n} values`);
  assert.ok(!rl.some((r) => r.table === 'vendors' && r.inSizes.length), 'vendors are never read by an id list');
});
check('query shape: the queue computes flags with the SAME projectBills (context), not a copy', () => {
  const qsrc = code('lib/tax/w9_queue.js');
  assert.ok(/projectBills\(supabase, bills\.map/.test(qsrc) && /context: \{ outside, vendors: taxV, totals, categories: billCats \}/.test(qsrc));
  assert.ok(!/evaluatePayment\(/.test(qsrc), 'no second evaluation path in the queue');
});

check('queue API + panel are wired; panel is vendor-first and expandable; no stored queue state', () => {
  assert.ok(/router\.get\('\/w9-queue'/.test(src('api/ap.js')) && /loadW9Queue\(supabase, \{ year \}\)/.test(src('api/ap.js')));
  const ui = src('public/index.html');
  assert.ok(/id="ap-w9-queue"/.test(ui) && /apW9ToggleVendor/.test(ui) && /fetchFn\('\/api\/ap\/w9-queue'\)/.test(ui) && /try \{ apLoadW9Queue\(\); \} catch/.test(ui));
  assert.ok(!/from\('[a-z_]+'\)\.(insert|update|upsert|delete)/.test(code('lib/tax/w9_queue.js')), 'queue module never writes');
});

// ================================================================ STEP 2: canonical W-9 filing
const W = () => require('../lib/vendors/w9_documents');
check('filing: a secure-form W-9 becomes the CURRENT canonical document with provenance (source + request id)', async () => {
  const db = world();
  const r = await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r1', fileHash: 'h1', fileName: 'w9.pdf', fileUrl: 'p/r1-w9.pdf' });
  assert.strictEqual(r.duplicate, null);
  const d = db.T.vendor_documents[0];
  assert.strictEqual(d.is_current, true); assert.strictEqual(d.source, 'secure_form'); assert.strictEqual(d.vendor_ach_request_id, 'r1'); assert.strictEqual(d.vendor_id, 'v-lawn');
});
check('filing: never sets w9_on_file, a classification or an exemption (a person confirms)', async () => {
  const db = world();
  await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r1', fileHash: 'h1' });
  assert.ok(!db.writes.some((w) => w.table === 'vendors'), 'no vendor write');
  assert.ok(!/from\('vendors'\)/.test(code('lib/vendors/w9_documents.js')));
});
check('retry: the same request twice files ONE document (second returns duplicate same_request)', async () => {
  const db = world();
  await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r1', fileHash: 'h1' });
  const r2 = await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r1', fileHash: 'h-different' });
  assert.strictEqual(r2.duplicate, 'same_request'); assert.strictEqual(db.T.vendor_documents.length, 1);
});
check('retry race: a concurrent insert for the same request hits the unique index and returns the winner', async () => {
  const db = world();
  // Simulate: the prior-read missed the other writer's row, then the insert collides.
  const orig = db.from; let first = true;
  db.from = (t) => { const qq = orig(t); if (t === 'vendor_documents' && first) { first = false; const sel = qq.select; qq.select = (s) => { db.T.vendor_documents.push({ id: 'winner', vendor_id: 'v-lawn', doc_type: 'w9', is_current: true, vendor_ach_request_id: 'r1', source: 'secure_form' }); return sel(s); }; } return qq; };
  db.T.vendor_documents = [];
  const r = await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r1', fileHash: 'h9' });
  assert.ok(r.duplicate === 'same_request' && r.document.id === 'winner');
  assert.strictEqual(db.T.vendor_documents.filter((d) => d.vendor_ach_request_id === 'r1').length, 1);
});
check('dedup: byte-identical file already on file (any source) -> no new row', async () => {
  const db = world({ vendor_documents: [{ id: 'd0', vendor_id: 'v-lawn', doc_type: 'w9', is_current: true, file_hash: 'same', uploaded_at: '2026-01-01' }] });
  const r = await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r5', fileHash: 'same' });
  assert.strictEqual(r.duplicate, 'identical_file'); assert.strictEqual(db.T.vendor_documents.length, 1);
});
check('supersession: a new W-9 becomes current, the prior is KEPT as history (superseded_at), never two current rows', async () => {
  const db = world({ vendor_documents: [{ id: 'd0', vendor_id: 'v-lawn', doc_type: 'w9', is_current: true, file_hash: 'old', uploaded_at: '2026-01-01' }] });
  const r = await W().fileW9Document(db, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r6', fileHash: 'new' });
  assert.strictEqual(r.replaced_prior, true);
  const old = db.T.vendor_documents.find((d) => d.id === 'd0'); const neu = db.T.vendor_documents.find((d) => d.id !== 'd0');
  assert.strictEqual(old.is_current, false); assert.ok(old.superseded_at); assert.strictEqual(neu.is_current, true);
  // order: inserted non-current, prior demoted, new promoted (the fake enforces uq_vendor_w9_current on every step)
  const steps = db.writes.filter((w) => w.table === 'vendor_documents').map((w) => w.op + (w.op === 'insert' ? ':' + w.rows[0].is_current : ':' + JSON.stringify(w.payload.is_current)));
  assert.deepStrictEqual(steps, ['insert:false', 'update:false', 'update:true']);
});
check('supersession: a replacement W-9 on a CONFIRMED vendor reopens review; PATCH re-confirm moves w9_uploaded_at', () => {
  const p = code('api/vendors.js');
  assert.ok(/Date\.parse\(curDoc\[0\]\.uploaded_at\) > \(cur\.w9_uploaded_at \? Date\.parse\(cur\.w9_uploaded_at\) : 0\) \+ 1000/.test(p));
  assert.ok(/if \(!newer\) delete update\.w9_on_file;/.test(p) && /if \(update\.w9_on_file === true\) update\.w9_uploaded_at = new Date\(\)\.toISOString\(\);/.test(p));
});
check('pre-478: filing still works (base columns) and the provenance goes into notes', async () => {
  const db = world({}, ); const db2 = makeDb(db.T, { missing: ['vendor_documents.source', 'vendor_documents.vendor_ach_request_id'] });
  const r = await W().fileW9Document(db2, { vendorId: 'v-lawn', source: 'secure_form', achRequestId: 'r7', fileHash: 'h7', notes: 'Submitted by the vendor.' });
  assert.strictEqual(r.duplicate, null);
  assert.ok(/secure W-9 form \(request r7\)/.test(db2.T.vendor_documents[0].notes));
});
check('staff upload uses the SAME filing path (one versioning implementation)', () => {
  const v = code('api/vendors.js');
  assert.ok(/fileW9Document\(supabase, \{\s*vendorId, fileHash, contentHash, source: 'staff_upload'/.test(v));
  assert.ok(!/\.update\(\{ is_current: false, superseded_at/.test(v), 'no second supersede implementation in vendors.js');
});

// ================================================================ STEP 2: the secure form, over HTTP
function loadAch(db, admin = { email: 'admin@example.test', role: 'admin' }) {
  const sbPath = require.resolve('@supabase/supabase-js');
  const raPath = require.resolve('../api/_require_admin');
  const achPath = require.resolve('../api/ach');
  const saved = { sb: require.cache[sbPath], ra: require.cache[raPath] };
  delete require.cache[achPath];
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => db } };
  require.cache[raPath] = { id: raPath, filename: raPath, loaded: true, exports: { requireAdmin: async () => admin, requireOwner: async () => admin } };
  const { router } = require('../api/ach');
  require.cache[sbPath] = saved.sb; if (saved.ra) require.cache[raPath] = saved.ra; else delete require.cache[raPath];
  delete require.cache[achPath];
  const express = require('express'); const app = express(); app.use('/api/ach', router);
  return new Promise((resolve) => { const srv = http.createServer(app).listen(0, () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })); });
}
const pdf = () => new Blob([Buffer.from('%PDF-1.4 fake w9 ' + Math.random())], { type: 'application/pdf' });
async function submit(base, token, fields = {}, w9 = pdf()) {
  const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); if (w9) fd.append('w9', w9, 'W-9.pdf');
  const r = await fetch(`${base}/api/ach/form/${token}`, { method: 'POST', body: fd }); return { status: r.status, j: await r.json() };
}
async function createLink(base, body) {
  const r = await fetch(`${base}/api/ach/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); return { status: r.status, j, token: j.link ? j.link.split('/').filter(Boolean).pop() : null };
}
check('W-9-only link: requires a vendor record; an unknown or foreign vendor is refused', async () => {
  const db = world(); db.T.vendors.push(V('v-other-co', 'Other Co Vendor', { management_company_id: 'someone-else' }));
  const { srv, base } = await loadAch(db);
  try {
    assert.strictEqual((await createLink(base, { vendor_name: 'Lawn Pros', request_kind: 'w9_only' })).status, 400);
    assert.strictEqual((await createLink(base, { vendor_name: 'X', request_kind: 'w9_only', vendor_id: 'nope' })).j.error, 'unknown_vendor');
    assert.strictEqual((await createLink(base, { vendor_name: 'X', request_kind: 'w9_only', vendor_id: 'v-other-co' })).j.error, 'unknown_vendor');
    const ok = await createLink(base, { vendor_name: 'Lawn Pros', request_kind: 'w9_only', vendor_id: 'v-lawn' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.j)); assert.strictEqual(db.T.vendor_ach_requests[0].request_kind, 'w9_only');
    const ctx = await (await fetch(`${base}/api/ach/form/${ok.token}`)).json();
    assert.strictEqual(ctx.request_kind, 'w9_only'); assert.strictEqual(ctx.usable, true);
  } finally { srv.close(); }
});
check('W-9-only submit: no banking needed, W-9 required, filed to the REQUEST\'s vendor as current canonical doc; no banking stored', async () => {
  const db = world(); const { srv, base } = await loadAch(db);
  try {
    const { token } = await createLink(base, { vendor_name: 'Lawn Pros', request_kind: 'w9_only', vendor_id: 'v-lawn' });
    assert.strictEqual((await quiet(() => submit(base, token, {}, null))).status, 400, 'W-9 required');
    const r = await quiet(() => submit(base, token, { vendor_id: 'v-saifee' })); // a forged vendor_id in the form is ignored
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    const docs = db.T.vendor_documents; assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].vendor_id, 'v-lawn', 'filed to the request vendor, not the forged one');
    assert.strictEqual(docs[0].source, 'secure_form'); assert.strictEqual(docs[0].vendor_ach_request_id, db.T.vendor_ach_requests[0].id); assert.strictEqual(docs[0].is_current, true);
    const req0 = db.T.vendor_ach_requests[0];
    assert.strictEqual(req0.status, 'submitted'); assert.ok(req0.w9_library_document_id);
    assert.ok(req0.account_number_full == null && req0.routing_number == null && req0.account_type == null, 'no banking fields written');
    assert.strictEqual(db.T.vendors.find((v) => v.id === 'v-lawn').w9_on_file, false, 'W-9 not marked on file automatically');
  } finally { srv.close(); }
});
check('duplicate submit: a second POST on the same link is refused (409) and files nothing more', async () => {
  const db = world(); const { srv, base } = await loadAch(db);
  try {
    const { token } = await createLink(base, { vendor_name: 'Lawn Pros', request_kind: 'w9_only', vendor_id: 'v-lawn' });
    assert.strictEqual((await quiet(() => submit(base, token))).status, 200);
    const again = await quiet(() => submit(base, token));
    assert.strictEqual(again.status, 409); assert.ok(/already submitted/.test(again.j.error));
    assert.strictEqual(db.T.vendor_documents.length, 1); assert.strictEqual(db.T.library_documents.filter((d) => d.category === 'w9').length, 1);
  } finally { srv.close(); }
});
check('double-submit race: the loser of the status update gets 409 and files no library or vendor document', async () => {
  const db = world(); const { srv, base } = await loadAch(db);
  try {
    const { token } = await createLink(base, { vendor_name: 'Lawn Pros', request_kind: 'w9_only', vendor_id: 'v-lawn' });
    // Let the request read 'sent', then another submission wins before our update.
    const orig = db.from; let flipped = false;
    db.from = (t) => { const qq = orig(t); if (t === 'vendor_ach_requests' && !flipped) { const up = qq.update; qq.update = (p) => { flipped = true; db.T.vendor_ach_requests[0].status = 'submitted'; return up(p); }; } return qq; };
    const r = await quiet(() => submit(base, token));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(db.T.vendor_documents.length, 0); assert.strictEqual((db.T.library_documents || []).length, 0);
  } finally { srv.close(); }
});
check('ACH link with a W-9 attached: the W-9 is filed canonically too (same path); banking still required', async () => {
  const db = world(); const { srv, base } = await loadAch(db);
  try {
    const { token } = await createLink(base, { vendor_name: 'Lawn Pros', vendor_id: 'v-lawn' });
    assert.strictEqual(db.T.vendor_ach_requests[0].request_kind, 'ach');
    assert.strictEqual((await quiet(() => submit(base, token, {}))).status, 400, 'banking required on an ACH link');
    const r = await quiet(() => submit(base, token, { account_holder_name: 'Lawn Pros LLC', bank_name: 'Bank', account_type: 'checking', routing_number: '021000021', account_number: '123456789', confirm_account_number: '123456789', signer_name: 'Pat', authorization_agreed: 'true' }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    assert.strictEqual(db.T.vendor_documents.length, 1); assert.strictEqual(db.T.vendor_documents[0].vendor_id, 'v-lawn');
  } finally { srv.close(); }
});
check('ACH link with NO vendor record: W-9 kept (library + request), not filed to any vendor (shown as unassigned)', async () => {
  const db = world(); const { srv, base } = await loadAch(db);
  try {
    const { token } = await createLink(base, { vendor_name: 'New Vendor' });
    const r = await quiet(() => submit(base, token, { account_holder_name: 'N', bank_name: 'B', account_type: 'checking', routing_number: '021000021', account_number: '1234567', confirm_account_number: '1234567', signer_name: 'N', authorization_agreed: 'true' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.T.vendor_documents.length, 0); assert.ok(db.T.vendor_ach_requests[0].w9_doc_path);
    const q = await quiet(() => Q().loadW9Queue(db, { year: 2026 })); assert.strictEqual(q.unassigned_candidates.length, 1);
  } finally { srv.close(); }
});
check('pre-478: ACH links keep working; a W-9-only link is refused with a clear message', async () => {
  const db = makeDb(world().T, { missing: ['vendor_ach_requests.request_kind', 'vendor_documents.source', 'vendor_documents.vendor_ach_request_id'] });
  const { srv, base } = await loadAch(db);
  try {
    const w = await createLink(base, { vendor_name: 'Lawn Pros', request_kind: 'w9_only', vendor_id: 'v-lawn' });
    assert.strictEqual(w.status, 409); assert.strictEqual(w.j.error, 'w9_only_unavailable');
    const a = await createLink(base, { vendor_name: 'Lawn Pros', vendor_id: 'v-lawn' });
    assert.strictEqual(a.status, 200); assert.strictEqual(a.j.request.request_kind, 'ach');
    const ctx = await (await fetch(`${base}/api/ach/form/${a.token}`)).json(); assert.strictEqual(ctx.request_kind, 'ach');
    const list = await (await fetch(`${base}/api/ach/requests`)).json(); assert.strictEqual(list.requests.length, 1);
  } finally { srv.close(); }
});
check('vendor form page + admin page: W-9-only mode hides banking, requires the W-9; admin requires a vendor record', () => {
  const f = src('public/ach-form.html');
  assert.ok(/if \(j\.request_kind === 'w9_only'\) applyW9Only\(\);/.test(f) && /\$\('ach-fields'\)\.hidden = true; \$\('auth-fields'\)\.hidden = true;/.test(f));
  assert.ok(/Please attach your W-9\./.test(f));
  const a = src('public/ach-admin.html');
  assert.ok(/<option value="w9_only">W-9 only<\/option>/.test(a) && /Choose the vendor record the W-9 belongs to\./.test(a));
});

// ================================================================ nothing can block a payment
check('no payment path imports the queue or the filing helper; neither touches payments, bills or checks', () => {
  for (const f of ['lib/accounting/check_run.js', 'lib/accounting/ap_engine.js', 'api/checks.js', 'lib/tax/payment_gate.js']) {
    assert.ok(!/w9_queue|w9_documents/.test(src(f)), f);
  }
  for (const f of ['lib/tax/w9_queue.js', 'lib/vendors/w9_documents.js']) {
    assert.ok(!/from\('(ap_payments|ap_invoices|check_register|journal_entries)'\)\.(insert|update|delete|upsert)/.test(code(f)), f);
  }
  assert.ok(!/\bthrow\b/.test(code('lib/tax/payment_gate.js')), 'payment gate still cannot throw');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('W-9 queue + secure-form canonical W-9 (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
