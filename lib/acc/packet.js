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
// prior: [{ what, bytes }] earlier sealed decision letters, after the new letter.
// supplements: acc_case_supplements rows; their correspondence is printed and
// their files follow (migration 576). A reconsidered case only.
async function buildAccPacket({ dec, letterBuffer = null, download, prior = [], supplements = [] }) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  const included = []; const omitted = [];

  const names = new Map((Array.isArray(dec.document_manifest) ? dec.document_manifest : []).map((m) => [m.path, m.filename]));
  const label = (p) => names.get(p) || String(p || '').split('/').pop();

  // Every included source carries its own sha256 + size, so the sealed record
  // proves exactly which documents formed the completed case (Issue #14).
  const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
  async function mergePdfBytes(bytes, what, path = null) {
    let pages;
    try {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      pages = await out.copyPages(src, src.getPageIndices());
    } catch (e) {
      // An encrypted or digitally signed PDF (a signed application form, Ed 2026-11-27,
      // LAK-ARC-2026-0011) cannot be merged page by page. The record still carries it,
      // whole and unchanged: the exact original file is embedded in the packet, with a
      // page that names it and its sha256. Only a letter we render must merge.
      if (what === 'decision letter') throw e;
      return embedWhole(bytes, what, path, e);
    }
    pages.forEach((pg) => out.addPage(pg));
    included.push({ what, path, pages: pages.length, sha256: sha(bytes), bytes: bytes.length });
  }
  async function embedWhole(bytes, what, path, cause) {
    const { StandardFonts } = require('pdf-lib');
    const name = String(label(path) || 'document.pdf').replace(/[^\x20-\x7E]/g, '_');
    await out.attach(bytes, name, { mimeType: 'application/pdf', description: `${what} (original file, sha256 ${sha(bytes)})` });
    const font = await out.embedFont(StandardFonts.Helvetica);
    const page = out.addPage([612, 792]);
    const lines = [String(what).replace(/[^\x20-\x7E]/g, '_'), '', 'This document is encrypted or digitally signed, so its pages cannot be merged here.',
      'The exact original file is embedded in this PDF as an attachment (open the attachments panel):', '', `File: ${name}`, `Size: ${bytes.length} bytes`, `SHA-256: ${sha(bytes)}`];
    lines.forEach((ln, k) => page.drawText(ln, { x: 54, y: 720 - k * 18, size: k === 0 ? 13 : 10, font }));
    included.push({ what, path, pages: 1, sha256: sha(bytes), bytes: bytes.length, embedded: true, reason: String(cause && cause.message || 'not mergeable').slice(0, 200) });
  }
  async function addImage(bytes, what, path) {
    const isPng = /\.png$/i.test(path) || (bytes[0] === 0x89 && bytes[1] === 0x50);
    const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const pageW = 612, pageH = 792, margin = 36;
    const scale = Math.min((pageW - margin * 2) / img.width, (pageH - margin * 2) / img.height, 1e9);
    const w = img.width * scale, h = img.height * scale;
    const page = out.addPage([pageW, pageH]);
    page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
    included.push({ what, path, pages: 1, sha256: sha(bytes), bytes: bytes.length });
  }
  async function addPath(path, kind) {
    if (!path) return;
    const what = `${kind}: ${label(path)}`;
    try {
      const bytes = await download(path);
      if (!bytes || !bytes.length) throw new Error('file not found or empty');
      if (isPdfPath(path)) await mergePdfBytes(bytes, what, path); else await addImage(bytes, what, path);
    } catch (e) { omitted.push({ what, path, error: e.message }); }
  }

  // 1) the decision letter
  if (letterBuffer && letterBuffer.length) {
    try { await mergePdfBytes(letterBuffer, 'decision letter'); } catch (e) { omitted.push({ what: 'decision letter', error: e.message }); }
  } else {
    await addPath(dec.letter_pdf_storage_path, 'decision letter');
  }
  for (const p of prior) {
    try { await mergePdfBytes(p.bytes, p.what); } catch (e) { omitted.push({ what: p.what, error: e.message }); }
  }
  // 2) the application form, 3) every supporting document, 4) every photo
  await addPath(dec.application_pdf_storage_path, 'application');
  for (const p of dec.supporting_docs_storage_paths || []) await addPath(p, 'supporting document');
  for (const p of dec.photo_storage_paths || []) await addPath(p, isPdfPath(p) ? 'supporting document' : 'photo');

  // 5) correspondence and files received after the earlier decision
  if (supplements.length) {
    const { StandardFonts } = require('pdf-lib');
    const font = await out.embedFont(StandardFonts.Helvetica);
    const clean = (s) => String(s || '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x0a\x20-\x7e\xa0-\xff]/g, '');
    const wrap = (line, size, width) => { const words = line.split(/\s+/); const lines = []; let cur = ''; for (let w of words) { while (font.widthOfTextAtSize(w, size) > width) { lines.push(w.slice(0, 80)); w = w.slice(80); } const next = cur ? `${cur} ${w}` : w; if (font.widthOfTextAtSize(next, size) > width) { lines.push(cur); cur = w; } else cur = next; } lines.push(cur); return lines; };
    for (const s of supplements) {
      const head = `${s.kind === 'email' ? 'Email' : 'Documents'} received ${String(s.received_at || '').slice(0, 10)}`;
      const text = [head, s.from_email ? `From: ${s.from_name ? s.from_name + ' ' : ''}<${s.from_email}>` : '', s.subject ? `Subject: ${s.subject}` : '', s.note ? `Note: ${s.note}` : '', '', String(s.body_text || '').slice(0, 12000)].filter((x, i) => i >= 4 || x).join('\n');
      const what = `correspondence: ${head}${s.subject ? ' (' + s.subject + ')' : ''}`;
      const lines = clean(text).split('\n').flatMap((l) => wrap(l, 10, 504));
      let page = null; let y = 0; let pages = 0;
      for (const l of lines) { if (!page || y < 54) { page = out.addPage([612, 792]); y = 738; pages += 1; } if (l) page.drawText(l, { x: 54, y, size: 10, font }); y -= 14; }
      included.push({ what, path: null, pages, sha256: sha(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text, 'utf8'), supplement_id: s.id });
      for (const d of s.documents || []) {
        if (!d.path || d.already_on_case) continue;
        names.set(d.path, d.filename);
        await addPath(d.path, isPdfPath(d.path) ? 'supplemental document' : 'supplemental photo');
      }
    }
  }

  if (!included.length) return { ok: false, error: 'no document could be included', included, omitted };
  return { ok: true, bytes: Buffer.from(await out.save()), included, omitted };
}

module.exports = { buildAccPacket };
