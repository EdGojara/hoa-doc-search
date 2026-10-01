// ============================================================================
// lib/ap/email_intake_outcome.js  (Issue #14): ONE durable outcome per bill email
// ----------------------------------------------------------------------------
// Before this, an Emma bill email could end with no payable, no exception and no
// record of why (the Waterview DJ JPG and petting-zoo DOCX sat in her queue for
// two weeks). Every email that reaches the AP step now gets exactly one outcome,
// stored on email_messages.extracted.ap_intake with the per-file trail:
//   payable    - at least one file became a payable (awaiting approval / held)
//   exception  - at least one file needs a person: a Payables exception was raised
//   duplicate  - every bill in it was already on file (points at the original)
//   not_a_bill - files were read and none is a bill (and nobody asked for payment)
//   no_files   - nothing but inline images (signatures/logos)
// A file the reader could not take (unsupported type, failed download, read
// error) is an exception with a specific reason, whether or not the email asks
// for payment, when the email is a vendor bill. Pure: no I/O.
// ============================================================================

const PAYABLE = new Set(['loaded', 'held_suspected_duplicate']);
const { isSuspectedMissedBill, suspectedBillReason } = require('./bill_signal');

// files_seen: non-inline attachments; results: per file read by the reader;
// skipped: per file the reader could not take. classification: the email's.
function decideOutcome({ filesSeen = 0, results = [], skipped = [], paymentAsked = false, classification = '' }) {
  const billEmail = classification === 'vendor_financial' || paymentAsked;
  const payables = results.filter((r) => PAYABLE.has(r.outcome) && r.invoice_id).map((r) => r.invoice_id);
  const duplicates = results.filter((r) => r.outcome === 'blocked_duplicate').map((r) => ({ file: r.file, duplicate_of: r.duplicate_of || null }));
  const exceptions = [];
  for (const r of results) {
    if (r.outcome === 'needs_review') exceptions.push({ file: r.file, reason: r.reason || 'needs review: open it in Payables', fromReader: true, result: r });
    // The reader said "not an invoice", but the file names a vendor we already pay
    // plus an invoice #, amount or account # (Issue #14: the Waterview MUD bill).
    else if (isSuspectedMissedBill(r)) exceptions.push({ file: r.file, reason: suspectedBillReason(r), fromReader: true, result: r });
    else if (r.outcome === 'error') exceptions.push({ file: r.file, reason: `the invoice reader failed on this file (${String(r.reason || 'error').slice(0, 120)}): open it and enter the bill`, fromReader: false });
  }
  if (billEmail) for (const s of skipped) exceptions.push({ file: s.name, reason: s.reason, fromReader: false });
  // Payment asked but nothing at all could be read (only inline images, say):
  // still a Payables exception, never a silent no-op (Issue #3 rule kept).
  if (paymentAsked && !results.length && !skipped.length) exceptions.push({ file: null, reason: 'payment requested, but no attachment could be read: open the email and enter the bill', fromReader: false });
  // Exceptions with no stored file are de-duplicated ONE per email downstream
  // (recordException keys them on the email's source ref), so several
  // unreadable files must become one exception that names every file, or all
  // but the first would be silently dropped.
  const fileless = exceptions.filter((x) => !x.fromReader);
  if (fileless.length > 1) {
    const merged = { file: null, fromReader: false, files: fileless.map((x) => x.file).filter(Boolean),
      reason: `${fileless.length} attachments need a person: ${fileless.map((x) => (x.file ? `${x.file}: ${x.reason}` : x.reason)).join('; ')}`.slice(0, 990) };
    exceptions.splice(0, exceptions.length, ...exceptions.filter((x) => x.fromReader), merged);
  }
  const filesRead = results.filter((r) => r.outcome !== 'error').length;
  let outcome;
  if (payables.length) outcome = 'payable';
  else if (exceptions.length) outcome = 'exception';
  else if (duplicates.length) outcome = 'duplicate';
  else if (filesRead) outcome = 'not_a_bill';
  else if (skipped.length) outcome = 'not_a_bill';
  else outcome = 'no_files';
  // payable / exception / duplicate are terminal for the email's accounting work.
  // A payable alongside an unreadable file still raises the exception for that file.
  const handled = outcome === 'payable' || outcome === 'exception' || outcome === 'duplicate';
  return { outcome, handled, files_seen: filesSeen, files_read: filesRead, payables, duplicates, exceptions };
}

// The record stored on the email (never includes file bytes or bill text).
function intakeRecord(decision, { results = [], skipped = [], exceptionIds = [] } = {}) {
  return {
    outcome: decision.outcome,
    files_seen: decision.files_seen,
    files_read: decision.files_read,
    files: [
      ...results.map((r) => ({ file: r.file, kind: r.kind || null, result: r.outcome, invoice_id: r.invoice_id || null, duplicate_of: r.duplicate_of || null, reason: r.reason || null, bill_signal: r.bill_signal || null })),
      ...skipped.map((s) => ({ file: s.name, kind: null, result: 'unreadable', reason: s.reason })),
    ],
    exception_ids: exceptionIds,
    at: new Date().toISOString(),
  };
}

module.exports = { decideOutcome, intakeRecord };
