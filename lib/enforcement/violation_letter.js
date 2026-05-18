// ============================================================================
// violation_letter.js — Bedrock-branded enforcement letter generator
// ----------------------------------------------------------------------------
// Given a violation row + its property + owner + community context, renders
// a Bedrock Association Management PDF letter ready to mail.
//
// Two letter variants:
//   - first_class_mail courtesy:  "Compliance Concern" tone, friendly,
//                                   30-day cure default
//   - certified_mail TX §209:      "Formal Notice" tone, statutory language,
//                                   prominent cure period, hearing notice
//
// Always uses the OWNER's mailing_address (NOT the property address) so
// non-occupant rentals get delivered to the landlord — the renter database
// (Phase X) will eventually let us courtesy-CC the tenant too.
//
// Renders the property photo (most recent confirmed observation) on the
// letter as evidence — keeps "show, don't claim" discipline.
// ============================================================================

const PDFDocument = require('pdfkit');
const { BRAND } = require('./brand_proxy');  // tiny re-export so PDFKit-only lib path doesn't pull tonnes

// Page geometry (US Letter, 612 x 792 pt)
const PAGE = {
  margin: 56,             // ~3/4 inch
  width:  612,
  height: 792,
};

/**
 * Generate the PDF buffer for a violation letter.
 *
 * @param {Object} ctx - everything needed to render
 * @param {Object} ctx.violation       - { id, opened_at, current_stage, cure_period_ends_at,
 *                                          board_priority_at_open, category_label,
 *                                          category_description?, rationale }
 * @param {Object} ctx.property        - { street_address, unit, city, state, zip, lot_number }
 * @param {Object} ctx.owner           - { full_name, mailing_address } (used for delivery)
 * @param {Object} ctx.community       - { name }
 * @param {Object} [ctx.observation]   - { ai_description, severity, captured_at }
 * @param {Buffer} [ctx.photo_buffer]  - optional jpg/png to embed as evidence
 * @param {Object} ctx.options         - { letter_date, sender_name, sender_title }
 * @returns {Promise<Buffer>}
 */
async function renderViolationLetterPdf(ctx) {
  const v = ctx.violation || {};
  const p = ctx.property || {};
  const o = ctx.owner || {};
  const c = ctx.community || {};
  const obs = ctx.observation || null;
  const opts = ctx.options || {};

  const isCertified = v.current_stage === 'certified_209' || v.current_stage === 'fine_assessed';
  const requiresHearing = v.current_stage === 'fine_assessed';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      bufferPages: true,
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy = '#1A3050';
    const gold = '#D4AF37';
    const ink  = '#1a1a1a';
    const muted = '#5a5a5a';

    // ---------------------------------------------------------------------
    // HEADER — Bedrock Association Management lockup
    // ---------------------------------------------------------------------
    // Cornerstone gold mark on the left, wordmark + tagline on the right
    const headerTop = PAGE.margin;
    // Draw cornerstone as three trapezoidal segments via PDF paths
    const csX = PAGE.margin;
    const csY = headerTop;
    const csW = 28;
    const csH = 36;
    doc.fillColor(gold);
    // Segment 1 (top): polygon points (0,0) (28,0) (26.5,9) (1.5,9)
    doc.moveTo(csX + 0,    csY + 0)
       .lineTo(csX + csW,  csY + 0)
       .lineTo(csX + 26.5, csY + 9)
       .lineTo(csX + 1.5,  csY + 9)
       .closePath().fill();
    // Segment 2 (middle)
    doc.moveTo(csX + 1.7,  csY + 11)
       .lineTo(csX + 26.3, csY + 11)
       .lineTo(csX + 24.8, csY + 22)
       .lineTo(csX + 3.2,  csY + 22)
       .closePath().fill();
    // Segment 3 (bottom)
    doc.moveTo(csX + 3.6,  csY + 24)
       .lineTo(csX + 24.4, csY + 24)
       .lineTo(csX + 23,   csY + 36)
       .lineTo(csX + 5,    csY + 36)
       .closePath().fill();

    // Wordmark text
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(15)
       .text('BEDROCK', csX + csW + 12, csY + 1);
    doc.fillColor(muted).font('Helvetica').fontSize(8)
       .text('ASSOCIATION  MANAGEMENT', csX + csW + 12, csY + 18, { characterSpacing: 1.5 });
    // Tagline (right-aligned on header)
    doc.fillColor(muted).font('Helvetica-Oblique').fontSize(8.5)
       .text('Community. Simplified.', PAGE.margin, csY + 8, {
         width: PAGE.width - 2 * PAGE.margin, align: 'right',
       });

    // Header rule
    doc.moveTo(PAGE.margin, headerTop + 50)
       .lineTo(PAGE.width - PAGE.margin, headerTop + 50)
       .strokeColor(navy).lineWidth(0.6).stroke();

    // ---------------------------------------------------------------------
    // LETTER METADATA — date + delivery method tag (CERTIFIED MAIL)
    // ---------------------------------------------------------------------
    let y = headerTop + 64;
    const letterDate = opts.letter_date || new Date();
    const dateStr = letterDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor(ink).font('Helvetica').fontSize(10.5).text(dateStr, PAGE.margin, y);

    if (isCertified) {
      // Big red box with CERTIFIED MAIL on the right
      const boxW = 200;
      const boxX = PAGE.width - PAGE.margin - boxW;
      doc.save();
      doc.lineWidth(1.5).strokeColor('#b91c1c').rect(boxX, y - 2, boxW, 36).stroke();
      doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(11)
         .text('CERTIFIED MAIL', boxX, y + 3, { width: boxW, align: 'center' });
      doc.fillColor('#b91c1c').font('Helvetica').fontSize(8.5)
         .text('Return Receipt Requested', boxX, y + 18, { width: boxW, align: 'center' });
      doc.fillColor('#b91c1c').font('Helvetica').fontSize(7.5)
         .text('Tex. Prop. Code §209', boxX, y + 28, { width: boxW, align: 'center' });
      doc.restore();
      y += 50;
    } else {
      y += 24;
    }

    // ---------------------------------------------------------------------
    // RECIPIENT — owner's mailing address
    // ---------------------------------------------------------------------
    doc.fillColor(ink).font('Helvetica').fontSize(10.5);
    doc.text(o.full_name || 'Property Owner', PAGE.margin, y);
    y += 14;
    // mailing_address may be a single string with commas or newlines; render lines
    const mailingLines = String(o.mailing_address || `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}\n${p.city || ''}, ${p.state || 'TX'} ${p.zip || ''}`)
      .split(/\n|,(?=\s)/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of mailingLines) {
      doc.text(line, PAGE.margin, y);
      y += 13;
    }

    y += 16;

    // ---------------------------------------------------------------------
    // SUBJECT LINE
    // ---------------------------------------------------------------------
    const subject = isCertified
      ? `Formal Notice of Covenant Violation — ${c.name || 'Your community'}`
      : `Compliance Concern — ${c.name || 'Your community'}`;
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(11.5).text('Re: ' + subject, PAGE.margin, y);
    y += 16;
    doc.fillColor(muted).font('Helvetica').fontSize(9.5)
       .text(`Property: ${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}, ${p.city || ''} ${p.state || 'TX'} ${p.zip || ''}${p.lot_number ? ' · Lot ' + p.lot_number : ''}`, PAGE.margin, y);
    y += 22;

    // ---------------------------------------------------------------------
    // SALUTATION + BODY
    // ---------------------------------------------------------------------
    doc.fillColor(ink).font('Helvetica').fontSize(11);
    const salutation = `Dear ${o.full_name ? o.full_name.split(' & ')[0] : 'Property Owner'},`;
    doc.text(salutation, PAGE.margin, y);
    y += 18;

    // Body text varies by stage. Bedrock-branded prose — "describe process,
    // not outcomes" — no audit-grade or claims; conversational courtesy /
    // formal certified.
    let bodyParas = [];
    if (v.current_stage === 'courtesy_1') {
      bodyParas = [
        `During a recent community inspection on ${obs && obs.captured_at ? new Date(obs.captured_at).toLocaleDateString() : 'a recent date'}, our team noted a condition at the above property that appears to fall outside the ${c.name || 'community'} covenants regarding ${v.category_label || 'community standards'}.`,
        v.category_description || (obs && obs.ai_description ? `Specifically: ${obs.ai_description}.` : `The specific concern is described under the heading "${v.category_label || 'community standards'}" in your governing documents.`),
        `This letter is a courtesy notice. There is no fine, no citation, and no record of formal action — we simply want to give you the opportunity to address the matter at your convenience. Most homeowners resolve concerns like this within a few days of receiving notice, and that's the end of it.`,
        `Please remedy the condition by ${v.cure_period_ends_at ? new Date(v.cure_period_ends_at).toLocaleDateString() : 'the date noted below'}. If the work is already underway, or if you'd like to talk through the issue, just reply to this letter or email us at ${BRAND.service.email}.`,
        `Thank you for being part of ${c.name || 'the community'}.`,
      ];
    } else if (v.current_stage === 'courtesy_2') {
      bodyParas = [
        `We previously wrote to you regarding a condition at the above property concerning ${v.category_label || 'community standards'}. Our records indicate the concern has not yet been resolved.`,
        v.category_description || (obs && obs.ai_description ? `The specific concern remains: ${obs.ai_description}.` : `Please refer to our prior notice for the specific concern.`),
        `This second notice gives you another opportunity to address the matter without further escalation. We understand that life is busy and circumstances vary — please contact us if there's something we should know.`,
        `Please remedy the condition by ${v.cure_period_ends_at ? new Date(v.cure_period_ends_at).toLocaleDateString() : 'the date noted below'}. If the matter is unresolved at that point, our next correspondence will be sent via certified mail under Texas Property Code §209, which carries different legal consequences.`,
        `If you have already addressed the concern, please let us know so we can update the community record.`,
      ];
    } else if (v.current_stage === 'certified_209') {
      bodyParas = [
        `This is a formal notice under Texas Property Code §209 regarding a covenant violation at the above property. ${c.name || 'The Association'} has documented repeated concerns about ${v.category_label || 'this matter'} that have not been resolved through prior correspondence.`,
        v.category_description || (obs && obs.ai_description ? `The specific violation is: ${obs.ai_description}.` : `Please refer to our prior notices for the specific violation.`),
        `Under Texas law, you have the right to cure the violation within a reasonable period — Bedrock provides ${(v.cure_period_ends_at && Math.ceil((new Date(v.cure_period_ends_at) - Date.now()) / (24*60*60*1000))) || 30} days from receipt of this notice, which is longer than the statutory minimum.`,
        `If the violation is not cured by ${v.cure_period_ends_at ? new Date(v.cure_period_ends_at).toLocaleDateString() : 'the cure date'}, ${c.name || 'the Association'} may proceed to assess fines, schedule a hearing under Tex. Prop. Code §209.0064, and/or pursue other remedies authorized under your governing documents.`,
        `You may also request a hearing before any fine is assessed. To do so, reply in writing to the address above within 30 days of receipt of this notice.`,
        `We hope to resolve this matter without further escalation. Please contact our office if you intend to cure the violation, dispute the finding, or request a hearing.`,
      ];
    } else if (v.current_stage === 'fine_assessed') {
      bodyParas = [
        `This notice memorializes that a fine has been assessed against your account for an unresolved covenant violation at the above property, after notice and an opportunity to cure under Tex. Prop. Code §209.`,
        `The violation: ${v.category_label || 'covenant compliance'}.`,
        requiresHearing
          ? `You have the right to a hearing before the Board of Directors before this fine becomes final. To request one, reply in writing within 30 days of receipt of this notice.`
          : `You have previously waived your right to a hearing by failing to respond to prior notices, or you have already had a hearing on this matter.`,
        `Please remit payment or contact our office to discuss the assessment.`,
      ];
    } else {
      bodyParas = [`This letter relates to a matter on file at the above property.`];
    }
    for (const para of bodyParas) {
      doc.text(para, PAGE.margin, y, {
        width: PAGE.width - 2 * PAGE.margin,
        align: 'justify',
        lineGap: 2.5,
      });
      y = doc.y + 10;
    }

    // ---------------------------------------------------------------------
    // EVIDENCE PHOTO (if available) — embedded inline
    // ---------------------------------------------------------------------
    if (ctx.photo_buffer) {
      try {
        // New page if not enough room
        if (y > PAGE.height - 280) {
          doc.addPage();
          y = PAGE.margin;
        }
        doc.fillColor(muted).font('Helvetica-Bold').fontSize(9.5)
           .text('PHOTO — TAKEN ON SITE', PAGE.margin, y, { characterSpacing: 0.8 });
        y += 14;
        const photoMaxW = PAGE.width - 2 * PAGE.margin;
        const photoMaxH = 220;
        doc.image(ctx.photo_buffer, PAGE.margin, y, { fit: [photoMaxW, photoMaxH], align: 'left' });
        y = doc.y + 8;
        if (obs && obs.captured_at) {
          doc.fillColor(muted).font('Helvetica').fontSize(8.5)
             .text(`Photographed ${new Date(obs.captured_at).toLocaleString()}.`, PAGE.margin, y);
          y += 14;
        }
      } catch (e) {
        // Photo embed failed — continue without it
        console.warn('[letter] photo embed failed:', e.message);
      }
    }

    // ---------------------------------------------------------------------
    // SIGN-OFF
    // ---------------------------------------------------------------------
    y += 8;
    doc.fillColor(ink).font('Helvetica').fontSize(11);
    doc.text('Respectfully,', PAGE.margin, y);
    y += 28;
    doc.font('Helvetica-Bold').fontSize(11).text(opts.sender_name || 'Bedrock Association Management', PAGE.margin, y);
    y += 14;
    doc.font('Helvetica').fontSize(9.5).fillColor(muted)
       .text(opts.sender_title || 'On behalf of the Board of Directors', PAGE.margin, y);
    y += 12;
    doc.text(`Acting as managing agent for ${c.name || 'the Association'}.`, PAGE.margin, y);

    // ---------------------------------------------------------------------
    // FOOTER — Bedrock contact info
    // ---------------------------------------------------------------------
    const footerY = PAGE.height - PAGE.margin + 12;
    doc.moveTo(PAGE.margin, footerY - 6)
       .lineTo(PAGE.width - PAGE.margin, footerY - 6)
       .strokeColor(navy).lineWidth(0.4).stroke();
    doc.fillColor(muted).font('Helvetica').fontSize(8.5)
       .text(
         `${BRAND.service.legal}  ·  ${BRAND.service.addressInline}  ·  ${BRAND.service.phone}  ·  ${BRAND.service.email}`,
         PAGE.margin, footerY,
         { width: PAGE.width - 2 * PAGE.margin, align: 'center' }
       );

    doc.end();
  });
}

module.exports = { renderViolationLetterPdf };
