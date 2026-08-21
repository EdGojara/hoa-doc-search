// ============================================================================
// tests/test_ap_attach_document.js — attaching the invoice is not re-coding it.
// ----------------------------------------------------------------------------
// Ed 2026-08-21, on the Barker Cypress M.U.D. bill ($470.25, JE ✓ Posted):
// "can you add an upload invoice to the payment screen" / "you can see pdf
// invoice if its there but if not we may need to upload sometime."
//
// The upload button existed but was hidden behind
//
//     notFinal && !inv.posting_journal_entry_id
//
// and the endpoint behind it returned 409 already_posted. So any bill whose
// accrual was on the books showed "No source PDF on file" and offered no way to
// fix it — on exactly the bills where the evidence matters most, because a
// posted journal entry is the one somebody will ask about a year from now.
//
// The 409 was RIGHT about re-extraction: replacing the lines of a posted bill
// desyncs the ledger. It was wrong about the FILE. Those are two different
// operations that had been welded together.
//
// document_only files the PDF and touches nothing else — no extraction, no
// lines, no coding, no posting. Verified live against a real posted bill
// (Prepared Publications #10996, $100.00, awaiting_approval): total, status and
// posting_journal_entry_id all unchanged, document attached, and the test
// artifacts removed afterwards.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const ap = fs.readFileSync(path.join(__dirname, '..', 'api', 'ap.js'), 'utf8').replace(/\r\n/g, '\n');
const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// The document-only branch, sliced correctly.
//
// extractInvoice() appears TWICE in api/ap.js — once in the plain upload route
// (line ~221) and once in attach-pdf (~491). A bare indexOf finds the first,
// which sits BEFORE this branch, so the slice came out backwards and four
// checks failed against a handler that demonstrably works. Anchor the end on
// the occurrence AFTER the branch begins.
const branchStart = ap.indexOf('if (documentOnly) {');
const branchEnd = ap.indexOf('const extracted = await extractInvoice', branchStart);
const branch = branchStart > -1 && branchEnd > branchStart ? ap.slice(branchStart, branchEnd) : '';

console.log('\nThe ledger is still protected');
check('re-running extraction on a posted bill still refuses', () => {
  assert.ok(/posting_journal_entry_id && !documentOnly/.test(ap),
    'the 409 must survive for the re-extraction path — it is the thing keeping the ledger in sync');
  assert.ok(/already_posted/.test(ap));
});
check('document_only stops before extraction', () => {
  // positions come from the shared slice above

  assert.ok(branchStart > -1, 'the document-only branch must exist');
  assert.ok(branchEnd > -1, 'extraction must still exist for the normal path');
  assert.ok(branchStart < branchEnd, 'document_only must return BEFORE anything is extracted');
});
check('and it writes nothing but the document', () => {
  // If this branch ever touches lines, coding or posting, a posted bill's
  // ledger can move on what is supposed to be a filing action.
  assert.ok(!/attachSourceAndRecode|postJournal|journal_entries|ap_invoice_lines/.test(branch),
    'the document-only path must not code, post, or touch lines');
  assert.ok(/source_storage_path: storagePath/.test(branch), 'it must record where the file went');
});

console.log('\nAppend is not edit');
check('a bill that already has its invoice takes MORE documents', () => {
  // Ed 2026-08-21, on a bill showing "View original PDF": "is there a way to
  // add invoice to this screen so it goes to this invoices?"
  //
  // The first cut refused with already_has_document, reasoning that swapping
  // evidence under a posted entry is a silent rewrite. True of REPLACING the
  // primary invoice; never an argument against ADDING to the file, which is
  // the ordinary case — a two-page invoice, the work order it references, the
  // approved proposal, before-and-after photos.
  assert.ok(/const asAdditional = !!inv\.source_storage_path/.test(ap),
    'a second document must be recognised as additional, not rejected');
  assert.ok(/ap_invoice_documents/.test(ap), 'and filed in its own table');
});
check('but re-running extraction on it still refuses', () => {
  assert.ok(/asAdditional && !documentOnly/.test(ap),
    're-extraction would replace the lines the original produced');
  assert.ok(/already_has_document/.test(ap));
});
check('only the FIRST document touches ap_invoices', () => {
  // Every existing reader — check runs, the payables list, /invoice-file —
  // reads source_storage_path. Moving it when a work order is filed would
  // change what the check stub points at.
  assert.ok(/if \(!asAdditional\) \{[\s\S]{0,400}source_storage_path: storagePath/.test(ap),
    'the primary invoice must only be set when there was not one already');
});

console.log('\nA file already in the library is reused, not re-inserted');
check('the unique file_hash index is handled', () => {
  // library_documents has UNIQUE(file_hash). Attaching a PDF that is already
  // in the library — the same file on another bill, or a second click — failed
  // the insert and left the document with no library row behind it.
  assert.ok(/\.eq\('file_hash', sha\)\.maybeSingle\(\)/.test(ap),
    'look for the existing library row before inserting');
  assert.ok(/if \(existingDoc\) \{\s*\n?\s*libDoc = existingDoc;/.test(ap),
    'and reuse it — the document is already in the library, which is where it belongs');
});

console.log('\nThe new table is optional until its migration runs');
check('a missing ap_invoice_documents does not break the detail screen', () => {
  // Migration 381 has to be run by hand. Until then a bill with no extra
  // documents is the normal case and the screen must still open.
  assert.ok(/does not exist\|schema cache/.test(ap),
    'the absence of the table must be tolerated, not logged as a fault');
});

console.log('\nDouble-payment warning');
check('an identical file already on another bill is surfaced', () => {
  // Identical bytes on two payables is how one invoice gets paid twice, and
  // the moment somebody attaches it by hand is the moment to say so.
  assert.ok(/\.eq\('file_sha256', sha\)\.neq\('id', id\)/.test(branch),
    'must look for the same file on OTHER invoices');
  assert.ok(/duplicate_of/.test(branch), 'and report it');
});
check('it warns rather than refusing', () => {
  // A vendor really can send one PDF covering two bills. A person looking at
  // both can tell; a hard block would just get worked around.
  assert.ok(/return res\.json\(\{[\s\S]*ok: true/.test(branch), 'the attach still succeeds');
  assert.ok(/Check you are not paying it twice/.test(ui), 'and the screen says so plainly');
});

console.log('\nThe button is there when the PDF is not');
check('a posted bill with no PDF now offers the upload', () => {
  assert.ok(!/notFinal && !inv\.posting_journal_entry_id/.test(ui),
    'the old gate hid the upload on every posted bill');
  assert.ok(/const posted = !!inv\.posting_journal_entry_id;/.test(ui),
    'posted-ness should pick the MODE, not whether the button exists');
});
check('a bill that has a PDF shows it instead', () => {
  assert.ok(/View original PDF/.test(ui), 'the existing view link must remain');
});
check('the posted wording promises only what it does', () => {
  assert.ok(/the numbers stay exactly as they are/.test(ui),
    'a manager needs to know attaching will not move the ledger');
  assert.ok(/Invoice filed against this bill\. Nothing else changed\./.test(ui),
    '"Attached, coded, and posted" on a path that codes nothing would be a lie');
});

console.log(`\nap_attach_document: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
