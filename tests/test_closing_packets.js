// ============================================================================
// tests/test_closing_packets.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Home Sales files every scanned closing packet (lib/home_sales/closing_packets.js)
// and lists packets no recorded closing points at. Invented values only.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CP = require('../lib/home_sales/closing_packets');

const tests = []; const check = (n, fn) => tests.push([n, fn]);

// A small supabase double: library_documents + home_sales + storage.
function fakeDb({ docs = [], sales = [], failUpload = false } = {}) {
  const t = { library_documents: docs.slice(), home_sales: sales.slice() };
  const uploads = [];
  const q = (name) => {
    let rows = t[name]; const f = []; let ins = null; let upd = null; let single = false;
    const api = {
      select: () => api, order: () => api, limit: () => api,
      eq: (c, v) => { f.push((r) => r[c] === v); return api; },
      like: (c, v) => { const re = new RegExp('^' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 's'); f.push((r) => re.test(String(r[c] || ''))); return api; },
      in: (c, vs) => { f.push((r) => vs.includes(r[c])); return api; },
      insert: (row) => { ins = row; return api; },
      update: (row) => { upd = row; return api; },
      single: () => { single = true; return api; }, maybeSingle: () => { single = true; return api; },
      then: (res, rej) => {
        if (ins) { const row = { id: 'doc-' + (t[name].length + 1), ...ins }; t[name].push(row); return Promise.resolve({ data: { id: row.id }, error: null }).then(res, rej); }
        const hit = rows.filter((r) => f.every((fn) => fn(r)));
        if (upd) { hit.forEach((r) => Object.assign(r, upd)); return Promise.resolve({ data: hit, error: null }).then(res, rej); }
        return Promise.resolve({ data: single ? (hit[0] || null) : hit, error: null }).then(res, rej);
      },
    };
    return api;
  };
  return { t, uploads, from: q, storage: { from: () => ({ upload: async (p, b) => { uploads.push(p); return { error: failUpload ? { message: 'bucket unavailable' } : null }; } }) } };
}

const extracted = {
  property_address: '100 Example Lane, Sampletown TX', closing_date: '2031-09-22', seller_name: 'Example Builder Ltd.', buyer_name: 'Pat Buyer',
  title_company_name: 'Example Title', checks: [{ check_number: '1001', amount_cents: 99000, payee: 'Example HOA', classification: 'ASSOCIATION' }, { check_number: '1002', amount_cents: 35000, payee: 'Bedrock Association Management', classification: 'BEDROCK_FEE' }],
};

check('a scanned packet is filed once: storage + one library_documents row with the reading', async () => {
  const db = fakeDb();
  const r = await CP.fileClosingPacket(db, { communityId: 'c1', managementCompanyId: 'm1', buffer: Buffer.from('pdf-bytes'), fileName: 'packet 1.pdf', mime: 'application/pdf', extracted, match: { status: 'matched' }, propertyId: 'p1' });
  assert.strictEqual(r.deduped, false);
  assert.strictEqual(db.t.library_documents.length, 1);
  const row = db.t.library_documents[0];
  assert.strictEqual(row.category, 'scanned_mail');
  assert.strictEqual(row.source_origin, 'mail_scan');
  assert.ok(/^home-sales\/c1\/[0-9a-f]{12}-packet_1\.pdf$/.test(row.file_path), row.file_path);
  const n = JSON.parse(row.extraction_notes);
  assert.strictEqual(n.kind, 'closing_packet');
  assert.strictEqual(n.property_id, 'p1');
  assert.strictEqual(n.closing_date, '2031-09-22');
  assert.deepStrictEqual(n.checks.map((c) => c.amount_cents), [99000, 35000]);
  assert.ok(row.title.includes('settled 2031-09-22'));
  const again = await CP.fileClosingPacket(db, { communityId: 'c1', buffer: Buffer.from('pdf-bytes'), extracted, propertyId: 'p1' });
  assert.strictEqual(again.deduped, true);
  assert.strictEqual(db.t.library_documents.length, 1);
});

check('a re-scan that identifies the lot fills in a packet filed without one', async () => {
  const db = fakeDb();
  await CP.fileClosingPacket(db, { communityId: 'c1', buffer: Buffer.from('x'), extracted, match: { status: 'none' }, propertyId: null });
  await CP.fileClosingPacket(db, { communityId: 'c1', buffer: Buffer.from('x'), extracted, match: { status: 'matched' }, propertyId: 'p9' });
  assert.strictEqual(JSON.parse(db.t.library_documents[0].extraction_notes).property_id, 'p9');
});

check('a storage failure throws (the screen says the packet was not filed); nothing half-written', async () => {
  const db = fakeDb({ failUpload: true });
  await assert.rejects(() => CP.fileClosingPacket(db, { communityId: 'c1', buffer: Buffer.from('y'), extracted }), /bucket unavailable/);
  assert.strictEqual(db.t.library_documents.length, 0);
});

check('missing community or file is refused', async () => {
  await assert.rejects(() => CP.fileClosingPacket(fakeDb(), { buffer: Buffer.from('z') }), /community_id_required/);
  await assert.rejects(() => CP.fileClosingPacket(fakeDb(), { communityId: 'c1', buffer: Buffer.alloc(0) }), /file_required/);
});

check('unrecorded packets = closing packets no home sale points at; mail and other communities excluded', async () => {
  const db = fakeDb();
  await CP.fileClosingPacket(db, { communityId: 'c1', buffer: Buffer.from('a'), extracted, propertyId: 'p1' });
  await CP.fileClosingPacket(db, { communityId: 'c1', buffer: Buffer.from('b'), extracted: { ...extracted, closing_date: '2031-09-16' }, propertyId: 'p2' });
  await CP.fileClosingPacket(db, { communityId: 'c2', buffer: Buffer.from('c'), extracted, propertyId: 'p3' });
  db.t.library_documents.push({ id: 'mail-1', community_id: 'c1', category: 'scanned_mail', extraction_notes: '{"type":"Vendor Invoice"}' });
  db.t.home_sales.push({ id: 's1', source_document_id: db.t.library_documents[0].id });
  const list = await CP.listUnrecordedPackets(db, 'c1');
  assert.deepStrictEqual(list.map((p) => p.closing_date), ['2031-09-16']);
  assert.strictEqual(list[0].property_id, 'p2');
});

check('wiring: scan files the packet; record-closing links it; the list endpoint and screen exist', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'home_sales.js'), 'utf8');
  assert.ok(/CP\.fileClosingPacket\(supabase/.test(api), 'scan files the packet');
  assert.ok(/source_document_id: packet && packet\.id/.test(api), 'scan returns the document id');
  assert.ok(/source_document_id: b\.source_document_id/.test(api), 'record-closing links the packet');
  assert.ok(/router\.get\('\/closing-packets'/.test(api));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'home_sales.html'), 'utf8');
  assert.ok(ui.includes('Closing packets not yet recorded'));
  assert.ok(/source_document_id: window\._scanDocId/.test(ui));
});

(async () => {
  let fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  }
  console.log(`\n${tests.length - fail}/${tests.length} closing packet tests passed`);
  process.exit(fail ? 1 : 0);
})();
