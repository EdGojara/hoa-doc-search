// ============================================================================
// lib/enforcement/evidence_photo.js  (Ed 2026-09-22)
// ----------------------------------------------------------------------------
// The ONE way a violation letter loads its evidence photo from storage.
//
// Scar: 5310 Prairie Dog Fork Lane printed a courtesy notice with no photo on
// two of its three violations, though every photo was on file and downloads
// fine. Each letter path did
//     try { const { data: blob } = await ...download(path); if (blob) ... } catch (_) {}
// which ignores the `error` supabase-js RETURNS (it doesn't throw) and swallows
// the rest. One transient storage hiccup = a legal notice mailed without its
// evidence, and nothing anywhere said so. Re-running the same bundle reproduced
// it intermittently (one run dropped a photo, the next didn't).
//
// Rule: retry transient failures, and if the photo still can't be loaded THROW,
// so the print step holds the letter (it stays in the queue, with the reason
// shown) instead of mailing it photo-less.
// ============================================================================

const RETRY_DELAYS_MS = [400, 1200];

async function downloadEvidencePhoto(supabase, storagePath, { bucket = 'documents', label = '' } = {}) {
  if (!storagePath) return null;
  // Manual description-only violations carry a stub row, not a photo (api/enforcement.js /violations/manual).
  if (/_no_photo_placeholder\.txt$/.test(storagePath)) return null;
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { data, error } = await supabase.storage.from(bucket).download(storagePath);
      if (error) throw new Error(error.message || String(error));
      if (!data) throw new Error('storage returned no data');
      const buf = Buffer.from(await data.arrayBuffer());
      if (!buf.length) throw new Error('storage returned an empty file');
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_DELAYS_MS.length) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  const err = new Error(`evidence photo${label ? ' for ' + label : ''} could not be loaded (${lastErr && lastErr.message})`);
  err.code = 'EVIDENCE_PHOTO_UNAVAILABLE';
  console.warn('[evidence_photo]', err.message, storagePath);
  throw err;
}

module.exports = { downloadEvidencePhoto };
