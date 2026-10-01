// ============================================================================
// tests/test_emma_intake_robust.js  (Issue #14): no bill email ends in silence
// ----------------------------------------------------------------------------
// September 2026: a Waterview DJ invoice (a JPG) and a petting-zoo invoice (a
// Word .docx) reached Emma and sat for two weeks: no payable, no exception, no
// record of why. Intake read PDFs only, Graph omits inline bytes for large
// files, and nothing recorded an outcome. Separately, a staff address on a
// vendor record linked dozens of staff emails to that vendor.
//
// This suite pins the safeguards:
//   1. every common bill format is read (PDF, JPG/PNG, DOCX, safe ZIP)
//   2. attachments are listed then fetched BY ID, so a large PDF is not lost
//   3. every bill email gets exactly one durable outcome with files seen/read,
//      and anything unreadable becomes a specific Payables exception
//   4. emails with no outcome after 24h show up as stragglers
//   5. a vendor link with no evidence in the email is rejected
// Fixtures are synthetic look-alikes (tests/fixtures/emma-intake, fictional
// names). Live model reads of them run only with LIVE_AI=1.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { classifyFile, prepareBillFiles, expandZip, contentBlockFor, unsafeEntryName, LIMITS } = require('../lib/ap/bill_files');
const { decideOutcome, intakeRecord } = require('../lib/ap/email_intake_outcome');
const { listAndFetchAttachments } = require('../lib/email/graph_attachments');
const { vendorLinkSupported } = require('../lib/email/triage');
const { isStraggler } = require('../lib/ap/stragglers');
const { mapReason } = require('../lib/ap/intake_exceptions');
const { makeDocx } = require('./fixtures/emma-intake/make_fixtures');

let pass = 0; let fail = 0;
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
const FIX = path.join(__dirname, 'fixtures', 'emma-intake');
const JPG = fs.readFileSync(path.join(FIX, 'dj-invoice-photo.jpg'));
const DOCX = fs.readFileSync(path.join(FIX, 'petting-zoo-invoice.docx'));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---------------------------------------------------------------- formats
check('classifyFile: pdf / jpg / png / docx / zip are readable kinds', () => {
  assert.strictEqual(classifyFile('inv.PDF', '').kind, 'pdf');
  assert.strictEqual(classifyFile('scan', 'application/pdf').kind, 'pdf');
  assert.deepStrictEqual(classifyFile('IMG_1.JPG', ''), { kind: 'image', mediaType: 'image/jpeg' });
  assert.strictEqual(classifyFile('x.png', '').mediaType, 'image/png');
  assert.strictEqual(classifyFile('photo', 'image/jpeg').kind, 'image');
  assert.strictEqual(classifyFile('bill.docx', '').kind, 'docx');
  assert.strictEqual(classifyFile('invoices.zip', '').kind, 'zip');
  assert.strictEqual(classifyFile('x', 'application/x-zip-compressed').kind, 'zip');
});
check('classifyFile: HEIC / .doc / spreadsheet / unknown are unsupported WITH an actionable reason', () => {
  for (const n of ['IMG_2.HEIC', 'old.doc', 'a.xlsx', 'b.csv', 'c.txt']) {
    const c = classifyFile(n, '');
    assert.strictEqual(c.kind, 'unsupported', n);
    assert.ok(/open it|enter the bill/i.test(c.reason), `${n} reason must say what to do: ${c.reason}`);
  }
});
check('prepareBillFiles: the DJ-style JPG becomes an image bill file', async () => {
  const p = await prepareBillFiles([{ name: 'invoice.jpg', contentType: 'image/jpeg', buffer: JPG }]);
  assert.strictEqual(p.seen, 1); assert.strictEqual(p.files.length, 1); assert.strictEqual(p.skipped.length, 0);
  const b = contentBlockFor(p.files[0]);
  assert.strictEqual(b.type, 'image'); assert.strictEqual(b.source.media_type, 'image/jpeg');
  assert.strictEqual(Buffer.from(b.source.data, 'base64').length, JPG.length);
});
check('prepareBillFiles: the petting-zoo-style DOCX is read as text, amount and date intact', async () => {
  const p = await prepareBillFiles([{ name: 'Invoice.docx', contentType: '', buffer: DOCX }]);
  assert.strictEqual(p.files.length, 1);
  const f = p.files[0];
  assert.strictEqual(f.kind, 'docx');
  assert.ok(f.text.includes('$625.00') && f.text.includes('October 10, 2026'), f.text);
  const b = contentBlockFor(f);
  assert.strictEqual(b.type, 'text'); assert.ok(b.text.includes('Word document') && b.text.includes('$625.00'));
});
check('prepareBillFiles: inline signature images are not counted; unsupported + missing bytes + oversize are SKIPPED with reasons', async () => {
  const big = Buffer.alloc(LIMITS.maxFileBytes + 1);
  const p = await prepareBillFiles([
    { name: 'logo.png', contentType: 'image/png', isInline: true, buffer: JPG },
    { name: 'IMG_9.HEIC', contentType: 'image/heic', buffer: Buffer.from('x') },
    { name: 'w9.pdf', contentType: 'application/pdf', buffer: null, unavailable: 'bytes could not be downloaded' },
    { name: 'huge.pdf', contentType: 'application/pdf', buffer: big },
    { name: 'bill.pdf', contentType: 'application/pdf', buffer: PDF },
  ]);
  assert.strictEqual(p.seen, 4, 'inline excluded from files seen');
  assert.deepStrictEqual(p.files.map((f) => f.name), ['bill.pdf']);
  assert.deepStrictEqual(p.skipped.map((s) => s.name).sort(), ['IMG_9.HEIC', 'huge.pdf', 'w9.pdf']);
  for (const s of p.skipped) assert.ok(s.reason && s.reason.length > 10);
});
check('prepareBillFiles: a corrupt .docx is skipped with a reason, not thrown', async () => {
  const p = await prepareBillFiles([{ name: 'broken.docx', contentType: '', buffer: Buffer.from('not a zip') }]);
  assert.strictEqual(p.files.length, 0); assert.strictEqual(p.skipped.length, 1);
  assert.ok(/Word file/.test(p.skipped[0].reason));
});
check('contentBlockFor: a bare Buffer is still a PDF document (back-compat)', () => {
  const b = contentBlockFor(PDF);
  assert.strictEqual(b.type, 'document'); assert.strictEqual(b.source.media_type, 'application/pdf');
});

// ---------------------------------------------------------------- zip safety
check('unsafeEntryName: traversal, absolute, drive, NUL and OS junk are refused', () => {
  for (const n of ['../evil.pdf', 'a/../../evil.pdf', '/etc/x.pdf', 'C:\\x.pdf', 'a\\..\\b.pdf', 'x\0.pdf']) assert.ok(unsafeEntryName(n), n);
  for (const n of ['__MACOSX/._inv.pdf', 'dir/.DS_Store']) assert.strictEqual(unsafeEntryName(n), 'os metadata', n);
  assert.strictEqual(unsafeEntryName('July/inv-1.pdf'), null);
});
check('ZIP (the ENGIE invoices.zip shape): PDFs/images inside are read; HEIC, nested zip and traversal are reported', async () => {
  const z = new JSZip();
  z.file('inv-1.pdf', PDF); z.file('sub/inv-2.jpg', JPG); z.file('photo.heic', 'x');
  z.file('inner.zip', await new JSZip().file('a.pdf', PDF).generateAsync({ type: 'nodebuffer' }));
  z.file('__MACOSX/._inv-1.pdf', 'junk');
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  const p = await prepareBillFiles([{ name: 'invoices.zip', contentType: 'application/zip', buffer: buf }]);
  assert.strictEqual(p.seen, 1);
  assert.deepStrictEqual(p.files.map((f) => `${f.kind}:${f.name}:${f.from_zip}`).sort(), ['image:inv-2.jpg:invoices.zip', 'pdf:inv-1.pdf:invoices.zip']);
  const sk = p.skipped.map((s) => s.name).sort();
  assert.deepStrictEqual(sk, ['invoices.zip/inner.zip', 'invoices.zip/photo.heic']);
  assert.ok(p.skipped.every((s) => !/__MACOSX/.test(s.name)), 'OS junk silently ignored');
});
check('ZIP: a traversal entry is never unpacked', async () => {
  const z = new JSZip(); z.file('ok.pdf', PDF); z.file('evilXX.pdf', PDF);
  let buf = await z.generateAsync({ type: 'nodebuffer' });
  // rename "evilXX.pdf" -> "../e.pdf.." (same length) in both local + central headers
  buf = Buffer.from(buf.toString('latin1').split('evilXX.pdf').join('../evl.pdf'), 'latin1');
  const r = await expandZip(buf, 'x.zip');
  assert.deepStrictEqual(r.files.map((f) => f.name), ['ok.pdf']);
  assert.ok(r.skipped.some((s) => /unsafe path/.test(s.reason)), JSON.stringify(r.skipped));
});
check('ZIP: too many files -> one exception, nothing unpacked', async () => {
  const z = new JSZip(); for (let i = 0; i < LIMITS.maxZipEntries + 1; i++) z.file(`i${i}.pdf`, PDF);
  const r = await expandZip(await z.generateAsync({ type: 'nodebuffer' }), 'many.zip');
  assert.strictEqual(r.files.length, 0); assert.ok(/holds 26 files/.test(r.skipped[0].reason), r.skipped[0].reason);
});
check('ZIP bomb: refused on the DECLARED size before inflating', async () => {
  const z = new JSZip(); z.file('bomb.pdf', Buffer.alloc(200000)); // compresses to a few hundred bytes
  const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(buf.length < 5000);
  const r = await expandZip(buf, 'b.zip', { ...LIMITS, maxFileBytes: 100000 });
  assert.strictEqual(r.files.length, 0); assert.ok(/too large/.test(r.skipped[0].reason));
});
check('ZIP: corrupt / password-protected -> specific reason', async () => {
  const r = await expandZip(Buffer.from('PK\u0003\u0004garbage'), 'bad.zip');
  assert.strictEqual(r.files.length, 0); assert.ok(/could not be opened/.test(r.skipped[0].reason));
});
check('ZIP: a .docx inside a zip is read as text', async () => {
  const z = new JSZip(); z.file('bill.docx', await makeDocx(['Total due: $99.00']));
  const p = await prepareBillFiles([{ name: 'b.zip', contentType: '', buffer: await z.generateAsync({ type: 'nodebuffer' }) }]);
  assert.strictEqual(p.files.length, 1); assert.ok(p.files[0].text.includes('$99.00'));
});

// ---------------------------------------------------------------- Graph list-then-fetch
function mockGraph({ listing, values = {}, objects = {}, expand = {}, listStatus = 200 }) {
  const calls = [];
  const ok = (body, bin) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => bin });
  const no = (s) => ({ ok: false, status: s, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
  const _fetch = async (url) => {
    calls.push(url);
    if (url.includes('?$select=')) return listStatus === 200 ? ok({ value: listing }) : no(listStatus);
    const m = url.match(/attachments\/([^/?]+)(\/\$value|\?\$expand.*)?$/);
    const id = decodeURIComponent(m[1]);
    if (m[2] === '/$value') return values[id] ? ok(null, values[id]) : no(404);
    if (m[2] && m[2].startsWith('?$expand')) return expand[id] ? ok(expand[id]) : no(404);
    return objects[id] ? ok(objects[id]) : no(404);
  };
  return { _fetch, calls };
}
const FA = '#microsoft.graph.fileAttachment';
check('Graph: a 6 MB PDF with NO inline bytes is fetched by id via /$value (the large-PDF loss)', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 7);
  const g = mockGraph({ listing: [{ '@odata.type': FA, id: 'A1', name: 'Aug invoice.pdf', contentType: 'application/pdf', size: big.length, isInline: false }], values: { A1: big } });
  const out = await listAndFetchAttachments('emma@x', 'G1', { _fetch: g._fetch, _token: 't' });
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].buffer.length, big.length);
  assert.ok(g.calls[0].includes('$select=id,name,contentType,size,isInline'), 'listing must be metadata-only');
  assert.ok(g.calls.some((u) => u.endsWith('/A1/$value')));
});
check('Graph: /$value fails -> by-id object contentBytes used', async () => {
  const g = mockGraph({ listing: [{ '@odata.type': FA, id: 'A2', name: 'i.jpg', contentType: 'image/jpeg' }], objects: { A2: { contentBytes: JPG.toString('base64') } } });
  const out = await listAndFetchAttachments('m', 'g', { _fetch: g._fetch, _token: 't' });
  assert.strictEqual(out[0].buffer.length, JPG.length);
});
check('Graph: bytes unobtainable -> returned with buffer:null + reason (never dropped) -> becomes an exception', async () => {
  const g = mockGraph({ listing: [{ '@odata.type': FA, id: 'A3', name: 'lost.pdf', contentType: 'application/pdf' }] });
  const out = await listAndFetchAttachments('m', 'g', { _fetch: g._fetch, _token: 't' });
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].buffer, null); assert.ok(out[0].unavailable);
  const p = await prepareBillFiles(out);
  const d = decideOutcome({ filesSeen: p.seen, results: [], skipped: p.skipped, classification: 'vendor_financial' });
  assert.strictEqual(d.outcome, 'exception'); assert.strictEqual(d.exceptions[0].file, 'lost.pdf');
});
check('Graph: files inside a forwarded email (itemAttachment) are expanded', async () => {
  const g = mockGraph({
    listing: [{ '@odata.type': '#microsoft.graph.itemAttachment', id: 'I1', name: 'FW: bill' }],
    expand: { I1: { item: { attachments: [{ '@odata.type': FA, id: 'N1', name: 'inner.docx', contentType: '', contentBytes: DOCX.toString('base64') }] } } },
  });
  const out = await listAndFetchAttachments('m', 'g', { _fetch: g._fetch, _token: 't' });
  assert.deepStrictEqual(out.map((a) => a.name), ['inner.docx']); assert.strictEqual(out[0].buffer.length, DOCX.length);
});
check('Graph: a listing failure THROWS (caller records it; never a quiet empty result)', async () => {
  const g = mockGraph({ listing: [], listStatus: 503 });
  await assert.rejects(listAndFetchAttachments('m', 'g', { _fetch: g._fetch, _token: 't' }), /HTTP 503/);
});
check('Graph: an attachment with no @odata.type is still fetched, not dropped', async () => {
  const g = mockGraph({ listing: [{ id: 'A9', name: 'x.pdf', contentType: 'application/pdf' }], values: { A9: PDF } });
  const out = await listAndFetchAttachments('m', 'g', { _fetch: g._fetch, _token: 't' });
  assert.strictEqual(out.length, 1); assert.ok(out[0].buffer);
});

// ---------------------------------------------------------------- one outcome per email
const R = (o) => ({ file: 'f.pdf', kind: 'pdf', ...o });
check('outcome: a filed payable -> payable, handled, counts recorded', () => {
  const d = decideOutcome({ filesSeen: 1, results: [R({ outcome: 'loaded', invoice_id: 'I1' })], classification: 'vendor_financial' });
  assert.strictEqual(d.outcome, 'payable'); assert.ok(d.handled); assert.strictEqual(d.files_seen, 1); assert.strictEqual(d.files_read, 1);
});
check('outcome: duplicate email re-sent -> duplicate (points at original), handled, NO new exception', () => {
  const d = decideOutcome({ filesSeen: 1, results: [R({ outcome: 'blocked_duplicate', duplicate_of: 'I0' })], classification: 'vendor_financial', paymentAsked: true });
  assert.strictEqual(d.outcome, 'duplicate'); assert.ok(d.handled); assert.strictEqual(d.exceptions.length, 0);
  assert.strictEqual(d.duplicates[0].duplicate_of, 'I0');
});
check('outcome: suspected duplicate held for review still counts as a payable (human decides)', () => {
  const d = decideOutcome({ filesSeen: 1, results: [R({ outcome: 'held_suspected_duplicate', invoice_id: 'I2' })], classification: 'vendor_financial' });
  assert.strictEqual(d.outcome, 'payable');
});
check('outcome: unsupported file on a vendor bill -> exception naming the file', () => {
  const d = decideOutcome({ filesSeen: 1, results: [], skipped: [{ name: 'IMG.HEIC', reason: 'iPhone HEIC photo: open it' }], classification: 'vendor_financial' });
  assert.strictEqual(d.outcome, 'exception'); assert.ok(d.handled); assert.strictEqual(d.exceptions[0].file, 'IMG.HEIC');
});
check('outcome: TWO unreadable files -> ONE exception naming both (downstream dedups file-less exceptions per email)', () => {
  const d = decideOutcome({ filesSeen: 2, results: [], skipped: [{ name: 'a.heic', reason: 'r1' }, { name: 'b.xlsx', reason: 'r2' }], classification: 'vendor_financial' });
  assert.strictEqual(d.exceptions.length, 1);
  assert.ok(d.exceptions[0].reason.includes('a.heic') && d.exceptions[0].reason.includes('b.xlsx'), d.exceptions[0].reason);
});
check('outcome: reader error -> exception, not a silent drop', () => {
  const d = decideOutcome({ filesSeen: 1, results: [R({ outcome: 'error', reason: 'timeout' })], classification: 'vendor_financial' });
  assert.strictEqual(d.outcome, 'exception'); assert.strictEqual(d.files_read, 0);
});
check('outcome: payable + an unreadable second file -> payable AND an exception for the other file', () => {
  const d = decideOutcome({ filesSeen: 2, results: [R({ outcome: 'loaded', invoice_id: 'I3' })], skipped: [{ name: 'w9.heic', reason: 'r' }], classification: 'vendor_financial' });
  assert.strictEqual(d.outcome, 'payable'); assert.strictEqual(d.exceptions.length, 1);
});
check('outcome: payment asked, only inline images -> exception (Issue #3 rule kept)', () => {
  const d = decideOutcome({ filesSeen: 0, results: [], skipped: [], paymentAsked: true, classification: 'other' });
  assert.strictEqual(d.outcome, 'exception');
});
check('outcome: files read, none a bill, nobody asked to pay -> not_a_bill (not handled)', () => {
  const d = decideOutcome({ filesSeen: 1, results: [R({ outcome: 'not_invoice' })], classification: 'other' });
  assert.strictEqual(d.outcome, 'not_a_bill'); assert.ok(!d.handled);
});
check('outcome: unsupported file on a NON-bill email does not raise an exception', () => {
  const d = decideOutcome({ filesSeen: 1, results: [], skipped: [{ name: 'a.xlsx', reason: 'r' }], classification: 'other' });
  assert.strictEqual(d.exceptions.length, 0);
});
check('intakeRecord: stores counts and per-file trail, never bytes or bill text', () => {
  const d = decideOutcome({ filesSeen: 2, results: [R({ outcome: 'loaded', invoice_id: 'I1', buffer: PDF, text: 'secret' })], skipped: [{ name: 'x.heic', reason: 'r' }], classification: 'vendor_financial' });
  const rec = intakeRecord(d, { results: [R({ outcome: 'loaded', invoice_id: 'I1' })], skipped: [{ name: 'x.heic', reason: 'r' }], exceptionIds: ['E1'] });
  assert.strictEqual(rec.outcome, 'payable'); assert.strictEqual(rec.files_seen, 2); assert.strictEqual(rec.files.length, 2);
  assert.deepStrictEqual(rec.exception_ids, ['E1']);
  assert.ok(!JSON.stringify(rec).includes('secret') && !JSON.stringify(rec).includes('%PDF'));
});
check('mapReason: unreadable-file reasons map to the unreadable_attachment exception type', () => {
  for (const r of ['iPhone HEIC photo: open it', 'unsupported attachment type (.txt)', 'Word file could not be read', 'zip could not be opened', 'attachment bytes could not be downloaded from the mailbox']) {
    assert.strictEqual(mapReason(r), 'unreadable_attachment', r);
  }
});

// ---------------------------------------------------------------- vendor evidence
const STAR = { name: 'Star Protection Agency', email: 'billing@starprotect.example', contact_email: null, dba: null };
check('vendor link: a staff email about a DJ is NOT linked to a security vendor (the 64 mis-links)', () => {
  assert.strictEqual(vendorLinkSupported(STAR, { from: 'staff@bedrocktx.com', subject: 'DJ for the fall festival', body: 'Please pay the DJ invoice attached.', attachmentNames: ['invoice.jpg'] }), false);
});
check('vendor link: staff email whose own address sits on the vendor record is still NOT evidence', () => {
  assert.strictEqual(vendorLinkSupported({ ...STAR, email: 'staff@bedrocktx.com' }, { from: 'staff@bedrocktx.com', subject: 'petting zoo', body: '' }), false);
});
check('vendor link: sender address or vendor domain is evidence', () => {
  assert.ok(vendorLinkSupported(STAR, { from: 'billing@starprotect.example' }));
  assert.ok(vendorLinkSupported(STAR, { from: 'ar@starprotect.example' }));
});
check('vendor link: ONE shared word is not evidence ("Lone Star Pool Management" is not Star Protection)', () => {
  assert.strictEqual(vendorLinkSupported(STAR, { from: 'staff@bedrocktx.com', subject: 'Fw: Invoice 51327 from LONE STAR POOL MANAGEMENT' }), false);
});
check('vendor link: the vendor\'s domain in a forwarded header is evidence (vendor record has no email)', () => {
  const bare = { name: 'Star Protection Agency', email: null, contact_email: null };
  assert.ok(vendorLinkSupported(bare, { from: 'board@community.example', subject: 'Invoice 29253', body: 'Direct From: someone@starprotectiontx.com Sent: ...' }));
});
check('vendor link: a short name (NRG) matches as a whole word only', () => {
  assert.ok(vendorLinkSupported({ name: 'NRG' }, { subject: 'NRG bill October' }));
  assert.strictEqual(vendorLinkSupported({ name: 'NRG' }, { subject: 'energy bill' }), false);
});
check('vendor link: a shared webmail domain alone is NOT evidence', () => {
  assert.strictEqual(vendorLinkSupported({ name: 'Acme Pools', email: 'acme@gmail.com' }, { from: 'someone@gmail.com', subject: 'hello' }), false);
});
check('vendor link: the vendor named in subject / attachment / extracted vendor is evidence', () => {
  assert.ok(vendorLinkSupported(STAR, { from: 'staff@bedrocktx.com', subject: 'Star Protection invoice for August' }));
  assert.ok(vendorLinkSupported(STAR, { from: 'x@y.com', attachmentNames: ['StarProtection_Aug.pdf', 'Protection Agency inv.pdf'] }));
  assert.ok(vendorLinkSupported(STAR, { extractedVendor: 'STAR PROTECTION AGENCY LLC' }));
});

// ---------------------------------------------------------------- stragglers
const NOW = new Date('2026-10-01T12:00:00Z');
const M = (o) => ({ id: 'm1', graph_id: 'g1', persona: 'emma', direction: 'inbound', has_attachments: true, triage_status: 'new', classification: 'vendor_financial', subject: 'Invoice', received_at: '2026-09-29T12:00:00Z', extracted: {}, ...o });
check('straggler: a bill email to Emma with no outcome after 24h is a straggler', () => { assert.ok(isStraggler(M({}), { now: NOW })); });
check('straggler: under 24h is not (yet)', () => { assert.ok(!isStraggler(M({ received_at: '2026-10-01T00:00:00Z' }), { now: NOW })); });
check('straggler: any terminal outcome / payable / exception / human close clears it', () => {
  for (const o of ['payable', 'exception', 'duplicate', 'not_a_bill']) assert.ok(!isStraggler(M({ extracted: { ap_intake: { outcome: o } } }), { now: NOW }), o);
  assert.ok(!isStraggler(M({}), { now: NOW, payableRefs: new Set(['email:g1']) }));
  assert.ok(!isStraggler(M({}), { now: NOW, exceptionEmailIds: new Set(['m1']) }));
  for (const t of ['handled', 'dismissed', 'spam']) assert.ok(!isStraggler(M({ triage_status: t }), { now: NOW }), t);
});
check('straggler: a no_files outcome on a bill email is STILL a straggler (needs a person)', () => {
  assert.ok(isStraggler(M({ extracted: { ap_intake: { outcome: 'no_files' } } }), { now: NOW }));
});
check('straggler: non-bill without payment ask is not; payment ask on "other" is', () => {
  assert.ok(!isStraggler(M({ classification: 'other', subject: 'Photos from the event' }), { now: NOW }));
  assert.ok(isStraggler(M({ classification: 'other', subject: 'Please pay the attached invoice' }), { now: NOW }));
});

// ---------------------------------------------------------------- auto-record payment gate
const { paymentConfirmationGate } = require('../lib/accounting/payment_confirmation');
check('payment gate: the Cinco MUD invoice ("Please process ... auto pay ... add $1 to the draft") is NOT a payment', () => {
  const g = paymentConfirmationGate({ subject: 'Canyon Gate at Cinco Ranch |MUD Invoice 728699', body: 'HI Emma, Please process. This is set to auto pay. Please add $1 to the draft amount.', from: 'cm@bedrocktx.com', hasAttachments: true });
  assert.strictEqual(g.ok, false); assert.ok(/Payables/.test(g.reason));
});
check('payment gate: genuine confirmations still record (ENGIE charged, Payment Success, Auto-Pay submitted)', () => {
  for (const s of ['Notice - Engie Payment was successfully charged', 'Payment Success', 'Auto-Pay Successfully Submitted - SIENV - FORT BEND CO MUD 162', 'Thank you for your payment']) {
    assert.ok(paymentConfirmationGate({ subject: s, body: 'Your payment of $600.60 for account 123 was received.', from: 'noreply@vendor.example' }).ok, s);
  }
});
check('payment gate: "your statement is ready" is a bill, not a payment', () => {
  assert.strictEqual(paymentConfirmationGate({ subject: 'Your Comcast Business billing statement is ready', body: 'Your monthly bill is available in My Account.', from: 'billing@vendor.example' }).ok, false);
});
check('payment gate: a staff-forwarded email with attachments is never auto-recorded as a payment', () => {
  assert.strictEqual(paymentConfirmationGate({ subject: 'Fw: Payment Success', body: 'see attached', from: 'cm@bedrocktx.com', hasAttachments: true }).ok, false);
});
check('wiring: the ingest auto-record is behind the payment gate', () => {
  const g = src('lib/email/graph_ingest.js');
  const gate = g.indexOf('paymentConfirmationGate(');
  const rec = g.indexOf('await recordVendorPaymentToGL(');
  assert.ok(gate > 0 && rec > gate && /if \(payGate\.ok\)/.test(g));
});

// ---------------------------------------------------------------- wiring guards
check('wiring: live Emma intake uses the all-format fetch + one-outcome record', () => {
  const g = src('lib/email/graph_ingest.js');
  assert.ok(g.includes('fetchBillAttachments') && g.includes('prepareBillFiles') && g.includes('decideOutcome') && g.includes('ap_intake: apIntake') || /ap_intake/.test(g));
});
check('wiring: attachment names are fetched BEFORE entity resolution (the vendor-evidence check reads them)', () => {
  const g = src('lib/email/graph_ingest.js');
  const names = g.indexOf('email.attachment_names = await fetchAttachmentNames');
  const resolve = g.indexOf('await resolveEntities(ex, email, supabase)');
  assert.ok(names > 0 && resolve > 0 && names < resolve, `names@${names} resolve@${resolve}`);
});
check('wiring: /sweep-inbox uses the same path (not the old PDF-only filter)', () => {
  const s = src('api/ap_intake.js');
  const sweep = s.slice(s.indexOf("router.post('/sweep-inbox'"), s.indexOf("router.get('/exceptions/:id/file'"));
  assert.ok(sweep.includes('prepareBillFiles') && sweep.includes('decideOutcome') && sweep.includes('intakeRecord'));
  assert.ok(!/continue;\s*\n?.*\/\\\.pdf\$\/i/.test(sweep) && !sweep.includes("if (!/pdf/i.test(a.mime"), 'PDF-only filter removed');
});
check('wiring: intake never approves or pays (human approval preserved)', () => {
  for (const f of ['lib/ap/bill_files.js', 'lib/ap/email_intake_outcome.js', 'lib/ap/stragglers.js']) {
    assert.ok(!/approveInvoice|markPaid|status:\s*'approved'|status:\s*'paid'|createPayment/.test(src(f)), f);
  }
  const g = src('lib/email/graph_ingest.js');
  const blk = g.slice(g.indexOf('fetchBillAttachments'), g.indexOf('fetchBillAttachments') + 6000);
  assert.ok(!/approveInvoice|markPaid|status:\s*'approved'|status:\s*'paid'/.test(blk));
});
check('wiring: straggler job is scheduled daily and the Payables page shows it', () => {
  assert.ok(src('lib/scheduler.js').includes('ap_intake_stragglers'));
  assert.ok(src('api/ap_intake.js').includes("'/stragglers'"));
  assert.ok(src('public/ap-invoices.html').includes('/api/ap-intake/stragglers'));
});

// ---------------------------------------------------------------- live (opt-in)
const LIVE = process.env.LIVE_AI === '1' && !!process.env.ANTHROPIC_API_KEY;
if (LIVE) {
  const { extractInvoice } = require('../lib/ap/invoice_extract');
  check('LIVE: the JPG look-alike reads as $300, invoice 1010', async () => {
    const p = await prepareBillFiles([{ name: 'invoice.jpg', contentType: 'image/jpeg', buffer: JPG }]);
    const x = await extractInvoice(p.files[0]);
    assert.strictEqual(x.total_cents, 30000, JSON.stringify(x)); assert.strictEqual(String(x.invoice_number), '1010');
  });
  check('LIVE: the DOCX look-alike reads as $625', async () => {
    const p = await prepareBillFiles([{ name: 'Invoice.docx', contentType: '', buffer: DOCX }]);
    const x = await extractInvoice(p.files[0]);
    assert.strictEqual(x.total_cents, 62500, JSON.stringify(x));
  });
}

(async () => {
  console.log('Emma intake safeguards (Issue #14)');
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  }
  if (!LIVE) console.log('  (live model reads skipped: set LIVE_AI=1)');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
