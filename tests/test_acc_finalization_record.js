// ============================================================================
// tests/test_acc_finalization_record.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Sent means final, archived and immutable; a stale draft can't be sent; the
// final email is short and the PDF is the formal decision.
//   - short email for approve / approve with conditions / deny (generated from
//     the case; never restates conditions or reasons); request for more
//     information stays conversational and lists the items
//   - stale-draft detection: newer review, unknown basis, new evidence; a fresh
//     redraft or a staff-edited draft of the current review is not stale
//   - a finalized / closed case rejects redraft, re-review, document
//     attachment, staff-upload reuse and draft saves
//   - Packet / Letter on a finalized case serve the SEALED archive copies, and
//     only if their sha256 matches the record
//   - billing stays exactly once (homeowner pays: one AR charge after the
//     claim; community pays: counted by the monthly activity invoice)
// The database guarantees (append-only record, write-once finalized case,
// corrections as new versions) are proven in tests/sql/480_apply_one_e2e.mjs.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const { composeAccDecisionEmail } = require('../lib/email/acc_cover_note');
const { draftStaleness } = require('../lib/acc/staleness');

// ---------------------------------------------------------------- the email
const CASE = { homeownerName: 'Pat Doe', homeownerAddress: '12 Oak Lane, Town, TX 77000', projectSummary: 'Rear patio cover — cedar, 12x14', communityName: 'Riverbend HOA',
  letterBody: 'Dear Mr. Doe and Ms. Roe,\n\nYour application is approved subject to the following conditions:\n\n1. The cover must not exceed 10 feet.\n2. Posts must be set 5 feet from the rear lot line.\n\nPlease retain a copy...' };
check('approve with conditions: short; states the result; points to the attached letter; does NOT restate any condition', () => {
  const e = composeAccDecisionEmail({ ...CASE, decisionType: 'approved_with_conditions' });
  assert.strictEqual(e.subject, 'ACC Application Decision – 12 Oak Lane');
  assert.ok(e.text.startsWith('Dear Mr. Doe and Ms. Roe,'), 'salutation from the letter');
  assert.ok(/Your architectural application for the rear patio cover at 12 Oak Lane has been approved with conditions\./.test(e.text));
  assert.ok(/attached approval letter for the complete approval, including the applicable conditions and project requirements/.test(e.text));
  assert.ok(!/10 feet|5 feet|lot line/.test(e.text), 'no condition copied into the email');
  assert.ok(/please reply to this email/.test(e.text) && /Best,$/.test(e.text));
  assert.ok(!/—/.test(e.text + e.subject), 'no em-dashes');
});
check('approve: short confirmation + attached formal approval', () => {
  const e = composeAccDecisionEmail({ ...CASE, decisionType: 'approved_no_conditions' });
  assert.ok(/has been approved\./.test(e.text) && /attached approval letter/.test(e.text) && !/with conditions/.test(e.text));
});
check('deny: short "was not approved" + attached decision; no abbreviated reasons that could contradict the letter', () => {
  const e = composeAccDecisionEmail({ ...CASE, decisionType: 'denied', letterBody: 'Dear Mr. Doe,\n\nThe request conflicts with Section 4.2 of the Declaration because the height exceeds the limit.' });
  assert.ok(/was not approved\./.test(e.text) && /attached decision letter for the complete decision, including the reasons/.test(e.text));
  assert.ok(!/Section 4\.2|height|exceeds/.test(e.text));
});
check('request for more information: stays conversational and LISTS the items the homeowner must send', () => {
  const e = composeAccDecisionEmail({ ...CASE, decisionType: 'request_more_info', letterBody: 'Dear Pat,\n\n1. A survey showing the location.\n2. The color sample.\n\nPlease...' });
  assert.ok(/A survey showing the location\./.test(e.text) && /The color sample\./.test(e.text));
  assert.ok(/More information needed/.test(e.subject));
});
check('generated from the case: nothing community- or property-specific is hard-coded', () => {
  const c = src('lib/email/acc_cover_note.js');
  assert.ok(!/Sweetspire|Waterview|Ramirez|Beyk/.test(c));
  const e = composeAccDecisionEmail({ decisionType: 'approved_no_conditions', homeownerName: 'A B', homeownerAddress: '', projectSummary: '', communityName: 'Lakes HOA', letterBody: '' });
  assert.ok(/^Dear A B,/.test(e.text) && /Lakes HOA/.test(e.subject));
});
check('the server sends composeAccDecisionEmail and archives its exact subject/text/html + attachment sha256', () => {
  const s = src('server.js'); const fin = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/finalize'"), s.indexOf("app.post('/acc-review/decisions/:id/redraft'"));
  assert.ok(/composeAccDecisionEmail\(\{ decisionType,/.test(fin));
  assert.ok(/archive_attachments: \[\{ name: letterFileName, content_type: 'application\/pdf', sha256: _sha256\(pdfBuffer\)/.test(fin));
  assert.ok(/email: email\.sent \? \{ from: composed\.from, to: composed\.to, subject: composed\.subject, text: composed\.text, html: composed\.html/.test(src('lib/acc/finalize.js')));
  assert.ok(/body_preview: \(\(composed && composed\.text\) \|\| bodyText\)/.test(fin), 'the email log shows the email actually sent');
});

// ---------------------------------------------------------------- stale drafts
const at = (m) => new Date(Date.UTC(2026, 9, 2, 12, m)).toISOString();
check('stale: a saved draft older than the current review (the Sweetspire case)', () => {
  const r = draftStaleness({ created_at: at(0), current_review_at: at(30) }, { basisReviewAt: at(10) });
  assert.ok(r.stale); assert.deepStrictEqual(r.reasons, ['newer_review']);
});
check('stale: a saved draft with UNKNOWN basis (saved before provenance) while a current review exists', () => {
  const r = draftStaleness({ created_at: at(0), current_review_at: at(30) }, { basisReviewAt: null });
  assert.deepStrictEqual(r.reasons, ['draft_basis_unknown']);
});
check('new evidence makes an older review AND its draft stale', () => {
  const r = draftStaleness({ created_at: at(0), current_review_at: at(30), last_document_added_at: at(45) }, { basisReviewAt: at(30) });
  assert.ok(r.stale); assert.deepStrictEqual(r.reasons, ['new_documents_since_review']);
});
check('NOT stale: a fresh redraft from the current review, or a staff-edited draft of it (edits are never discarded)', () => {
  assert.strictEqual(draftStaleness({ created_at: at(0), current_review_at: at(30) }, { basisReviewAt: at(30) }).stale, false);
  assert.strictEqual(draftStaleness({ created_at: at(0) }, { basisReviewAt: at(0) }).stale, false, 'original draft, no re-review');
  assert.ok(!/letter_body: .*current_letter_body/.test(src('lib/acc/documents.js')), 're-review never writes the staff draft');
});
check('stale gate wiring: server blocks unless acknowledged; screen shows the banner, Redraft, and an explicit acknowledgment', () => {
  const s = src('server.js');
  assert.ok(/res\.status\(409\)\.json\(\{ stale: true/.test(s));
  assert.ok(/letter_draft_review_at: b\.draft_basis_review_at \|\| null, letter_draft_saved_at:/.test(s), 'a saved draft records the review it came from');
  assert.ok(/basis_review_at: dec\.current_review_at \|\| dec\.created_at \|\| null/.test(s), 'redraft reports its basis');
  const ui = src('public/index.html');
  assert.ok(/A newer review is available\. Redraft or explicitly review the current letter before sending\./.test(ui + src('lib/acc/staleness.js')));
  assert.ok(/id="acc-stale-ack"/.test(ui) && /acknowledge_stale: !!\(document\.getElementById\('acc-stale-ack'\)/.test(ui) && /draft_basis_review_at: window\.accDraftBasis/.test(ui));
});

// ---------------------------------------------------------------- finalized cases reject mutation
check('a finalized / closed case rejects redraft, re-review, attachments, staff-upload reuse and draft saves', async () => {
  const s = src('server.js');
  const redraft = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/redraft'"), s.indexOf("app.post('/acc-review/render-letter'"));
  assert.ok(/its final letter cannot be redrafted/.test(redraft));
  assert.ok(/a finalized record is never re-reviewed/.test(s));
  assert.ok(/r\.status !== 'finalizing' && !r\.finalization_id/.test(s), 'staff upload never reuses a finalized case');
  assert.ok(/\.in\('status', \['pending_review', 'awaiting_info'\]\);/.test(s), 'draft saves only on open cases');
  assert.ok(/if \(!\['pending_review', 'awaiting_info'\]\.includes\(app\.status\)\) return \{ status: 'not_open'/.test(src('lib/acc/pending_intake.js')));
  const { reassessAccCase } = require('../lib/acc/documents');
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { id: 'x', status: 'decided', current_review_text: null }, error: null }) }) };
  let ran = false;
  const r = await reassessAccCase(db, 'x', { runEngine: async () => { ran = true; }, classifyRecommendation: async () => '', download: async () => null });
  assert.strictEqual(r.status, 'not_open'); assert.strictEqual(ran, false);
});
check('Packet / Letter on a finalized case serve the SEALED copies; a hash mismatch is refused, never served', async () => {
  const s = src('server.js');
  assert.ok(/sealedArtifact\(supabase, dec, 'packet'\)/.test(s) && /sealedArtifact\(supabase, dec, 'letter'\)/.test(s));
  const { sealedArtifact } = require('../lib/acc/finalized');
  const good = Buffer.from('%PDF sealed letter'); const sha = crypto.createHash('sha256').update(good).digest('hex');
  const mk = (bytes) => ({
    from: () => ({ select() { return this; }, eq() { return this; }, order: async () => ({ data: [{ id: 'f1', version: 1, letter_archive_path: 'arc/l.pdf', letter_sha256: sha, packet_archive_path: null }], error: null }) }),
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => bytes }, error: null }) }) },
  });
  const dec = { id: 'd1', finalization_id: 'f1' };
  assert.deepStrictEqual(await sealedArtifact(mk(good), dec, 'letter'), good);
  await assert.rejects(() => sealedArtifact(mk(Buffer.from('tampered')), dec, 'letter'), /hash check/);
  assert.strictEqual(await sealedArtifact(mk(good), { id: 'd2' }, 'letter'), null, 'not finalized -> no sealed copy');
});
check('an interrupted send is never re-sent automatically: owner-only release with a confirmation note; screen explains', () => {
  const s = src('server.js');
  assert.ok(/app\.post\('\/acc-review\/decisions\/:id\/release-finalizing'/.test(s) && /requireOwner/.test(s.slice(s.indexOf("release-finalizing'"), s.indexOf("release-finalizing'") + 600)));
  assert.ok(/confirmed_not_sent_note/.test(s) && /less than 10 minutes ago/.test(s));
  assert.ok(/It is never re-sent automatically\./.test(src('public/index.html')));
});

// ---------------------------------------------------------------- billing, exactly once
check('billing unchanged and exactly once: homeowner AR charge only after the claim; community pays via the activity invoice', () => {
  const s = src('server.js'); const fin = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/finalize'"), s.indexOf("app.post('/acc-review/decisions/:id/redraft'"));
  assert.ok(fin.indexOf('if (!fin.ok) {') < fin.indexOf('let feeCharge'), 'the charge is unreachable unless this request completed the case');
  assert.ok(/comm\.acc_fee_payer === 'homeowner' && feeCents > 0/.test(fin));
  const b = src('api/billing.js'); assert.ok(/\.eq\('status', 'decided'\)/.test(b) && /_distinctByComm\(accDecisions,/.test(b));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('ACC finalization record, stale drafts, short email (Issue #14)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
