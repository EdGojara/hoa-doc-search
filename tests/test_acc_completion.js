// ============================================================================
// tests/test_acc_completion.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// One human action ("Send to homeowner (as Annie)") completes the ACC case:
//   final letter rendered + filed (a failed filing stops before anything is
//   sent) -> case claimed exactly once -> homeowner emailed (letter only, per
//   Ed) -> letter sealed -> COMPLETE ACC RECORD (letter + application + every
//   supporting document + every photo) built, filed on the case and sealed ->
//   Homeowner 360 timeline entry links letter + record -> billing per the
//   community's configured ACC policy, exactly once.
// Packet tests build real PDFs with pdf-lib; finalize wiring is pinned by
// source checks; exactly-once claim behavior is in test_acc_finalize.js.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { buildAccPacket } = require('../lib/acc/packet');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function pdf(pages) { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([612, 792]); return Buffer.from(await d.save()); }
const pagesOf = async (b) => (await PDFDocument.load(b)).getPageCount();

const FIN = (() => { const s = src('server.js'); return s.slice(s.indexOf("app.post('/acc-review/decisions/:id/finalize'"), s.indexOf("app.post('/acc-review/decisions/:id/redraft'")); })();

// ---------------------------------------------------------------- the complete record
check('complete ACC record: letter, then application, then supporting documents (incl. follow-ups), then photos', async () => {
  const store = new Map([
    ['a/application.pdf', await pdf(2)], ['a/doc_1_Survey.pdf', await pdf(1)], ['a/photo_1.png', PNG_1PX], ['a/photo_2.pdf', await pdf(1)],
  ]);
  const dec = { application_pdf_storage_path: 'a/application.pdf', supporting_docs_storage_paths: ['a/doc_1_Survey.pdf'], photo_storage_paths: ['a/photo_1.png', 'a/photo_2.pdf'],
    document_manifest: [{ path: 'a/doc_1_Survey.pdf', filename: 'Survey of 6019 Sweetspire Ridge_circled.pdf' }] };
  const r = await buildAccPacket({ dec, letterBuffer: await pdf(1), download: async (p) => store.get(p) || null });
  assert.ok(r.ok); assert.deepStrictEqual(r.omitted, []);
  assert.deepStrictEqual(r.included.map((x) => x.what), ['decision letter', 'application: application.pdf', 'supporting document: Survey of 6019 Sweetspire Ridge_circled.pdf', 'photo: photo_1.png', 'supporting document: photo_2.pdf']);
  assert.strictEqual(await pagesOf(r.bytes), 1 + 2 + 1 + 1 + 1);
});
check('the old gap is closed: follow-up supporting documents are in the record (they used to be left out)', async () => {
  const store = new Map([['a/application.pdf', await pdf(1)], ['a/supporting_1.pdf', await pdf(3)]]);
  const r = await buildAccPacket({ dec: { application_pdf_storage_path: 'a/application.pdf', supporting_docs_storage_paths: ['a/supporting_1.pdf'] }, letterBuffer: await pdf(1), download: async (p) => store.get(p) || null });
  assert.strictEqual(await pagesOf(r.bytes), 5);
});
check('a document that cannot be read is reported in "omitted", never silently dropped', async () => {
  const store = new Map([['a/application.pdf', await pdf(1)]]);
  const r = await buildAccPacket({ dec: { application_pdf_storage_path: 'a/application.pdf', photo_storage_paths: ['a/missing.jpg'] }, letterBuffer: await pdf(1), download: async (p) => store.get(p) || null });
  assert.ok(r.ok); assert.strictEqual(r.omitted.length, 1); assert.ok(/missing\.jpg/.test(r.omitted[0].what));
});

// ---------------------------------------------------------------- finalize wiring
check('letter filing failure stops BEFORE the claim / send: nothing sent, nothing marked done', () => {
  assert.ok(/if \(up && up\.error\) upErr = up\.error\.message/.test(FIN));
  assert.ok(FIN.indexOf('The decision letter could not be filed') < FIN.indexOf('finalizeAccDecision(supabase'), 'filing check precedes the claim');
});
check('the complete record is built + sealed inside sealRecord, which lib/acc/finalize.js runs only after the claim and BEFORE the email', () => {
  const seal = FIN.slice(FIN.indexOf('const sealRecord = async () => {'), FIN.indexOf('const recordFinalization = async'));
  assert.ok(seal.includes('buildAccPacket(') && /record_type: 'acc_packet'/.test(seal) && /record_type: 'acc_letter'/.test(seal));
  assert.ok(/sealRecord, composeEmail, sendEmail, recordFinalization/.test(FIN));
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'acc', 'finalize.js'), 'utf8');
  assert.ok(lib.indexOf('1) CLAIM') > 0 && lib.indexOf('1) CLAIM') < lib.indexOf('2) FILE') && lib.indexOf('2) FILE') < lib.indexOf('3) SEND'), 'claim -> file -> send');
  assert.ok(/type: 'acc_packet', storage_path: filing\.packet\.path/.test(FIN), 'Homeowner 360 timeline links the record');
  assert.ok(/packet_pdf_storage_path: filing\.packet \? filing\.packet\.path : null/.test(lib), 'the packet path is set as the case is marked decided');
});
check('homeowner email is letter-only (Ed 2026-10-02): the packet is NOT attached', () => {
  const send = FIN.slice(FIN.indexOf('const composeEmail = async () => {'), FIN.indexOf('const sendEmail = async'));
  assert.ok(/contentBytes: pdfBuffer\.toString\('base64'\)/.test(send) && !/packet|pk\.bytes/i.test(send));
});
check('a decided case\'s filed record is never rebuilt or overwritten by the Packet button; follow-up documents are included', () => {
  const s = src('server.js'); const g = s.slice(s.indexOf("app.get('/acc-review/decisions/:id/packet'"), s.indexOf("app.post('/acc-review/decisions/:id/finalize'"));
  assert.ok(/sealedArtifact\(supabase, dec, 'packet'\)/.test(g), 'a finalized case serves the SEALED packet');
  assert.ok(/if \(!bytes && dec\.status === 'decided' && dec\.packet_pdf_storage_path\) bytes = await download\(dec\.packet_pdf_storage_path\);/.test(g));
  assert.ok(/if \(dec\.status !== 'decided'\) \{/.test(g));
  assert.ok(/require\('\.\/lib\/acc\/packet'\)\.buildAccPacket/.test(g));
  assert.ok(/for \(const p of dec\.supporting_docs_storage_paths \|\| \[\]\)/.test(src('lib/acc/packet.js')));
});

// ---------------------------------------------------------------- billing, exactly once
check('billing (homeowner pays): AR charge only for a FINAL decision, only after the claim, only when the community bills the homeowner', () => {
  const fee = FIN.slice(FIN.indexOf('let feeCharge = { attempted: false };'), FIN.indexOf('res.json({', FIN.indexOf('let feeCharge')));
  assert.ok(FIN.indexOf('if (!fin.ok) {') < FIN.indexOf('let feeCharge'), 'charge is unreachable unless this request won the claim');
  assert.ok(/if \(isFinal\) \{/.test(fee) && /comm\.acc_fee_payer === 'homeowner' && feeCents > 0/.test(fee));
  assert.ok(/source_module: 'acc_decision', source_reference: id/.test(fee), 'charge carries the decision as its source');
});
check('billing (community pays, e.g. Waterview): NO homeowner charge at send; the association is billed by the monthly activity invoice, counted once', () => {
  const b = src('api/billing.js');
  assert.ok(/from\('acc_decisions'\)\s*\n?\s*\.select\('community_id, decision_type, decided_at, homeowner_address, project_summary'\)\s*\n?\s*\.eq\('status', 'decided'\)/.test(b), 'counts decided cases by decided_at');
  assert.ok(/accDecisions = _distinctByComm\(accDecisions,/.test(b), 'duplicates of the same lot + project collapse to one');
  assert.ok(/arc_application_fee: arcTotal/.test(src('public/index.html')), 'activity count feeds the ARC fee invoice line');
});
check('a retry / double-click cannot repeat any completion step: the claim refuses a decided case before rendering', () => {
  assert.ok(FIN.indexOf("OPEN_STATUSES.includes(dec.status)") < FIN.indexOf('renderLetterPdfBuffer('));
  assert.ok(/sealFinalizedRecord/.test(src('lib/record_archive.js')) && /already: true/.test(src('lib/record_archive.js')), 'sealing is idempotent on its archive path');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('ACC completion workflow (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
