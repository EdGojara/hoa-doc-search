#!/usr/bin/env node
// ============================================================================
// tests/test_ap_upload_intake.js  (Issue #9 prerequisite)
// ----------------------------------------------------------------------------
// The Payables-tab upload now runs the canonical AP intake rail (the same as
// Emma's email door). Locks:
//   1. applyPickedCommunity(): a community picked on the upload screen is
//      authoritative when the bill names none, kept when the bill agrees, and a
//      disagreement is a mismatch (held for a person), never silently resolved;
//   2. mapUploadOutcome(): every canonical outcome maps to what the screen shows
//      (loaded / held duplicate / blocked duplicate / needs review with the
//      exception id), never an unexplained success;
//   3. the upload route really delegates to autoIntake with intakeMethod
//      'manual_upload', a stable upload source ref and the picked community,
//      records an exception for a needs-review bill, and no longer calls the
//      old ap_engine.createInvoice path (driven through the real handler with
//      stubbed dependencies).
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const Module = require('module');
const path = require('path');

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}

(async () => {
  console.log('test_ap_upload_intake');
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
  process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'x';

  const { applyPickedCommunity } = require('../lib/ap/intake');
  const { mapUploadOutcome } = require('../lib/ap/upload_outcome');

  await t('picked community: used when the bill names none', () => {
    assert.deepStrictEqual(applyPickedCommunity(null, null, 'C1'), { cid: 'C1', cidSource: 'staff_picked', mismatch: false });
  });
  await t('picked community: bill agrees → keeps the PDF source', () => {
    assert.deepStrictEqual(applyPickedCommunity('C1', 'pdf', 'C1'), { cid: 'C1', cidSource: 'pdf', mismatch: false });
  });
  await t('picked community: bill names a different association → mismatch (held), never overridden', () => {
    const r = applyPickedCommunity('C2', 'pdf', 'C1');
    assert.strictEqual(r.mismatch, true);
    assert.strictEqual(r.cid, 'C2');
  });
  await t('no picked community → unchanged (email door behavior)', () => {
    assert.deepStrictEqual(applyPickedCommunity('C2', 'pdf', null), { cid: 'C2', cidSource: 'pdf', mismatch: false });
    assert.deepStrictEqual(applyPickedCommunity(null, null, null), { cid: null, cidSource: null, mismatch: false });
  });

  await t('outcome map: loaded / held / blocked / needs review / not an invoice', () => {
    const inv = { id: 'i1', total_cents: 1000, auto_coded: true, auto_coding_confidence: 'high' };
    const ok = mapUploadOutcome({ outcome: 'loaded', invoice_id: 'i1', posting_journal_entry_id: 'je1' }, { invoice: inv, vendor: { name: 'V' }, lines: [{}] });
    assert.strictEqual(ok.http, 200); assert.strictEqual(ok.body.status, 'ok'); assert.strictEqual(ok.body.posted, true); assert.strictEqual(ok.body.coding_confidence, 'high');
    const held = mapUploadOutcome({ outcome: 'held_suspected_duplicate', invoice_id: 'i1', duplicate_of: 'i0' }, { invoice: inv });
    assert.strictEqual(held.body.status, 'held_duplicate'); assert.ok(/ON HOLD/.test(held.body.message));
    const blocked = mapUploadOutcome({ outcome: 'blocked_duplicate', duplicate_of: 'i0', matches: [{ reason: 'same file' }] });
    assert.strictEqual(blocked.http, 409); assert.strictEqual(blocked.body.status, 'duplicate_invoice'); assert.strictEqual(blocked.body.message, 'same file');
    const nr = mapUploadOutcome({ outcome: 'needs_review', reason: 'vendor not matched' }, { exceptionId: 'x1' });
    assert.strictEqual(nr.body.status, 'needs_review'); assert.strictEqual(nr.body.exception_id, 'x1'); assert.strictEqual(nr.body.exception_recorded, true);
    const notInv = mapUploadOutcome({ outcome: 'not_an_invoice' }, {});
    assert.strictEqual(notInv.body.status, 'needs_review'); assert.strictEqual(notInv.body.exception_recorded, false);
    assert.strictEqual(mapUploadOutcome({ outcome: 'weird' }).http, 500);
  });

  // ---- drive the real route with stubbed dependencies ----------------------
  const calls = { autoIntake: [], recordException: [], createInvoice: 0 };
  let nextOutcome = { outcome: 'loaded', invoice_id: 'inv-1', posting_journal_entry_id: 'je-1', needs_review: false };
  const chain = (rows) => { const q = { select: () => q, eq: () => q, order: () => q, in: () => q, maybeSingle: () => Promise.resolve({ data: rows[0] || null, error: null }), then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; };
  const intakePath = path.resolve(__dirname, '../lib/ap/intake.js');
  const excPath = path.resolve(__dirname, '../lib/ap/intake_exceptions.js');
  const enginePath = path.resolve(__dirname, '../lib/accounting/ap_engine.js');
  const origLoad = Module._load;
  Module._load = function (req, parent, ...rest) {
    let resolved = null;
    try { resolved = Module._resolveFilename(req, parent); } catch (_) { /* external */ }
    // No network, ever: any real extractor call fails loudly instead of calling out.
    if (req === '@anthropic-ai/sdk') { const Blocked = function () { this.messages = { create: async () => { throw new Error('network blocked in test'); } }; }; Blocked.default = Blocked; return Blocked; }
    if (req === '@supabase/supabase-js') return { createClient: () => ({ from: (t) => chain(t === 'ap_invoices' ? [{ id: 'inv-1', total_cents: 4200, auto_coded: true, auto_coding_confidence: 'high', vendors: { id: 'v1', name: 'RMWBH' } }] : [{ id: 'l1', line_number: 1, description: 'Legal', amount_cents: 4200 }]), storage: { from: () => ({}) } }) };
    if (resolved === intakePath) return Object.assign({}, origLoad.call(this, req, parent, ...rest), { autoIntake: async (a) => { calls.autoIntake.push(a); return nextOutcome; } });
    if (resolved === excPath) return { recordException: async (a) => { calls.recordException.push(a); return { ok: true, id: 'exc-1' }; } };
    if (resolved === enginePath) { const real = origLoad.call(this, req, parent, ...rest); return Object.assign({}, real, { createInvoice: async () => { calls.createInvoice += 1; throw new Error('legacy path must not be used'); } }); }
    return origLoad.call(this, req, parent, ...rest);
  };
  const { router } = require('../api/ap.js');
  // Keep the stub active until the end: the handler requires lib/ap/intake
  // lazily per request, and the real one would call the extractor.
  const layer = router.stack.find((l) => l.route && l.route.path === '/invoices/upload' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const run = (body, file) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } };
    handler({ body, file, headers: {} }, res);
  });
  const pdf = { originalname: 'RMWBH inv 343615.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') };
  const CID = '11111111-2222-4333-8444-555555555555';

  await t('route: loaded bill goes through autoIntake (manual_upload, upload: source ref, picked community)', async () => {
    const r = await run({ community_id: CID }, pdf);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.status, 'ok');
    assert.strictEqual(r.body.invoice.id, 'inv-1');
    const a = calls.autoIntake[0];
    assert.strictEqual(a.intakeMethod, 'manual_upload');
    assert.ok(/^upload:[0-9a-f]{16}$/.test(a.sourceRef));
    assert.strictEqual(a.pickedCommunityId, CID);
    assert.strictEqual(a.communityId, undefined, 'picked community is not passed as the low-trust email community');
    assert.strictEqual(calls.createInvoice, 0, 'legacy ap_engine.createInvoice path not used');
  });

  await t('route: needs-review bill is captured as a Payables exception with its PDF', async () => {
    nextOutcome = { outcome: 'needs_review', reason: 'vendor not matched', extracted: { vendor_name: 'X' }, storage_path: 'ap_invoices/abc_x.pdf', sha256: 'abc' };
    const r = await run({ community_id: CID }, pdf);
    assert.strictEqual(r.body.status, 'needs_review');
    assert.strictEqual(r.body.exception_id, 'exc-1');
    const e = calls.recordException[0];
    assert.strictEqual(e.storagePath, 'ap_invoices/abc_x.pdf');
    assert.strictEqual(e.communityId, CID);
    assert.ok(/^upload:/.test(e.sourceRef));
  });

  await t('route: certain duplicate → 409 duplicate_invoice', async () => {
    nextOutcome = { outcome: 'blocked_duplicate', duplicate_of: 'inv-0', matches: [{ reason: 'same file already filed' }] };
    const r = await run({ community_id: CID }, pdf);
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.body.status, 'duplicate_invoice');
  });

  await t('route: rejects a non-PDF and a malformed community id before intake', async () => {
    const before = calls.autoIntake.length;
    assert.strictEqual((await run({}, { originalname: 'a.png', mimetype: 'image/png', buffer: Buffer.from('x') })).code, 400);
    assert.strictEqual((await run({ community_id: 'nope' }, pdf)).code, 400);
    assert.strictEqual(calls.autoIntake.length, before);
  });

  Module._load = origLoad;
  console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
})();
