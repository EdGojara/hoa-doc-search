// ============================================================================
// postcard_reminder.js — Bedrock-branded reminder postcard PDF generator
// ----------------------------------------------------------------------------
// Third channel between Courtesy 1 and Courtesy 2: a physical postcard that
// reads differently than the envelope already in the homeowner's mailbox.
// Envelopes get sorted with junk; postcards get scanned because they're
// already open. The reminder doesn't specify the violation by category —
// that's already in the envelope they were sent — to preserve privacy
// (postcards travel unenclosed and any neighbor can read them).
//
// Format: two-up on letter-size paper, front side and back side rendered
// onto a single letter-size page so the operator prints once + cuts at the
// midpoint. Each half is 5.5" × 8.5" (half-letter).
//
//   Page top half (front, address side):
//     - Return address top-left (community c/o Bedrock)
//     - USPS stamp area top-right (left blank for the stamp)
//     - Recipient address center-right (block)
//     - Small "Postal customer reminder — please open" hint along left edge
//
//   Page bottom half (back, message side):
//     - Bedrock + community logo lockup (top)
//     - Big friendly title: "A quick reminder"
//     - Brief message referencing the original courtesy letter date
//     - Cure-by date highlighted
//     - Phone + email
//     - "If you've already addressed this, please disregard."
// ============================================================================

const PDFDocument = require('pdfkit');
const { BRAND } = require('./brand_proxy');

const NAVY  = '#1A3050';
const GOLD  = '#D4AF37';
const INK   = '#1a1a1a';
const MUTED = '#5a5a5a';

const PAGE = { w: 612, h: 792 };                                  // letter
const HALF_H = PAGE.h / 2;                                         // 396

function fmtLongDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtShortDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * @param {Object} ctx
 * @param {Object} ctx.property    — { street_address, unit, city, state, zip }
 * @param {Object} ctx.owner       — { full_name, mailing_address }
 * @param {Object} ctx.community   — { name, legal_name }
 * @param {Date}   [ctx.original_letter_date]
 * @param {Date}   ctx.cure_by_date
 * @param {Buffer} [ctx.community_logo_buffer]
 * @returns {Promise<Buffer>}
 */
async function renderPostcardReminderPdf(ctx) {
  const p = ctx.property || {};
  const o = ctx.owner || {};
  const c = ctx.community || {};
  const hoaName = c.legal_name || (c.name ? `${c.name} HOA` : 'Your Association');
  const originalLetterDate = ctx.original_letter_date ? new Date(ctx.original_letter_date) : null;
  const cureBy = ctx.cure_by_date ? new Date(ctx.cure_by_date) : null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ----- Cut guide along the midpoint -----
    doc.save();
    doc.lineWidth(0.5).strokeColor('#cbd5e1').dash(4, { space: 3 });
    doc.moveTo(20, HALF_H).lineTo(PAGE.w - 20, HALF_H).stroke();
    doc.undash().restore();
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7)
       .text('— cut here —', 0, HALF_H - 8, { width: PAGE.w, align: 'center' });

    // ===========================================================================
    // TOP HALF — ADDRESS SIDE (front)
    // ===========================================================================
    const M = 36;
    const topMargin = M;

    // Return address (top-left)
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5).text(hoaName, M, topMargin);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
       .text(`c/o ${BRAND.service.legal}`, M, topMargin + 12)
       .text(BRAND.service.address, M, topMargin + 22)
       .text(BRAND.service.addressCityStateZip, M, topMargin + 32);

    // USPS stamp box (top-right)
    const stampX = PAGE.w - M - 70, stampY = topMargin, stampW = 70, stampH = 80;
    doc.save();
    doc.lineWidth(0.5).strokeColor('#cbd5e1').dash(3, { space: 2 })
       .rect(stampX, stampY, stampW, stampH).stroke();
    doc.undash().restore();
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
       .text('PLACE\nSTAMP\nHERE', stampX, stampY + 26, { width: stampW, align: 'center' });

    // Recipient address (centered horizontally, lower-middle of top half)
    const recipBlockTop = HALF_H - 130;
    doc.fillColor(INK).font('Helvetica').fontSize(13);
    doc.text(o.full_name || 'Property Owner', M, recipBlockTop, { width: PAGE.w - 2 * M, align: 'center' });
    const mailingLines = String(o.mailing_address || `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}\n${p.city || ''}, ${p.state || 'TX'} ${p.zip || ''}`)
      .split(/\n|,(?=\s)/).map((s) => s.trim()).filter(Boolean);
    let ry = recipBlockTop + 16;
    for (const line of mailingLines) {
      doc.text(line, M, ry, { width: PAGE.w - 2 * M, align: 'center' });
      ry += 16;
    }

    // Hint along the left edge (rotated 90°)
    doc.save();
    doc.rotate(-90, { origin: [20, HALF_H / 2] });
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(9.5)
       .text('A REMINDER FROM YOUR COMMUNITY ASSOCIATION  ·  PLEASE TURN OVER', 0, 12);
    doc.restore();

    // ===========================================================================
    // BOTTOM HALF — MESSAGE SIDE (back)
    // ===========================================================================
    const B = HALF_H + 24;  // bottom-half top margin

    // Lockup: community logo (left, ~50×50) + community name
    let textStartX = M;
    if (ctx.community_logo_buffer) {
      try {
        doc.image(ctx.community_logo_buffer, M, B, { fit: [50, 50], align: 'left', valign: 'top' });
        textStartX = M + 60;
      } catch (e) {
        console.warn('[postcard] community logo embed failed:', e.message);
      }
    }

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(hoaName, textStartX, B);
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
       .text(`Managed by ${BRAND.service.legal}`, textStartX, B + 16);

    // Bedrock cornerstone (top-right, subtle)
    const csX = PAGE.w - M - 18, csY = B + 2, csW = 18, csH = 22;
    doc.fillColor(GOLD);
    doc.moveTo(csX, csY).lineTo(csX + csW, csY).lineTo(csX + csW * 0.95, csY + csH * 0.25).lineTo(csX + csW * 0.05, csY + csH * 0.25).closePath().fill();
    doc.moveTo(csX + csW * 0.06, csY + csH * 0.31).lineTo(csX + csW * 0.94, csY + csH * 0.31).lineTo(csX + csW * 0.89, csY + csH * 0.61).lineTo(csX + csW * 0.11, csY + csH * 0.61).closePath().fill();
    doc.moveTo(csX + csW * 0.13, csY + csH * 0.67).lineTo(csX + csW * 0.87, csY + csH * 0.67).lineTo(csX + csW * 0.83, csY + csH).lineTo(csX + csW * 0.17, csY + csH).closePath().fill();

    // Divider
    let by = B + 48;
    doc.moveTo(M, by).lineTo(PAGE.w - M, by).strokeColor(GOLD).lineWidth(0.8).stroke();

    // Headline
    by += 16;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text('A friendly reminder', M, by);
    by = doc.y + 8;

    // Message
    const msgBlock = originalLetterDate
      ? `On ${fmtShortDate(originalLetterDate)}, we mailed you a courtesy notice about a property-condition matter at the address on this card. We're sending this postcard as a quick reminder before the cure window closes.`
      : `We mailed you a courtesy notice recently about a property-condition matter at the address on this card. This postcard is a quick reminder before the cure window closes.`;
    doc.fillColor(INK).font('Helvetica').fontSize(11)
       .text(msgBlock, M, by, { width: PAGE.w - 2 * M, lineGap: 2 });
    by = doc.y + 10;

    // Cure-by callout
    if (cureBy) {
      doc.save();
      doc.fillColor('#fffbeb').rect(M, by, PAGE.w - 2 * M, 36).fill();
      doc.restore();
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
         .text(`Please address by`, M + 12, by + 8);
      doc.font('Helvetica-Bold').fontSize(13)
         .text(fmtLongDate(cureBy), M + 12, by + 21);
      by += 44;
    }

    // Already addressed?
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10)
       .text(`If you've already addressed the matter, please disregard this reminder. If you have questions or need help, the courtesy letter has the details — or call the office below.`,
             M, by, { width: PAGE.w - 2 * M, lineGap: 2 });
    by = doc.y + 8;

    // Contact line at the bottom
    const contactY = PAGE.h - 32;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
       .text(`${BRAND.service.phone}  ·  ${BRAND.service.email}`, M, contactY, { width: PAGE.w - 2 * M, align: 'center' });

    doc.end();
  });
}

module.exports = { renderPostcardReminderPdf };
