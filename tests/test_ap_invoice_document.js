#!/usr/bin/env node
// ============================================================================
// tests/test_ap_invoice_document.js  (Issue #9 step 1, ChatGPT review of 31273c33)
// ----------------------------------------------------------------------------
// Document retention lives in the canonical intake rail, so every door gets it.
// Runs the REAL commitInvoice (and ensureInvoiceDocument) against an in-memory
// Supabase fake injected before lib/ap/intake.js loads. Proves:
//   1. a manual-upload commit creates the vendor_invoice library_documents row
//      and links ap_invoices.source_document_id;
//   2. an email commit does the same;
//   3. retrying the same stored file does not create a second document row;
//   4. the invoice's source_document_id, source_storage_path, file_sha256 and
//      filename all point at the same stored PDF, and the document row carries
//      the same path + hash;
//   5. a failed document write never drops the bill silently: it loads with
//      needs_review and the reason in its notes.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const Module = require('module');

const db = { ap_invoices: [], ap_invoice_lines: [], library_documents: [], communities: [{ id: 'C1', name: 'Sample HOA', management_company_id: 'M1', active: true }] };
let failDocInsert = false;
function fakeClient() {
  return {
    from(table) {
      const st = { table, filters: [], op: 'select', payload: null };
      const rows = () => (db[table] || []).filter((r) => st.filters.every(([c, v]) => r[c] === v));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(c, v) { st.filters.push([c, v]); return q; }, neq() { return q; }, in() { return q; }, is() { return q; },
        ilike() { return q; }, or() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; }, gt() { return q; },
        insert(p) {
          st.op = 'insert';
          if (table === 'library_documents' && failDocInsert) { st.error = { message: 'permission denied for table library_documents' }; return q; }
          const list = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${table}-${(db[table] || []).length + i + 1}`, ...r }));
          if (!db[table]) db[table] = [];
          db[table].push(...list);
          st.inserted = list;
          return q;
        },
        update(p) { st.op = 'update'; st.payload = p; return q; },
        async single() { if (st.error) return { data: null, error: st.error }; return { data: st.inserted ? st.inserted[0] : (rows()[0] || null), error: null }; },
        async maybeSingle() { return { data: st.op === 'insert' ? st.inserted[0] : (rows()[0] || null), error: null }; },
        then(res, rej) {
          if (st.op === 'update') { for (const r of rows()) Object.assign(r, st.payload); return Promise.resolve({ data: null, error: null }).then(res, rej); }
          if (st.op === 'insert') return Promise.resolve({ data: st.inserted || null, error: st.error || null }).then(res, rej);
          return Promise.resolve({ data: rows(), error: null }).then(res, rej);
        },
      };
      return q;
    },
    storage: { from() { return { upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }) }; } },
  };
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';
const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  if (request === '@anthropic-ai/sdk') { const B = function () { this.messages = { create: async () => { throw new Error('network blocked in test'); } }; }; B.default = B; return B; }
  return realLoad.apply(this, arguments);
};
const { commitInvoice } = require('../lib/ap/intake');

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const extracted = (n, over) => Object.assign({
  vendor_name: 'RMWBH', invoice_number: n, invoice_date: '2026-09-15', total_cents: 4200, subtotal_cents: 4200, tax_cents: 0,
  line_items: [{ description: 'Collection legal services', amount: 42 }], _filename: `RMWBH ${n}.pdf`, _file_size: 12345,
}, over || {});
const invById = (id) => db.ap_invoices.find((r) => r.id === id);

(async () => {
  console.log('test_ap_invoice_document');

  await t('manual upload commit creates + links the canonical vendor_invoice document', async () => {
    const r = await commitInvoice({ extracted: extracted('PS-1'), vendorId: 'V1', communityId: 'C1', sha256: 'sha-aaa', storagePath: 'ap_invoices/sha-aaa_RMWBH.pdf', intakeMethod: 'manual_upload', sourceRef: 'upload:sha-aaa' });
    const inv = invById(r.invoice_id);
    assert.ok(inv, 'invoice inserted');
    const doc = db.library_documents.find((d) => d.id === inv.source_document_id);
    assert.ok(doc, 'source_document_id points at a library_documents row');
    assert.strictEqual(doc.category, 'vendor_invoice');
    assert.strictEqual(doc.community_id, 'C1');
    assert.strictEqual(doc.management_company_id, 'M1');
  });

  await t('email commit does the same', async () => {
    const r = await commitInvoice({ extracted: extracted('PS-2'), vendorId: 'V1', communityId: 'C1', sha256: 'sha-bbb', storagePath: 'ap_invoices/sha-bbb_RMWBH.pdf', intakeMethod: 'email', sourceRef: 'email:graph-1' });
    const inv = invById(r.invoice_id);
    assert.ok(inv.source_document_id);
    assert.strictEqual(db.library_documents.find((d) => d.id === inv.source_document_id).file_hash, 'sha-bbb');
  });

  await t('retrying the same stored file reuses the document (no second row)', async () => {
    const before = db.library_documents.filter((d) => d.file_hash === 'sha-aaa').length;
    const { ensureInvoiceDocument } = require('../lib/ap/invoice_document');
    const again = await ensureInvoiceDocument(fakeClient(), { communityId: 'C1', vendorName: 'RMWBH', invoiceNumber: 'PS-1', storagePath: 'ap_invoices/sha-aaa_RMWBH.pdf', sha256: 'sha-aaa' });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.existing, true);
    assert.strictEqual(db.library_documents.filter((d) => d.file_hash === 'sha-aaa').length, before, 'no duplicate document row');
  });

  await t('invoice + document provenance point at the same stored PDF', async () => {
    const inv = db.ap_invoices.find((r) => r.vendor_invoice_number === 'PS-1');
    const doc = db.library_documents.find((d) => d.id === inv.source_document_id);
    assert.strictEqual(inv.source_storage_path, 'ap_invoices/sha-aaa_RMWBH.pdf');
    assert.strictEqual(doc.file_path, inv.source_storage_path);
    assert.strictEqual(inv.file_sha256, 'sha-aaa');
    assert.strictEqual(doc.file_hash, inv.file_sha256);
    assert.strictEqual(inv.source_filename, 'RMWBH PS-1.pdf');
    assert.strictEqual(doc.file_name_original, 'RMWBH PS-1.pdf');
    assert.strictEqual(doc.file_size_bytes, 12345);
  });

  await t('a failed document write loads the bill flagged for review (not on hold) with the reason (never silent)', async () => {
    failDocInsert = true;
    const r = await commitInvoice({ extracted: extracted('PS-3'), vendorId: 'V1', communityId: 'C1', sha256: 'sha-ccc', storagePath: 'ap_invoices/sha-ccc_RMWBH.pdf', intakeMethod: 'email', sourceRef: 'email:graph-2' });
    failDocInsert = false;
    const inv = invById(r.invoice_id);
    assert.ok(inv, 'the bill still loads');
    assert.strictEqual(inv.source_document_id, null);
    assert.strictEqual(inv.needs_review, true);
    assert.strictEqual(inv.status, 'awaiting_approval', 'flagged for review, not on hold');
    assert.ok(/Source document not indexed .*loaded and flagged for review/.test(inv.notes), inv.notes);
    assert.strictEqual(r.needs_review, true);
  });

  await t('no stored PDF (stash failed) is also loaded and flagged for review, not silently accepted', async () => {
    const r = await commitInvoice({ extracted: extracted('PS-4'), vendorId: 'V1', communityId: 'C1', sha256: 'sha-ddd', storagePath: null, intakeMethod: 'email', sourceRef: 'email:graph-3' });
    const inv = invById(r.invoice_id);
    assert.strictEqual(inv.needs_review, true);
    assert.ok(/source PDF was not stored/.test(inv.notes));
  });

  await t('race: a concurrent run files the same PDF between our lookup and insert → unique conflict returns the winner, no second row', async () => {
    // A fake that enforces migration 472's partial unique index and lets a
    // competing intake run insert right after our SELECT saw nothing.
    const docs = [];
    let competitorInserted = false;
    const raceClient = {
      from(table) {
        const st = { filters: [], op: 'select' };
        const q = {
          select() { return q; }, order() { return q; }, limit() { return q; },
          eq(c, v) { st.filters.push([c, v]); return q; },
          maybeSingle: async () => ({ data: table === 'communities' ? { name: 'Sample HOA', management_company_id: 'M1' } : null, error: null }),
          insert(p) {
            st.op = 'insert';
            const clash = docs.find((d) => d.category === 'vendor_invoice' && d.community_id === p.community_id && d.file_hash === p.file_hash);
            if (clash) { st.error = { code: '23505', message: 'duplicate key value violates unique constraint "uq_library_documents_vendor_invoice_hash"' }; return q; }
            st.row = { id: 'doc-' + (docs.length + 1), ...p }; docs.push(st.row); return q;
          },
          single: async () => (st.error ? { data: null, error: st.error } : { data: st.row, error: null }),
          then(res, rej) {
            const rows = docs.filter((d) => st.filters.every(([c, v]) => d[c] === v));
            const out = { data: rows, error: null };
            // After OUR first lookup comes back empty, the competitor files it.
            if (table === 'library_documents' && st.op === 'select' && !competitorInserted && !rows.length) {
              competitorInserted = true;
              docs.push({ id: 'doc-winner', category: 'vendor_invoice', community_id: 'C1', file_hash: 'sha-race', file_path: 'ap_invoices/sha-race_x.pdf' });
            }
            return Promise.resolve(out).then(res, rej);
          },
        };
        return q;
      },
    };
    const { ensureInvoiceDocument } = require('../lib/ap/invoice_document');
    const r = await ensureInvoiceDocument(raceClient, { communityId: 'C1', vendorName: 'RMWBH', invoiceNumber: 'PS-R', storagePath: 'ap_invoices/sha-race_x.pdf', sha256: 'sha-race' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.id, 'doc-winner');
    assert.strictEqual(r.raced, true);
    assert.strictEqual(docs.filter((d) => d.file_hash === 'sha-race').length, 1, 'exactly one document row');
  });

  await t('race: a non-unique insert error is still reported, never swallowed', async () => {
    const errClient = { from(table) { const q = { select() { return q; }, order() { return q; }, limit() { return q; }, eq() { return q; },
      maybeSingle: async () => ({ data: { name: 'X', management_company_id: 'M1' }, error: null }),
      insert() { return q; }, single: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
      then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return q; } };
    const { ensureInvoiceDocument } = require('../lib/ap/invoice_document');
    const r = await ensureInvoiceDocument(errClient, { communityId: 'C1', storagePath: 'p', sha256: 'h' });
    assert.strictEqual(r.ok, false);
    assert.ok(/permission denied/.test(r.reason));
  });

  await t('upload: a picked community that is not an active Bedrock community is held, never used', async () => {
    const { autoIntake } = require('../lib/ap/intake');
    const out = await autoIntake({
      buffer: Buffer.from('%PDF'), filename: 'x.pdf', intakeMethod: 'manual_upload', sourceRef: 'upload:zzz',
      pickedCommunityId: 'C1', // exists in the fake, but not under the Bedrock management company
    }, {
      stageInvoice: async () => ({ extracted: extracted('PS-9', { community_hint: null, looks_like_invoice: true }), sha256: 'sha-zzz', storagePath: 'ap_invoices/sha-zzz_x.pdf' }),
      detectReimbursementIntent: async () => ({ is_reimbursement: false }),
    });
    assert.strictEqual(out.outcome, 'needs_review');
    assert.ok(out.community_unknown, JSON.stringify(out).slice(0, 200));
    assert.ok(!db.ap_invoices.some((r) => r.vendor_invoice_number === 'PS-9'), 'nothing committed');
  });

  Module._load = realLoad;
  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
