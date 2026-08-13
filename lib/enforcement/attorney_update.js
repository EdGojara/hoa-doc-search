// ============================================================================
// lib/enforcement/attorney_update.js  (Ed 2026-08-12)
// ----------------------------------------------------------------------------
// The monthly "Violation Update" packet sent to the association attorney for
// at-legal violations. Two jobs:
//   1. burnTimestamp — draw a tamper-evident bar (date · time · address) into
//      the PIXELS of a photo so it can't be cropped off or disputed.
//   2. buildViolationUpdatePdf — a branded PDF, one property per page: address,
//      the timestamped photo, current status ("still not cured"), how long it's
//      been at legal.
// Photos come from whatever landed in inspection_photos — the monthly drive OR
// the on-demand "legal picture" upload — so both processes reach the same place.
// ============================================================================

const { createCanvas, loadImage } = require('canvas');
const PDFDocument = require('pdfkit');

// Burn a caption across the bottom of a photo. Returns a JPEG buffer.
async function burnTimestamp(imageBuffer, caption) {
  const img = await loadImage(imageBuffer);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const barH = Math.max(30, Math.round(img.height * 0.065));
  ctx.fillStyle = 'rgba(0,0,0,0.64)';
  ctx.fillRect(0, img.height - barH, img.width, barH);
  ctx.fillStyle = '#ffffff';
  const fs = Math.max(15, Math.round(barH * 0.42));
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(String(caption || ''), 14, img.height - barH / 2 + 1, img.width - 28);
  return c.toBuffer('image/jpeg', { quality: 0.9 });
}

const fmtDate = (d) => {
  if (!d) return null;
  try { return new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT'; }
  catch (_) { return null; }
};

// items: [{ address, category, status, at_legal_since, photo_taken_at, imageBuffer|null }]
async function buildViolationUpdatePdf({ communityName, generatedAt, items }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
      const chunks = [];
      doc.on('data', (ch) => chunks.push(ch));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // Cover
      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(22).text('Violation Update');
      doc.moveDown(0.25).font('Helvetica').fontSize(12).fillColor('#475569').text(`${communityName || 'Association'}  ·  ${generatedAt}`);
      doc.moveDown(0.5).fontSize(10.5).fillColor('#64748b')
        .text(`${items.length} propert${items.length === 1 ? 'y' : 'ies'} referred to counsel remain in violation. Each photo below is date- and time-stamped as of the inspection.`, { width: 460 });

      for (const it of items) {
        doc.addPage();
        doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(16).text(it.address || 'Property');
        doc.moveDown(0.15).font('Helvetica-Bold').fontSize(11.5).fillColor('#7f1d1d').text(`Status: ${it.status || 'Still not cured'}`);
        const meta = [it.category, it.at_legal_since ? `at legal since ${it.at_legal_since}` : null, it.photo_taken_at ? `photo taken ${it.photo_taken_at}` : null].filter(Boolean).join('  ·  ');
        if (meta) doc.moveDown(0.1).font('Helvetica').fontSize(10).fillColor('#475569').text(meta);
        doc.moveDown(0.6);
        if (it.imageBuffer) {
          try { doc.image(it.imageBuffer, { fit: [488, 470] }); }
          catch (_) { doc.fillColor('#b91c1c').fontSize(11).text('[photo could not be rendered]'); }
        } else {
          doc.fillColor('#94a3b8').fontSize(11).text('[no photo on file — capture one with the Legal Picture button]');
        }
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { burnTimestamp, buildViolationUpdatePdf, fmtDate };
