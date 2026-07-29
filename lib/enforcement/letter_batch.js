// ============================================================================
// lib/enforcement/letter_batch.js  (Ed 2026-07-29)
// ----------------------------------------------------------------------------
// Bundle-aware letter batching. A courtesy/§209 BUNDLE is N violations at one
// property mailed in ONE envelope, so its N interaction rows all point at the
// SAME rendered PDF (same `content` storage path). Any code that merges letter
// PDFs for a print batch MUST merge each unique PDF exactly ONCE — never once
// per interaction, or a 2-violation bundle prints twice and the batch "un-
// bundles" into extra envelopes.
//
// Scar: "217 bundles printed as 267 envelopes" (fixed once on the lock-and-batch
// path via a bundle_id guard) RECURRED on the redownload + batch-pdf paths, which
// still looped per-interaction. Three copies of the same dedupe drifted. Per
// CLAUDE.md ("a recurring scar becomes a shared helper that can't do the wrong
// thing"), the dedupe now lives here, once.
//
//   const forMerge = uniqueLettersByPdf(letters); // merge each PDF once
//   // ...but state (printed_at, included ids) still applies to ALL `letters`.
// ============================================================================

/**
 * Given letter interaction rows (each with a `content` storage path), return the
 * subset to actually MERGE — one row per unique PDF path, first occurrence wins,
 * input order preserved. Rows with no content are dropped. Bundle siblings that
 * share a PDF collapse to a single entry.
 * @param {Array<{content?: string}>} letters
 * @returns {Array} unique-by-content-path letters, in order
 */
function uniqueLettersByPdf(letters) {
  const seen = new Set();
  const out = [];
  for (const L of Array.isArray(letters) ? letters : []) {
    const path = L && L.content;
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(L);
  }
  return out;
}

module.exports = { uniqueLettersByPdf };
