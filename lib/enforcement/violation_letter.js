// ============================================================================
// violation_letter.js — Bedrock-rendered HOA enforcement letter generator
// ----------------------------------------------------------------------------
// Renders a violation notice PDF on behalf of the Association. The Association
// is the principal — Bedrock is the managing agent. This is the legal posture
// every line of the letter must preserve.
//
// Bundle-aware: one PDF can cover multiple violations at the same property
// + stage. The empty-chair lens drives this: Mrs. Henderson with three
// findings on the same inspection walk gets ONE envelope, not three. The
// audit trail stays clean because each violation still has its own
// interactions row pointing at the same PDF via attachments.
//
// Four stage variants:
//
//   courtesy_1     → "NOTICE OF COMPLIANCE CONCERN" — first-class mail,
//                    friendly tone, 20-day cure (per-community default)
//
//   courtesy_2     → "SECOND NOTICE — CONTINUED NON-COMPLIANCE" — first-class
//                    mail, escalation warning, 20-day cure (per-community)
//
//   certified_209  → "FORMAL NOTICE OF COVENANT VIOLATION" — certified mail
//                    w/ return receipt, full §209 framework, hearing-request
//                    block, SCRA disclosure, belt-and-suspenders postmark
//                    language so cure deadline calculation is bulletproof
//                    even when print date and postmark differ by 1-2 days,
//                    30-day cure (statute-anchored)
//
//   fine_assessed  → same template as certified_209 but with the fine
//                    explicitly memorialized
//
// What the bundle-aware generator preserves from the prior version:
//   - Association legal name primary in header; Bedrock as managing agent
//   - "This community is professionally managed by..." footer
//   - SCRA notice on certified
//   - Hearing-request address block + 30-day request window
//   - §209.006(b)(1) fee disclosure when fine assessed
//   - Mailed to OWNER's mailing address (not property) — critical for rentals
//
// What's new:
//   - One letter, N violations rendered as labeled Item 1 / Item 2 / Item 3 …
//   - Wide-shot block at top establishes property identity for the whole
//     letter (the wrong-house insurance); close-up photo per violation
//     documents each issue
//   - Cure-by + hearing-request dates calculated from letter_date (the
//     mailing date), stamped at Mail Queue lock time
//   - Per-community admin fee (letter_fee_*_cents on communities row)
//   - Per-community cure days (letter_cure_days_*_courtesy_1/2/certified_209)
//   - Belt-and-suspenders language: "the 30-day window runs from the
//     postmark date of this certified mailing" — closes the legal-challenge
//     surface when print and mail dates differ
//   - Cure-before-deadline kills-the-fine language (§ 209.006(e))
//   - Honorific detection on salutation (Mr. / Mrs. / Mr. and Mrs. fallback)
//   - Prior notices listed with specific dates (not "previously notified")
// ============================================================================

const PDFDocument = require('pdfkit');
const { BRAND } = require('./brand_proxy');

const PAGE = { margin: 56, width: 612, height: 792 };
const NAVY  = '#1A3050';
const GOLD  = '#D4AF37';
const INK   = '#1a1a1a';
const MUTED = '#5a5a5a';
const RED   = '#b91c1c';

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

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

function addDays(d, n) {
  const out = new Date(d.getTime ? d.getTime() : new Date(d).getTime());
  out.setDate(out.getDate() + n);
  return out;
}

function dollarsFromCents(cents) {
  return Number(cents || 0) / 100;
}

function deriveCureDays(stage, community) {
  if (!community) return 30;
  if (stage === 'courtesy_1')    return Number(community.letter_cure_days_courtesy_1 || 20);
  if (stage === 'courtesy_2')    return Number(community.letter_cure_days_courtesy_2 || 20);
  if (stage === 'certified_209' || stage === 'fine_assessed') return Number(community.letter_cure_days_certified_209 || 30);
  return 30;
}

function deriveLetterFeeCents(stage, community) {
  if (!community) return 0;
  if (stage === 'courtesy_1')    return Number(community.letter_fee_courtesy_1_cents    || 0);
  if (stage === 'courtesy_2')    return Number(community.letter_fee_courtesy_2_cents    || 2500);
  if (stage === 'certified_209') return Number(community.letter_fee_certified_209_cents || 3500);
  if (stage === 'fine_assessed') return Number(community.letter_fee_fine_assessed_cents || 0);
  return 0;
}

// Build the authority statement that appears after the opening paragraph of
// every enforcement letter. Spells out: who is sending (Bedrock as managing
// agent), on whose behalf (the Board), and what gives them the right (the
// Association's CC&Rs). For certified §209 + fine letters, also cites the
// Texas Property Code sections that authorize the certified-mail process and
// fine schedule. Without this statement, a homeowner reading a courtesy
// letter has no way to know what authority is asking them to remediate —
// which weakens legal defensibility if the matter ever escalates.
function buildAuthorityStatement(stage, hoaName, authorityCitation) {
  // If the community has a specific article/section citation on file, drop
  // it directly into the CC&R clause so homeowners (and counsel on review)
  // can see the exact rule we're enforcing under. Otherwise fall back to a
  // generic but defensible reference to the maintenance, architectural-
  // review, and enforcement powers of the Board.
  const citation = (authorityCitation || '').trim();
  const ccrClause = citation
    ? `pursuant to ${citation} of the Association's Declaration of Covenants, Conditions, and Restrictions (CC&Rs), which grants the Board the authority to enforce the community's architectural and covenant standards`
    : `pursuant to the Association's Declaration of Covenants, Conditions, and Restrictions (CC&Rs) — in particular the Articles governing property maintenance, architectural review, and the enforcement powers of the Board — which grant the Board the authority to enforce the community's architectural and covenant standards`;
  let txt =
    `Authority: This notice is issued by ${BRAND.service.legal}, managing agent for ${hoaName}, ` +
    `acting on behalf of and at the direction of the Board of Directors ${ccrClause}.`;
  if (stage === 'certified_209' || stage === 'fine_assessed') {
    txt += ' This formal notice satisfies the written-notice and opportunity-to-cure requirements of Texas Property Code §209.006.';
  }
  if (stage === 'fine_assessed') {
    txt += ' Fines are assessed in accordance with the Board-approved fine schedule and Texas Property Code §209.0064.';
  }
  return txt;
}

// Honorific detection. Owner record may have full_name like "Jose Alvarez" or
// "Jose & Maria Alvarez" or "JOSE M ALVAREZ". Best-effort title prefix.
function buildSalutation(ownerName) {
  if (!ownerName) return 'Dear Property Owner,';
  const raw = String(ownerName).trim();
  // Multi-owner: "X & Y Lastname"
  if (raw.includes('&') || /\band\b/i.test(raw)) {
    const parts = raw.split(/\s*&\s*|\s+and\s+/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      // last name lives at end of last part; if last part is one word, both share a last name
      const tokens = parts[parts.length - 1].split(/\s+/);
      if (tokens.length === 1) {
        return `Dear Mr. and Mrs. ${tokens[0]},`;
      }
      const last = tokens[tokens.length - 1];
      return `Dear Mr. and Mrs. ${last},`;
    }
  }
  const tokens = raw.split(/\s+/);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    return `Dear Mr. ${last.replace(/^./, (c) => c.toUpperCase())},`;
  }
  return `Dear ${raw},`;
}

// ----------------------------------------------------------------------------
// MAIN — renderViolationLetterBundlePdf
// ----------------------------------------------------------------------------
/**
 * @param {Object} ctx
 * @param {Object} ctx.property       — { street_address, unit, city, state, zip, lot_number }
 * @param {Object} ctx.owner          — { full_name, mailing_address }
 * @param {Object} ctx.community      — { name, legal_name, letter_sender_name, letter_sender_title,
 *                                         letter_fee_*_cents, letter_cure_days_*,
 *                                         letter_payment_url, letter_pay_to_name, letter_pay_to_address }
 * @param {string} ctx.stage          — 'courtesy_1' | 'courtesy_2' | 'certified_209' | 'fine_assessed'
 * @param {Date}   [ctx.letter_date]  — defaults to now; should be set to actual mailing date by caller
 * @param {Buffer} [ctx.wide_photo_buffer]   — single wide shot of the property (identification)
 * @param {Array}  ctx.violations     — [{
 *     category_label, ai_description, observation_captured_at,
 *     governing_doc: { reference, section_title, quote, page },
 *     prior_notices: [{ date, stage, delivery_method }],
 *     close_up_photo_buffer: Buffer,
 *     fine_amount,
 *   }]
 * @param {Object} [ctx.options]      — { sender_name, sender_title, certified_tracking_number }
 * @returns {Promise<Buffer>}
 */
async function renderViolationLetterBundlePdf(ctx) {
  const p = ctx.property || {};
  const o = ctx.owner || {};
  const c = ctx.community || {};
  const stage = ctx.stage || 'courtesy_1';
  const violations = Array.isArray(ctx.violations) ? ctx.violations : [];
  const opts = ctx.options || {};
  const letterDate = ctx.letter_date ? new Date(ctx.letter_date) : new Date();
  const cureDays = deriveCureDays(stage, c);
  const cureBy = addDays(letterDate, cureDays);
  const hearingBy = addDays(letterDate, 30); // statute-fixed 30 days from notice mailing

  const isCertified  = stage === 'certified_209' || stage === 'fine_assessed';
  const isSecond     = stage === 'courtesy_2';
  const isFirstCo    = stage === 'courtesy_1';
  const isFine       = stage === 'fine_assessed';
  const requiresHearing = isCertified;
  const isMulti = violations.length > 1;

  const hoaName = c.legal_name || (c.name ? `${c.name} Homeowners Association, Inc.` : 'Your Association');
  const senderName  = opts.sender_name  || c.letter_sender_name  || hoaName;
  const senderTitle = opts.sender_title || c.letter_sender_title || `On behalf of the ${c.name || ''} Board of Directors`.trim();
  const feeCents = deriveLetterFeeCents(stage, c);
  const feeDollars = dollarsFromCents(feeCents);
  const payToName    = c.letter_pay_to_name    || hoaName;
  const payToAddress = c.letter_pay_to_address || '';
  const paymentUrl   = c.letter_payment_url    || (BRAND.service && BRAND.service.paymentUrl) || 'home.bedrocktx.com';

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

    let y = PAGE.margin;
    const contentWidth = PAGE.width - 2 * PAGE.margin;

    // -----------------------------------------------------------------------
    // HEADER — Co-branded lockup
    // -----------------------------------------------------------------------
    // Community logo (left, primary — the Association is the principal),
    // Bedrock cornerstone mark (right, subtle agent identity).
    // Falls back to text-only HOA name + cornerstone when no community logo
    // is on file.
    const csW = 24, csH = 30;
    const csX = PAGE.width - PAGE.margin - csW;
    const csY = y + 2;
    doc.fillColor(GOLD);
    doc.moveTo(csX, csY).lineTo(csX + csW, csY).lineTo(csX + csW * 0.95, csY + csH * 0.25).lineTo(csX + csW * 0.05, csY + csH * 0.25).closePath().fill();
    doc.moveTo(csX + csW * 0.06, csY + csH * 0.31).lineTo(csX + csW * 0.94, csY + csH * 0.31).lineTo(csX + csW * 0.89, csY + csH * 0.61).lineTo(csX + csW * 0.11, csY + csH * 0.61).closePath().fill();
    doc.moveTo(csX + csW * 0.13, csY + csH * 0.67).lineTo(csX + csW * 0.87, csY + csH * 0.67).lineTo(csX + csW * 0.83, csY + csH).lineTo(csX + csW * 0.17, csY + csH).closePath().fill();

    // Community logo embed — caller passes ctx.community_logo_buffer when
    // the community has logo_storage_path set. Aspect-ratio preserved,
    // fits a 60×60 box on the left of the masthead.
    const logoBoxW = 60, logoBoxH = 60;
    let nameX = PAGE.margin;
    if (ctx.community_logo_buffer) {
      try {
        doc.image(ctx.community_logo_buffer, PAGE.margin, y, {
          fit: [logoBoxW, logoBoxH], align: 'left', valign: 'top',
        });
        nameX = PAGE.margin + logoBoxW + 14; // shove text past the logo
      } catch (e) {
        console.warn('[letter] community logo embed failed:', e.message);
      }
    }

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13.5).text(hoaName, nameX, y);
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
       .text(`c/o ${BRAND.service.legal}`, nameX, y + 16)
       .text(BRAND.service.address, nameX, y + 28)
       .text(BRAND.service.addressCityStateZip + '  ·  ' + BRAND.service.phone, nameX, y + 40);

    doc.moveTo(PAGE.margin, y + 60).lineTo(PAGE.width - PAGE.margin, y + 60)
       .strokeColor(NAVY).lineWidth(0.6).stroke();
    y += 76;

    // -----------------------------------------------------------------------
    // DATE + delivery method tag
    // -----------------------------------------------------------------------
    doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(fmtShortDate(letterDate), PAGE.margin, y);

    if (isCertified) {
      const boxW = 220;
      const boxX = PAGE.width - PAGE.margin - boxW;
      doc.save();
      doc.lineWidth(1.5).strokeColor(RED).rect(boxX, y - 4, boxW, 42).stroke();
      doc.fillColor(RED).font('Helvetica-Bold').fontSize(11)
         .text('CERTIFIED MAIL', boxX, y + 1, { width: boxW, align: 'center' });
      doc.fillColor(RED).font('Helvetica').fontSize(8.5)
         .text('Return Receipt Requested', boxX, y + 16, { width: boxW, align: 'center' });
      const trackLine = opts.certified_tracking_number
        ? `Tracking # ${opts.certified_tracking_number}`
        : 'Tex. Prop. Code §209.006';
      doc.fillColor(RED).font('Helvetica').fontSize(8)
         .text(trackLine, boxX, y + 27, { width: boxW, align: 'center' });
      doc.restore();
      y += 56;
    } else {
      y += 26;
    }

    // -----------------------------------------------------------------------
    // RECIPIENT
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // TITLE BAND + reference
    // -----------------------------------------------------------------------
    doc.save();
    const titleBg = isCertified ? '#fee2e2' : isSecond ? '#fef3c7' : '#dcfce7';
    const titleColor = isCertified ? RED : isSecond ? '#92400e' : '#166534';
    doc.fillColor(titleBg).rect(PAGE.margin, y, contentWidth, 32).fill();
    doc.fillColor(titleColor).font('Helvetica-Bold').fontSize(13)
       .text(title, PAGE.margin, y + 9, { width: contentWidth, align: 'center' });
    doc.restore();
    y += 38;
    const propRefLine = `${p.street_address || ''}${p.unit ? ' #' + p.unit : ''}, ${p.city || ''} ${p.state || 'TX'} ${p.zip || ''}${p.lot_number ? '  ·  Lot ' + p.lot_number : ''}`;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
       .text(`Reference: ${propRefLine}`, PAGE.margin, y, { width: contentWidth, align: 'center' });
    y += 22;

    // -----------------------------------------------------------------------
    // SALUTATION + opening
    // -----------------------------------------------------------------------
    doc.fillColor(INK).font('Helvetica').fontSize(11);
    doc.text(buildSalutation(o.full_name), PAGE.margin, y);
    y += 18;

    const inspectionDates = [...new Set(
      violations.map((v) => v.observation_captured_at ? fmtShortDate(v.observation_captured_at) : null).filter(Boolean)
    )];
    const inspectionDateStr = inspectionDates[0] || 'a recent inspection date';
    const itemNoun = isMulti ? `${violations.length} compliance concerns` : 'a compliance concern';

    let opening = '';
    if (isFirstCo) {
      opening = isMulti
        ? `During our community inspection on ${inspectionDateStr}, our team noted ${itemNoun} at your property that appear to fall outside the standards set in your ${c.name || 'community'} governing documents. This is a courtesy notice — there is no fine, no citation, and no formal action on record. Most homeowners resolve concerns like these within a few days and that is the end of it.`
        : `During our community inspection on ${inspectionDateStr}, our team noted ${itemNoun} at your property that appears to fall outside the standards set in your ${c.name || 'community'} governing documents. This is a courtesy notice — there is no fine, no citation, and no formal action on record. We wanted to give you the opportunity to address the matter at your convenience.`;
    } else if (isSecond) {
      opening = isMulti
        ? `A follow-up inspection on ${inspectionDateStr} indicates ${violations.length} previously-noted concerns at this property have not yet been resolved. This second notice provides another opportunity to address the matters before formal escalation under Texas Property Code §209.`
        : `A follow-up inspection on ${inspectionDateStr} indicates a previously-noted concern at this property has not yet been resolved. This second notice provides another opportunity to address the matter before formal escalation under Texas Property Code §209.`;
    } else if (isCertified && !isFine) {
      opening = isMulti
        ? `This is a formal notice under Texas Property Code §209 regarding ${violations.length} ongoing covenant violations at the above property. ${hoaName} has documented prior notices on these matters that remain uncured. Each violation is detailed below.`
        : `This is a formal notice under Texas Property Code §209 regarding an ongoing covenant violation at the above property. ${hoaName} has documented prior notices about this matter that remain uncured.`;
    } else if (isFine) {
      opening = isMulti
        ? `This notice memorializes fine assessments against your account for ${violations.length} unresolved covenant violations at the above property. Fines are being assessed after written notice and an opportunity to cure under Texas Property Code §209.`
        : `This notice memorializes a fine assessment against your account for an unresolved covenant violation at the above property. The fine is being assessed after written notice and an opportunity to cure under Texas Property Code §209.`;
    }
    doc.text(opening, PAGE.margin, y, { width: contentWidth, align: 'left', lineGap: 2.5 });
    y = doc.y + 10;

    // -----------------------------------------------------------------------
    // AUTHORITY STATEMENT — small italic disclosure citing the Board's
    // enforcement authority under the CC&Rs (plus TX §209 references on
    // certified stages). Defensible standard footer; doesn't fight the
    // warm tone of the courtesy body above it.
    // -----------------------------------------------------------------------
    const authorityText = buildAuthorityStatement(stage, hoaName, c.enforcement_authority_citation);
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9)
       .text(authorityText, PAGE.margin, y, { width: contentWidth, align: 'left', lineGap: 1.5 });
    y = doc.y + 14;
    doc.fillColor(INK).font('Helvetica').fontSize(11);  // reset back to body style

    // -----------------------------------------------------------------------
    // WIDE-SHOT — property identification (the wrong-house insurance)
    // -----------------------------------------------------------------------
    if (ctx.wide_photo_buffer) {
      try {
        if (y > PAGE.height - 240) { doc.addPage(); y = PAGE.margin; }
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9.5)
           .text('PROPERTY  —  AS DOCUMENTED ON SITE', PAGE.margin, y, { characterSpacing: 0.8 });
        y += 14;
        // pdfkit's doc.y doesn't reliably advance past image() calls — manually
        // advance by the max fit height so the next element doesn't overlap.
        const imgY = y;
        doc.image(ctx.wide_photo_buffer, PAGE.margin, imgY, { fit: [contentWidth, 180], align: 'left' });
        y = imgY + 180 + 6;
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
           .text(`Wide view of ${propRefLine}, photographed during ${inspectionDateStr}.`, PAGE.margin, y);
        y = doc.y + 14;
      } catch (e) {
        console.warn('[letter] wide photo embed failed:', e.message);
      }
    }

    // -----------------------------------------------------------------------
    // VIOLATION ITEMS — per-violation sections
    // -----------------------------------------------------------------------
    for (let i = 0; i < violations.length; i++) {
      const v = violations[i];
      if (y > PAGE.height - 280) { doc.addPage(); y = PAGE.margin; }

      // Item header (bar with item number + category)
      doc.save();
      doc.fillColor('#f1f5fb').rect(PAGE.margin, y, contentWidth, 24).fill();
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11)
         .text(isMulti ? `Item ${i + 1} — ${v.category_label || 'Covenant violation'}` : (v.category_label || 'Covenant violation'),
               PAGE.margin + 10, y + 7, { width: contentWidth - 20 });
      doc.restore();
      y += 30;

      // Description
      if (v.ai_description) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(v.ai_description, PAGE.margin, y, { width: contentWidth, lineGap: 2 });
        y = doc.y + 6;
      }

      // Governing doc
      if (v.governing_doc && (v.governing_doc.reference || v.governing_doc.section_title)) {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5)
           .text('Governing document reference', PAGE.margin, y);
        y = doc.y + 2;
        let refLine = v.governing_doc.reference || '';
        if (v.governing_doc.section_title) refLine += refLine ? `  —  ${v.governing_doc.section_title}` : v.governing_doc.section_title;
        if (v.governing_doc.page) refLine += `  (p. ${v.governing_doc.page})`;
        doc.fillColor(INK).font('Helvetica').fontSize(10).text(refLine, PAGE.margin, y);
        y = doc.y + 4;
        if (v.governing_doc.quote) {
          doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
             .text(`"${v.governing_doc.quote.replace(/^["']|["']$/g, '').trim()}"`,
                   PAGE.margin + 16, y, { width: contentWidth - 16, lineGap: 1.5 });
          y = doc.y + 6;
        }
      }

      // Close-up photo
      if (v.close_up_photo_buffer) {
        try {
          if (y > PAGE.height - 220) { doc.addPage(); y = PAGE.margin; }
          // Manual Y advance past the image so subsequent text doesn't overlap.
          const imgY = y;
          doc.image(v.close_up_photo_buffer, PAGE.margin, imgY, { fit: [contentWidth, 180], align: 'left' });
          y = imgY + 180 + 4;
          if (v.observation_captured_at) {
            doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
               .text(`Close-up photo, ${fmtShortDate(v.observation_captured_at)}.`, PAGE.margin, y);
            y = doc.y + 12;
          }
        } catch (e) {
          console.warn('[letter] close-up photo embed failed:', e.message);
        }
      }

      // Prior notices for this violation (certified variants)
      if (isCertified && Array.isArray(v.prior_notices) && v.prior_notices.length > 0) {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5)
           .text('Prior notices on this matter', PAGE.margin, y);
        y = doc.y + 2;
        doc.fillColor(INK).font('Helvetica').fontSize(10);
        const stageLabel = (s) => ({
          courtesy_1: 'Courtesy notice (first-class mail)',
          courtesy_2: 'Second notice (first-class mail)',
          certified_209: 'Certified §209 notice (certified mail)',
          fine_assessed: 'Fine assessed',
        })[s] || s;
        for (const pn of v.prior_notices.slice(0, 5)) {
          const d = pn.date ? fmtShortDate(pn.date) : '—';
          doc.text(`•  ${d}  —  ${stageLabel(pn.stage)}`, PAGE.margin + 14, y);
          y = doc.y + 1;
        }
        y += 4;
      }

      // Fine for this violation (fine_assessed only)
      if (isFine && v.fine_amount) {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
           .text(`Fine assessed for this item: $${Number(v.fine_amount).toFixed(2)}`, PAGE.margin, y);
        y = doc.y + 4;
      }
      y += 6;
    }

    // -----------------------------------------------------------------------
    // ACTION REQUIRED — single block for the whole bundle
    // -----------------------------------------------------------------------
    if (y > PAGE.height - 220) { doc.addPage(); y = PAGE.margin; }
    doc.save();
    doc.fillColor('#f8fafc').rect(PAGE.margin, y, contentWidth, 4).fill();
    doc.restore();
    y += 10;

    if (!isFine) {
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5)
         .text(isMulti ? 'Please remedy all items above by:' : 'Please remedy by:', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
         .text(fmtLongDate(cureBy), PAGE.margin, y);
      y = doc.y + 8;

      if (isFirstCo) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`If the work is already underway, or if you believe this letter was sent in error, please reply by email at ${BRAND.service.email} or call ${BRAND.service.phone}. We'd rather resolve this with you than continue escalation.`,
                 PAGE.margin, y, { width: contentWidth, lineGap: 2 });
        y = doc.y + 6;
      } else if (isSecond) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`If the matter remains uncured after that date, our next correspondence will be a certified §209 notice — which preserves the Association's right to assess fines and recover attorney fees. Please contact our office at ${BRAND.service.phone} if circumstances are preventing the cure.`,
                 PAGE.margin, y, { width: contentWidth, lineGap: 2 });
        y = doc.y + 6;
      } else if (isCertified && !isFine) {
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`If the violation${isMulti ? 's are' : ' is'} cured before this date, no fine may be assessed under Tex. Prop. Code §209.006(e). If not cured by this date, the Association may proceed to assess fines under your governing documents, recover all reasonable attorney fees and costs under §209.008, and pursue other remedies authorized under the CC&Rs.`,
                 PAGE.margin, y, { width: contentWidth, lineGap: 2 });
        y = doc.y + 6;

        // Belt-and-suspenders: closes the legal challenge surface if the
        // letter's printed date differs from the actual postmark date.
        doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
           .text(`Note: the 30-day cure period and hearing-request window run from the postmark date of this certified mailing — the date this notice was deposited with the United States Postal Service. The dates above reflect that deposit date.`,
                 PAGE.margin, y, { width: contentWidth, lineGap: 2 });
        y = doc.y + 8;
      }
    } else {
      // Fine notice — "how to stop the recurring fine" path
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5)
         .text('How to stop further fines:', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`Once the violation${isMulti ? 's are' : ' is'} corrected, please notify our office at ${BRAND.service.phone} or reply to this letter so we can verify at next inspection. No further fines accrue once compliance is verified. We'd rather have this resolved than continue assessing.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 8;
    }

    // -----------------------------------------------------------------------
    // HEARING REQUEST (certified variants)
    // -----------------------------------------------------------------------
    if (requiresHearing) {
      if (y > PAGE.height - 180) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
         .text('Right to a hearing', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`Under Texas Property Code §209.007, you may request a hearing before the Board of Directors. Submit a written request on or before ${fmtLongDate(hearingBy)} to:`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 6;
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(hoaName, PAGE.margin + 20, y);
      y = doc.y + 1;
      doc.font('Helvetica').fontSize(10.5).text(`c/o ${BRAND.service.legal}`, PAGE.margin + 20, y);
      y = doc.y + 1;
      doc.text(BRAND.service.address, PAGE.margin + 20, y);
      y = doc.y + 1;
      doc.text(BRAND.service.addressCityStateZip, PAGE.margin + 20, y);
      y = doc.y + 8;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`If you request a hearing, you will be notified in writing of the date, time, and place at least 10 days in advance.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 8;
    }

    // -----------------------------------------------------------------------
    // FEE NOTICE — Ed's preferred framing: homeowners don't pay these fees
    // directly. Admin fees + fines are assessed to the homeowner's HOA
    // ledger (Vantaca) and collected through the normal assessment cycle.
    // -----------------------------------------------------------------------
    //   Courtesy 1:    no fee block — letter is purely an oversight reminder
    //   Courtesy 2:    brief heads-up that escalating to certified §209 will
    //                  trigger an admin fee on the account
    //   Certified §209: admin fee charged to the account (statutory disclosure)
    //   Fine assessed: fine + admin fee both on the account
    //
    // No "Payment options" / lockbox / online portal block on any of these —
    // payment doesn't happen here; it happens through the regular AR cycle.
    // -----------------------------------------------------------------------
    const totalFineAmount = isFine
      ? violations.reduce((sum, v) => sum + (Number(v.fine_amount) || 0), 0)
      : 0;

    if (isSecond && feeCents > 0) {
      if (y > PAGE.height - 100) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
         .text(`Note: if the matter remains uncured and a certified §209 notice becomes necessary, a $${feeDollars.toFixed(2)} administrative fee will be assessed to your Association account.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 8;
    }

    if (isCertified && feeCents > 0) {
      if (y > PAGE.height - 100) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
         .text('Administrative fee', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`A $${feeDollars.toFixed(2)} administrative fee for certified mailing and processing has been assessed to your Association account. This disclosure is included to comply with Tex. Prop. Code §209.006(b)(1).`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 8;
    }

    if (totalFineAmount > 0) {
      if (y > PAGE.height - 100) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5)
         .text('Fine assessed', PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10.5)
         .text(`Total fine${isMulti ? 's' : ''} assessed: $${totalFineAmount.toFixed(2)}. The amount has been added to your Association account. The Association's full enforcement and fine policy is available upon request.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 8;
    }

    // -----------------------------------------------------------------------
    // SCRA NOTICE (certified)
    // -----------------------------------------------------------------------
    if (isCertified) {
      if (y > PAGE.height - 110) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
         .text(`Servicemembers Civil Relief Act: If the owner is serving on active military duty, you may have special rights or relief under 50 U.S.C. App. §501 et seq.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 10;
    }

    // -----------------------------------------------------------------------
    // SIGN-OFF
    // -----------------------------------------------------------------------
    if (y > PAGE.height - 130) { doc.addPage(); y = PAGE.margin; }
    doc.fillColor(INK).font('Helvetica').fontSize(11);
    doc.text('Respectfully,', PAGE.margin, y);
    y += 30;
    doc.font('Helvetica-Bold').fontSize(11).text(senderName, PAGE.margin, y);
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(senderTitle, PAGE.margin, y);
    y = doc.y + 2;
    doc.text(`Issued by ${BRAND.service.legal}, managing agent.`, PAGE.margin, y);

    // -----------------------------------------------------------------------
    // FOOTER
    // -----------------------------------------------------------------------
    // Drawn into the bottom-margin band on whichever page the cursor ended on.
    // pdfkit auto-paginates when text() is called past the bottom margin, so
    // we drop the bottom margin to 0 around the footer block (otherwise the
    // footer triggers 1-2 phantom blank pages after the signature). We also
    // pass lineBreak:false for the same reason.
    const origBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = PAGE.height - 42;
    doc.moveTo(PAGE.margin, footerY - 8).lineTo(PAGE.width - PAGE.margin, footerY - 8)
       .strokeColor(NAVY).lineWidth(0.4).stroke();
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5)
       .text(`This community is professionally managed by ${BRAND.service.legal}.`,
             PAGE.margin, footerY - 2, { width: contentWidth, align: 'center', lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
       .text(`${BRAND.service.addressInline}  ·  ${BRAND.service.phone}  ·  ${BRAND.service.email}  ·  ${BRAND.service.website}`,
             PAGE.margin, footerY + 12, { width: contentWidth, align: 'center', lineBreak: false });
    doc.page.margins.bottom = origBottomMargin;

    doc.end();
  });
}

// ----------------------------------------------------------------------------
// LEGACY WRAPPER — single-violation callers. Translates the old single-shape
// ctx into the new bundle shape with a 1-element violations array.
// ----------------------------------------------------------------------------
async function renderViolationLetterPdf(ctx) {
  return renderViolationLetterBundlePdf({
    property: ctx.property,
    owner: ctx.owner,
    community: ctx.community,
    stage: (ctx.violation && ctx.violation.current_stage) || 'courtesy_1',
    letter_date: ctx.options && ctx.options.letter_date,
    wide_photo_buffer: ctx.wide_photo_buffer || null,
    community_logo_buffer: ctx.community_logo_buffer || null,
    violations: [{
      category_label: ctx.violation && ctx.violation.category_label,
      ai_description: ctx.observation && ctx.observation.ai_description,
      observation_captured_at: ctx.observation && ctx.observation.captured_at,
      governing_doc: ctx.governing_doc,
      prior_notices: Array.isArray(ctx.prior_violations)
        ? ctx.prior_violations.map((pv) => ({
            date: pv.opened_at,
            stage: pv.current_stage,
            delivery_method: pv.mail_type,
          }))
        : [],
      close_up_photo_buffer: ctx.photo_buffer || null,
      fine_amount: ctx.fine && ctx.fine.amount,
    }],
    options: ctx.options,
  });
}

module.exports = { renderViolationLetterPdf, renderViolationLetterBundlePdf };
