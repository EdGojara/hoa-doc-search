// ============================================================================
// lib/enforcement/bundle_print_guard.js  (Issue #5, Ed 2026-09-28)
// ----------------------------------------------------------------------------
// A multi-violation envelope is ONE reviewed, combined letter. At print time
// (Mail Queue lock-and-batch) every member of that envelope must use exactly
// those bytes: seal them, count their pages, append them. Never a per-violation
// re-render.
//
// Scar (Issue #5): an `if (_br) {...}` followed by a SEPARATE
// `if (!_br && selfHelp) {...} else {...}` let the else re-render each bundle
// member as a one-violation letter with no photo. That bad letter was sealed
// and printed while the record (and Homeowner 360) still pointed at the correct
// combined PDF. The 2026-09-28 LOPF run printed 9 such envelopes.
//
// The check compares SHA-256 of the actual bytes (never Buffer identity). A
// mismatch HOLDS the letter before any sent / seal / fee / receipt / print step.
// ============================================================================

const crypto = require('crypto');
const sha256 = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');

// The record kept for each pre-rendered combined letter.
function bundleRecord(pdfBuffer, letterPath) {
  return { pdfBuffer, letterPath, sha256: sha256(pdfBuffer) };
}

// True when the bytes about to be sealed/printed are the combined letter's bytes.
function bundleBytesIntact(pdfBuffer, br) {
  if (!br || !br.sha256 || !pdfBuffer) return false;
  return sha256(pdfBuffer) === br.sha256;
}

module.exports = { sha256, bundleRecord, bundleBytesIntact };
