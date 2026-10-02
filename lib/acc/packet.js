// ============================================================================
// lib/acc/packet.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// The complete ACC record as one PDF: the decision letter, then the
// application form, then every supporting document (surveys, plot plans,
// brochures) and every photo. One builder for both the on-demand "Packet"
// button and the packet filed + sealed when a decision is finalized.
//
// The old on-demand packet merged only the letter, the application and
// photo_storage_paths, so documents a homeowner sent in a FOLLOW-UP
// (supporting_docs_storage_paths, e.g. a survey sent after the application)
// were left out of the record. It was also never filed at completion: it was
// rebuilt and overwritten every time someone clicked the button.
//
// A document that cannot be read or merged is NOT silently dropped: it is
// returned in `omitted` so the caller can surface it.
// ============================================================================
const isPdfPath = (p) => /\.pdf$/i.test(String(p || ''));

// dec: the acc_decisions row. letterBuffer: the final letter bytes (finalize
// passes the letter it just rendered; the button passes null and the stored
// letter is used). download(path) -> Buffer|null.
async function buildAccPacket({ dec, letterBuffer = null, download }) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  const included = []; const omitted = [];

  const names = new Map((Array.isArray(dec.document_manifest) ? dec.document_manifest : []).map((m) => [m.path, m.filename]));
  const label = (p) => names.get(p) || String(p || '').split('/').pop();

  async function mergePdfBytes(bytes, what) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((pg) => out.addPage(pg));
    included.push({ what, pages: pages.length });
  }
  async function addImage(bytes, what, path) {
    const isPng = /\.png$/i.test(path) || (bytes[0] === 0x89 && bytes[1] === 0x50);
    const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const pageW = 612, pageH = 792, margin = 36;
    const scale = Math.min((pageW - margin * 2) / img.width, (pageH - margin * 2) / img.height, 1e9);
    const w = img.width * scale, h = img.height * scale;
    const page = out.addPage([pageW, pageH]);
    page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
    included.push({ what, pages: 1 });
  }
  async function addPath(path, kind) {
    if (!path) return;
    const what = `${kind}: ${label(path)}`;
    try {
      const bytes = await download(path);
      if (!bytes || !bytes.length) throw new Error('file not found or empty');
      if (isPdfPath(path)) await mergePdfBytes(bytes, what); else await addImage(bytes, what, path);
    } catch (e) { omitted.push({ what, path, error: e.message }); }
  }

  // 1) the decision letter
  if (letterBuffer && letterBuffer.length) {
    try { await mergePdfBytes(letterBuffer, 'decision letter'); } catch (e) { omitted.push({ what: 'decision letter', error: e.message }); }
  } else {
    await addPath(dec.letter_pdf_storage_path, 'decision letter');
  }
  // 2) the application form, 3) every supporting document, 4) every photo
  await addPath(dec.application_pdf_storage_path, 'application');
  for (const p of dec.supporting_docs_storage_paths || []) await addPath(p, 'supporting document');
  for (const p of dec.photo_storage_paths || []) await addPath(p, isPdfPath(p) ? 'supporting document' : 'photo');

  if (!included.length) return { ok: false, error: 'no document could be included', included, omitted };
  return { ok: true, bytes: Buffer.from(await out.save()), included, omitted };
}

module.exports = { buildAccPacket };
