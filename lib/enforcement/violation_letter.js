// ============================================================================
// violation_letter.js — Bedrock-rendered HOA enforcement letter generator
// ----------------------------------------------------------------------------
// Renders a violation notice PDF on behalf of the Association. The Association
// is the principal — Bedrock is the managing agent. This is the legal posture
// every line of the letter must preserve.
//
// Three variants driven by violation.current_stage:
//
//   courtesy_1     → "NOTICE OF COMPLIANCE CONCERN"
//                    First-class mail, friendly tone, 30-day cure
//
//   courtesy_2     → "SECOND NOTICE — CONTINUED NON-COMPLIANCE"
//                    First-class mail, escalation warning ("next will be
//                    certified under §209"), references prior notice date
//
//   certified_209  → "FORMAL NOTICE OF COVENANT VIOLATION"
//                    Certified mail w/ return receipt, full §209 framework,
//                    prior-violation history list, hearing-request block,
//                    Servicemembers Civil Relief Act disclosure,
//                    optional fine notice under §209.006(b)(1)
//
//   fine_assessed  → same template as certified_209 but with the fine
//                    explicitly memorialized
//
// What Vantaca's stock letters get right and we preserve:
//   - Association legal name primary in header ("Quail Ridge HOA, Inc")
//   - "c/o Bedrock Association Management LLC" as managing agent
//   - "This community is professionally managed by..." footer
//   - 30-day cure period on §209
//   - Hearing request address block
//   - §209.006(b)(1) fee disclosure when fine assessed
//   - Servicemembers Civil Relief Act notice
//   - Mailed to OWNER's mailing address (not property) — critical for rentals
//
// What we improve over Vantaca:
//   - AI-generated SPECIFIC description ("lawn appears 8-10 inches across
//     front yard"), not generic ("lawn needs to be maintained")
//   - Specific cure DATE not "30 days"
//   - Photo embedded as evidence at usable size
//   - Reference to the actual governing-doc SECTION (DCC&Rs Art IV §4.3)
//     when community_enforcement_priorities.governing_doc_reference is set
//   - Prior violation HISTORY listed on certified ("3rd violation in 12mo")
//   - Cleaner visual hierarchy + Bedrock brand polish
// ============================================================================

const PDFDocument = require('pdfkit');
const { BRAND } = require('./brand_proxy');

const PAGE = { margin: 56, width: 612, height: 792 };
const NAVY  = '#1A3050';
const GOLD  = '#D4AF37';
const INK   = '#1a1a1a';
const MUTED = '#5a5a5a';
const RED   = '#b91c1c';

/**
 * Render the violation letter PDF.
 *
 * @param {Object} ctx
 * @param {Object} ctx.violation        - { current_stage, cure_period_ends_at,
 *                                          opened_at, category_label,
 *                                          rationale, board_priority_at_open }
 * @param {Object} ctx.property         - { street_address, unit, city, state, zip, lot_number }
 * @param {Object} ctx.owner            - { full_name, mailing_address }
 * @param {Object} ctx.community        - { name, legal_name }
 * @param {Object} [ctx.observation]    - { ai_description, severity, captured_at }
 * @param {Buffer} [ctx.photo_buffer]
 * @param {Object} [ctx.governing_doc]  - { reference, section_title, quote, page }
 * @param {Array}  [ctx.prior_violations] - [{ opened_at, current_stage, mail_type }] for §209 history
 * @param {Object} [ctx.fine]           - { amount, notice_under_209 } when fine_assessed
 * @param {Object} ctx.options          - { letter_date, sender_name, sender_title }
 * @returns {Promise<Buffer>}
 */
async function renderViolationLetterPdf(ctx) {
  const v = ctx.violation || {};
  const p = ctx.property || {};
  const o = ctx.owner || {};
  const c = ctx.community || {};
  const obs = ctx.observation || null;
  const govDoc = ctx.governing_doc || null;
  const priors = Array.isArray(ctx.prior_violations) ? ctx.prior_violations : [];
  const fine = ctx.fine || null;
  const opts = ctx.options || {};

  // Stage-derived configuration
  const stage = v.current_stage || 'courtesy_1';
  const isCertified  = stage === 'certified_209' || stage === 'fine_assessed';
  const isSecond     = stage === 'courtesy_2';
  const isFirstCo    = stage === 'courtesy_1';
  const isFine       = stage === 'fine_assessed';
  const requiresHearing = isCertified;

  // Association name (legal_name preferred, fall back to "{name} Homeowners Association, Inc")
  const hoaName = c.legal_name || (c.name ? `${c.name} Homeowners Association, Inc` : 'Your Association');

  // Stage title
  const title = isFine
    ? 'NOTICE OF FINE ASSESSMENT'
    : isCertified
    ? 'FORMAL NOTICE OF COVENANT VIOLATION'
    : isSecond
    ? 'SECOND NOTICE — CONTINUED NON-COMPLIANCE'
    : 'NOTICE OF COMPLIANCE CONCERN';

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

    // ---------------------------------------------------------------------
    // HEADER — Association lockup (HOA primary, Bedrock as agent)
    // ---------------------------------------------------------------------
    const headerTop = PAGE.margin;
    // Small Bedrock cornerstone mark on the right (agent identity, subtle)
    const csW = 24, csH = 30;
    const csX = PAGE.width - PAGE.margin - csW;
    const csY = headerTop + 2;
    doc.fillColor(GOLD);
    doc.moveTo(csX, csY).lineTo(csX + csW, csY).lineTo(csX + csW * 0.95, csY + csH * 0.25).lineTo(csX + csW * 0.05, csY + csH * 0.25).closePath().fill();
    doc.moveTo(csX + csW * 0.06, csY + csH * 0.31).lineTo(csX + csW * 0.94, csY + csH * 0.31).lineTo(csX + csW * 0.89, csY + csH * 0.61).lineTo(csX + csW * 0.11, csY + csH * 0.61).closePath().fill();
    doc.moveTo(csX + csW * 0.13, csY + csH * 0.67).lineTo(csX + csW * 0.87, csY + csH * 0.67).lineTo(csX + csW * 0.83, csY + csH).lineTo(csX + csW * 0.17, csY + csH).closePath().fill();

    // Association legal name (primary)
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13.5).text(hoaName, PAGE.margin, headerTop);
    // Managing agent address block
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
       .text(`c/o ${BRAND.service.legal}`, PAGE.margin, headerTop + 16)
       .text(BRAND.service.address, PAGE.margin, headerTop + 28)
       .text(BRAND.service.addressCityStateZip + '  ·  ' + BRAND.service.phone, PAGE.margin, headerTop + 40);

    // Header rule
    doc.moveTo(PAGE.margin, headerTop + 60)
       .lineTo(PAGE.width - PAGE.margin, headerTop + 60)
       .strokeColor(NAVY).lineWidth(0.6).stroke();

    // ---------------------------------------------------------------------
    // DATE + delivery method tag
    // ---------------------------------------------------------------------
    let y = headerTop + 76;
    const letterDate = opts.letter_date || new Date();
    const dateStr = letterDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(dateStr, PAGE.margin, y);

    if (isCertified) {
      const boxW = 220;
      const boxX = PAGE.width - PAGE.margin - boxW;
      doc.save();
      doc.lineWidth(1.5).strokeColor(RED).rect(boxX, y - 4, boxW, 42).stroke();
      doc.fillColor(RED).font('Helvetica-Bold').fontSize(11)
         .text('CERTIFIED MAIL', boxX, y + 1, { width: boxW, align: 'center' });
      doc.fillColor(RED).font('Helvetica').fontSize(8.5)
         .text('Return Receipt Requested', boxX, y + 16, { width: boxW, align: 'center' });
      doc.fillColor(RED).font('Helvetica').fontSize(8)
         .text('Tex. Prop. Code §209.0064', boxX, y + 27, { width: boxW, align: 'center' });
      doc.restore();
      y += 56;
    } else {
      y += 26;
    }

    // ---------------------------------------------------------------------
    // RECIPIENT — owner's mailing address
    // ---------------------------------------------------------------------
    doc.fillColor(INK).font('Helvetica').fontSize(10.5);
    doc.text(o.full_name || 'Property Owner', PAGE.margin, y);
    y += 14;
    const mailingLines = String(o.mailing_address || `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}\n${p.city || ''}, ${p.state || 'TX'} ${p.zip || ''}`)
      .split(/\n|,(?=\s)/).map((s) => s.trim()).filter(Boolean);
    for (const line of mailingLines) {
      doc.text(line, PAGE.margin, y);
      y += 13;
    }
    y += 14;

    // ---------------------------------------------------------------------
    // TITLE BAND + Reference line
    // ---------------------------------------------------------------------
    doc.save();
    const titleBg = isCertified ? '#fee2e2' : isSecond ? '#fef3c7' : '#dcfce7';
    const titleColor = isCertified ? RED : isSecond ? '#92400e' : '#166534';
    doc.fillColor(titleBg).rect(PAGE.margin, y, PAGE.width - 2 * PAGE.margin, 32).fill();
    doc.fillColor(titleColor).font('Helvetica-Bold').fontSize(13)
       .text(title, PAGE.margin, y + 9, { width: PAGE.width - 2 * PAGE.margin, align: 'center' });
    doc.restore();
    y += 38;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
       .text(`Reference: ${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}, ${p.city || ''} ${p.state || 'TX'} ${p.zip || ''}${p.lot_number ? '  ·  Lot ' + p.lot_number : ''}`,
             PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, align: 'center' });
    y += 22;

    // ---------------------------------------------------------------------
    // SALUTATION + BODY
    // ---------------------------------------------------------------------
    doc.fillColor(INK).font('Helvetica').fontSize(11);
    const salutation = `Dear ${o.full_name ? o.full_name.split(' & ')[0] : 'Property Owner'},`;
    doc.text(salutation, PAGE.margin, y);
    y += 18;

    // Stage-specific opening paragraphs
    const inspDate = (obs && obs.captured_at)
      ? new Date(obs.captured_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'a recent date';

    let bodyParas = [];
    if (isFirstCo) {
      bodyParas = [
        `During our community inspection on ${inspDate}, our team noted a condition at the above property that appears to fall outside the standards set in your ${c.name || 'community'} governing documents.`,
        obs && obs.ai_description
          ? `Specifically: ${obs.ai_description}.`
          : `The specific condition is described above by category.`,
        `This is a courtesy notice. There is no fine, no citation, and no formal action on record. We wanted to give you the opportunity to address the matter at your convenience — most homeowners resolve concerns like this within a few days and that is the end of it.`,
      ];
    } else if (isSecond) {
      // Find the most recent prior violation date for reference
      const lastPrior = priors.length > 0
        ? new Date(priors[0].opened_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : null;
      bodyParas = [
        lastPrior
          ? `We previously wrote to you on ${lastPrior} regarding a covenant concern at the above property. A follow-up inspection on ${inspDate} indicates the concern has not yet been resolved.`
          : `A recent inspection on ${inspDate} indicates a previously-noted concern at this property has not yet been resolved.`,
        obs && obs.ai_description
          ? `The specific condition observed: ${obs.ai_description}.`
          : `Please refer to our prior notice for the specific concern.`,
        `This second notice provides another opportunity to address the matter before formal escalation. We understand life is busy — please contact our office if there is something we should know.`,
      ];
    } else if (isCertified && !isFine) {
      bodyParas = [
        `This is a formal notice under Texas Property Code §209 regarding an ongoing covenant violation at the above property. ${hoaName} has documented prior notices about this matter that remain uncured.`,
        obs && obs.ai_description
          ? `The specific condition observed during our inspection on ${inspDate}: ${obs.ai_description}.`
          : `The specific violation was noted above. Please refer to our prior correspondence for additional detail.`,
      ];
    } else if (isFine) {
      bodyParas = [
        `This notice memorializes a fine assessment against your account for an unresolved covenant violation at the above property. The fine is being assessed after written notice and an opportunity to cure under Texas Property Code §209.`,
        `The violation: ${v.category_label || 'covenant compliance'}.`,
      ];
    }

    for (const para of bodyParas) {
      doc.text(para, PAGE.margin, y, {
        width: PAGE.width - 2 * PAGE.margin, align: 'left', lineGap: 2.5,
      });
      y = doc.y + 9;
    }

    // ---------------------------------------------------------------------
    // GOVERNING-DOC REFERENCE (when populated for this community + category)
    // ---------------------------------------------------------------------
    if (govDoc && (govDoc.reference || govDoc.section_title)) {
      doc.save();
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
         .text('Governing document reference', PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin });
      y = doc.y + 4;
      let refLine = govDoc.reference || '';
      if (govDoc.section_title) refLine += refLine ? `  —  ${govDoc.section_title}` : govDoc.section_title;
      if (govDoc.page) refLine += `  (p. ${govDoc.page})`;
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(refLine, PAGE.margin, y);
      y = doc.y + 6;
      if (govDoc.quote) {
        doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10)
           .text(`"${govDoc.quote.replace(/^["']|["']$/g, '').trim()}"`,
                 PAGE.margin + 20, y, {
                   width: PAGE.width - 2 * PAGE.margin - 20,
                   align: 'left', lineGap: 2,
                 });
        y = doc.y + 8;
      }
      doc.restore();
      y += 4;
    }

    // ---------------------------------------------------------------------
    // EVIDENCE PHOTO
    // ---------------------------------------------------------------------
    if (ctx.photo_buffer) {
      try {
        if (y > PAGE.height - 320) { doc.addPage(); y = PAGE.margin; }
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9.5)
           .text('PHOTO  —  TAKEN ON SITE', PAGE.margin, y, { characterSpacing: 0.8 });
        y += 14;
        const photoMaxW = PAGE.width - 2 * PAGE.margin;
        const photoMaxH = 240;
        doc.image(ctx.photo_buffer, PAGE.margin, y, { fit: [photoMaxW, photoMaxH], align: 'left' });
        y = doc.y + 6;
        if (obs && obs.captured_at) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
             .text(`Photographed ${new Date(obs.captured_at).toLocaleString()}.`, PAGE.margin, y);
          y += 14;
        }
      } catch (e) {
        console.warn('[letter] photo embed failed:', e.message);
      }
    }

    // ---------------------------------------------------------------------
    // PRIOR VIOLATION HISTORY (certified variants)
    // ---------------------------------------------------------------------
    if (isCertified && priors.length > 0) {
      if (y > PAGE.height - 200) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
         .text('Prior notices on this matter', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10);
      const stageLabel = (s) => ({
        courtesy_1: 'Courtesy notice (first-class mail)',
        courtesy_2: 'Second notice (first-class mail)',
        certified_209: 'Certified §209 notice (certified mail)',
        fine_assessed: 'Fine assessed',
      })[s] || s;
      for (const pv of priors.slice(0, 5)) {
        const d = pv.opened_at ? new Date(pv.opened_at).toLocaleDateString() : '—';
        doc.text(`•  ${d}  —  ${stageLabel(pv.current_stage)}`, PAGE.margin + 14, y);
        y = doc.y + 2;
      }
      y += 6;
    }

    // ---------------------------------------------------------------------
    // CURE DEADLINE + ACTION
    // ---------------------------------------------------------------------
    const cureDateStr = v.cure_period_ends_at
      ? new Date(v.cure_period_ends_at).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : null;

    if (y > PAGE.height - 220) { doc.addPage(); y = PAGE.margin; }

    if (!isFine && cureDateStr) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
         .text(`Please remedy by ${cureDateStr}.`, PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin });
      y = doc.y + 6;
      if (isFirstCo) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`If the work is already underway, or if you believe this letter was sent in error, please reply by email at ${BRAND.service.email} or call ${BRAND.service.phone}.`,
                 PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
        y = doc.y + 6;
      } else if (isSecond) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`If the matter remains uncured after that date, our next correspondence will be sent via certified mail under Texas Property Code §209 — which preserves the Association's right to assess fines and recover attorney fees. Please contact our office at ${BRAND.service.phone} if circumstances are preventing the cure.`,
                 PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
        y = doc.y + 6;
      } else if (isCertified && !isFine) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`This cure period is longer than the statutory minimum. If the violation is not cured by the date above, the Association may proceed to assess fines under your governing documents, recover all reasonable attorney fees and costs under Tex. Prop. Code §209.008, and pursue other remedies authorized under the CC&Rs.`,
                 PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
        y = doc.y + 6;
      }
    }

    // ---------------------------------------------------------------------
    // HEARING REQUEST BLOCK (certified variants — required under §209.0064)
    // ---------------------------------------------------------------------
    if (requiresHearing) {
      if (y > PAGE.height - 180) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
         .text('Right to a hearing', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`Under Texas Property Code §209.0064, you may request a hearing before the Board of Directors before any fine is assessed. To request a hearing, submit your written request within thirty (30) days of receipt of this notice to:`,
               PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
      y = doc.y + 6;
      // Address block
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5)
         .text(hoaName, PAGE.margin + 20, y);
      y = doc.y + 1;
      doc.font('Helvetica').fontSize(10.5)
         .text(`c/o ${BRAND.service.legal}`, PAGE.margin + 20, y);
      y = doc.y + 1;
      doc.text(BRAND.service.address, PAGE.margin + 20, y);
      y = doc.y + 1;
      doc.text(BRAND.service.addressCityStateZip, PAGE.margin + 20, y);
      y = doc.y + 8;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`If you request a hearing, you will be notified in writing of the date, time, and place.`,
               PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
      y = doc.y + 8;
    }

    // ---------------------------------------------------------------------
    // FINE NOTICE — §209.006(b)(1) disclosure
    // ---------------------------------------------------------------------
    if (isFine || (fine && fine.amount)) {
      if (y > PAGE.height - 130) { doc.addPage(); y = PAGE.margin; }
      const amt = (fine && fine.amount) || 0;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
         .text('Fine assessment notice', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`A fine of $${Number(amt).toFixed(2)} has been assessed against the account for this property. This notice is included to comply with Texas Property Code §209.006(b)(1).`,
               PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
      y = doc.y + 8;
    }

    // ---------------------------------------------------------------------
    // SERVICEMEMBERS CIVIL RELIEF ACT (certified variants — required disclosure)
    // ---------------------------------------------------------------------
    if (isCertified) {
      if (y > PAGE.height - 110) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
         .text(`Servicemembers Civil Relief Act: If the owner is serving on active military duty, you may have special rights or relief under 50 U.S.C. App. §501 et seq.`,
               PAGE.margin, y, { width: PAGE.width - 2 * PAGE.margin, lineGap: 2 });
      y = doc.y + 10;
    }

    // ---------------------------------------------------------------------
    // SIGN-OFF
    // ---------------------------------------------------------------------
    if (y > PAGE.height - 130) { doc.addPage(); y = PAGE.margin; }
    doc.fillColor(INK).font('Helvetica').fontSize(11);
    doc.text('Respectfully,', PAGE.margin, y);
    y += 30;
    doc.font('Helvetica-Bold').fontSize(11).text(opts.sender_name || hoaName, PAGE.margin, y);
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
       .text(opts.sender_title || `On behalf of the ${c.name || ''} Board of Directors`.trim(), PAGE.margin, y);
    y = doc.y + 2;
    doc.text(`Issued by ${BRAND.service.legal}, managing agent.`, PAGE.margin, y);

    // ---------------------------------------------------------------------
    // FOOTER — managed-by line + contact
    // ---------------------------------------------------------------------
    const footerY = PAGE.height - PAGE.margin + 12;
    doc.moveTo(PAGE.margin, footerY - 8)
       .lineTo(PAGE.width - PAGE.margin, footerY - 8)
       .strokeColor(NAVY).lineWidth(0.4).stroke();
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5)
       .text(`This community is professionally managed by ${BRAND.service.legal}.`,
             PAGE.margin, footerY - 2,
             { width: PAGE.width - 2 * PAGE.margin, align: 'center' });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
       .text(`${BRAND.service.addressInline}  ·  ${BRAND.service.phone}  ·  ${BRAND.service.email}  ·  ${BRAND.service.website}`,
             PAGE.margin, footerY + 8,
             { width: PAGE.width - 2 * PAGE.margin, align: 'center' });

    doc.end();
  });
}

module.exports = { renderViolationLetterPdf };
