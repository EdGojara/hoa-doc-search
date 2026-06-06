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
const { validateViolationLetterInput } = require('./violation_letter_validate');
const { resolveBlock: resolveCopyBlock } = require('./letter_copy');
const { refFromViolationId } = require('./case_ref');

const PAGE = { margin: 56, width: 612, height: 792 };
const NAVY  = '#0B1D34';
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
// Three-claim Authority Statement (rewritten 2026-06-07 per Ed's defensibility
// review). Three discrete assertions instead of one rambly sentence:
//
//   1. Bedrock is acting as managing agent under Board direction
//   2. Owners are under a substantive obligation per the Declaration
//   3. The Association has authority to enforce that obligation per
//      the Declaration's enforcement provisions
//
// For certified_209 + fine_assessed, appends the §209.006 written-notice
// satisfaction clause and the §209.0064 fine-schedule reference.
//
// Citations:
//   substantiveCitation  — typically Article 7 (maintenance), Article 8 (trash),
//                          Article 9 (ARC), etc. PER-VIOLATION; passed only for
//                          single-violation letters (bundles use the generic
//                          formulation since they cover multiple substantive
//                          provisions each already cited in the body).
//   enforcementCitation  — typically Article 11 / Article XV / etc. PER-COMMUNITY,
//                          stored on communities.enforcement_authority_citation.
//                          Should be populated for every active community for
//                          maximum defensibility; the generic fallback works but
//                          is less specific.
// Transform a CC&R obligation quote into a form that reads naturally embedded
// inside "Pursuant to [citation], [transformed quote]." sentence.
//
// Common source patterns from CC&Rs:
//   "Each Owner shall keep..."   → "owners are required to keep..."
//   "Each Owner shall maintain..."→ "owners are required to maintain..."
//   "The Owner shall..."         → "owners are required to..."
//   "No Owner shall..."          → "owners are prohibited from..."ing
//   "An Owner shall..."          → "owners are required to..."
//
// Also fixes "the Lot" → "their Lot" so possessive context reads cleanly
// when the subject becomes "owners" (plural) instead of "Each Owner".
//
// Returns null if the quote doesn't start with a recognizable obligation
// pattern — caller falls back to generic claim.
function _transformObligationQuote(quote) {
  if (!quote || typeof quote !== 'string') return null;
  let q = quote.trim().replace(/\.+$/, '').replace(/\s+/g, ' ');
  if (q.length < 20) return null;

  // Prohibition patterns: "No Owner shall [VERB] [REST]" → drop "owners are prohibited from [VERB]ing [REST]"
  let m = q.match(/^No\s+(?:Lot\s+)?Owner\s+shall\s+(?:cause\s+to\s+be\s+|permit\s+|allow\s+)?(\w+)\s+(.+)$/i);
  if (m) {
    let verb = m[1].toLowerCase();
    // -ing form for embedded reading
    if (verb.endsWith('e')) verb = verb.slice(0, -1) + 'ing';
    else verb = verb + 'ing';
    return `owners are prohibited from ${verb} ${m[2]}`;
  }
  // Standard obligation: "Each Owner shall [VERB] [REST]" / "The Owner shall..." / "An Owner shall..." / "Owners shall..."
  m = q.match(/^(?:Each\s+Owner|The\s+Owner|An\s+Owner|Owners|Every\s+Owner)\s+shall\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    // Normalize possessives that assume singular subject
    rest = rest
      .replace(/\bhis\s+or\s+her\s+/gi, 'their ')
      .replace(/\bhis\/her\s+/gi, 'their ')
      .replace(/\bhis\s+/gi, 'their ')
      .replace(/\bher\s+/gi, 'their ');
    return `owners are required to ${rest}`;
  }
  // Direct "Owners are required to..." passes through with light cleanup
  if (/^owners\s+(?:are\s+required|must|shall)/i.test(q)) {
    return q.replace(/^owners\s+(must|shall)/i, 'owners are required to').replace(/^owners\s+are\s+required\s+to\s+/i, 'owners are required to ');
  }
  // No recognized pattern — caller falls back to generic
  return null;
}

function buildAuthorityStatement(stage, hoaName, enforcementCitation, substantiveCitation, isMulti, substantiveQuote) {
  const enf = (enforcementCitation || '').trim();
  const sub = (substantiveCitation || '').trim();
  const lawyerLegal = BRAND.service.legal;

  // CLAIM 1 — Bedrock as managing agent under Board direction
  const claim1 = `Authority: This notice is issued by ${lawyerLegal}, as managing agent for ${hoaName}, acting at the direction of the Board of Directors.`;

  // CLAIM 2 — Substantive obligation. Use the specific citation + the actual
  // obligation language from the cited section when available on single-
  // violation letters. Multi-violation bundles use the generic formulation
  // because multiple substantive provisions are in play (each cited in its
  // own block above in the body).
  let claim2;
  const transformed = !isMulti ? _transformObligationQuote(substantiveQuote) : null;
  if (sub && transformed) {
    // Best case: specific citation + actual obligation language from CC&R
    claim2 = `Pursuant to ${sub} of the Declaration of Covenants, Conditions and Restrictions, ${transformed}.`;
  } else if (sub && !isMulti) {
    // Specific citation but no clean obligation quote — keep generic scope
    claim2 = `Pursuant to ${sub} of the Declaration of Covenants, Conditions and Restrictions, owners are required to maintain their Lot, including all landscaping and improvements thereon, in compliance with the community's covenants and standards.`;
  } else {
    // Bundle or no specific citation — generic claim
    claim2 = `Pursuant to the provisions of the Declaration of Covenants, Conditions and Restrictions governing owner obligations, owners are required to maintain their Lot, including all landscaping and improvements thereon, in compliance with the community's covenants and standards.`;
  }

  // CLAIM 3 — Enforcement authority. Specific citation when known; generic
  // defensible fallback otherwise. Always mentions "and applicable Rules and
  // Regulations" so the scope covers both the Declaration AND any separate
  // Rules and Regulations document (which most communities have).
  const claim3 = enf
    ? `Pursuant to ${enf} of the Declaration, the Association is authorized to enforce compliance with the Declaration and applicable Rules and Regulations by any lawful means available.`
    : `Pursuant to the provisions of the Declaration governing the Association's enforcement powers and remedies, the Association is authorized to enforce compliance with the Declaration and applicable Rules and Regulations by any lawful means available.`;

  // CLAIM 4 — Bedrock's delegated authority to issue the notice
  const claim4 = `${lawyerLegal} is authorized to administer and issue compliance notices on behalf of the Association.`;

  let txt = `${claim1} ${claim2} ${claim3} ${claim4}`;

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
  // Fail loud on bad input — catastrophic-output discipline (see CLAUDE.md).
  // Letters that ship with bad data create §209 challenges and end up in court.
  // Better to throw here than to render an unenforceable notice.
  const validation = validateViolationLetterInput(ctx);
  if (!validation.ok) {
    const err = new Error(
      'violation_letter input failed validation:\n  - ' + validation.errors.join('\n  - ')
    );
    err.code = 'VIOLATION_LETTER_VALIDATION_FAILED';
    err.validationErrors = validation.errors;
    throw err;
  }

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

  // Editable copy resolution. ctx.copy_overrides is the per-community map for
  // this stage (caller fetches via letter_copy.loadOverrides). Each block
  // resolves to override-or-default with {{placeholders}} applied.
  const copyOverrides = ctx.copy_overrides || {};
  const firstViolation = violations[0] || {};
  const propAddrLine = [p.street_address, p.unit ? '#' + p.unit : null].filter(Boolean).join(' ');
  const copyCtx = {
    community_name:       c.name || '',
    community_legal_name: hoaName,
    cure_days:            cureDays,
    cure_by_date:         fmtLongDate(cureBy),
    property_address:     propAddrLine,
    category_label:       firstViolation.category_label || '',
    phone:                BRAND.service.phone || '',
    email:                'violations@bedrocktx.com',
    owner_salutation:     buildSalutation(o.full_name),
    sender_name:          senderName,
    sender_title:         senderTitle,
  };
  const title = resolveCopyBlock(copyOverrides, stage, 'title', copyCtx);
  const openingParagraph = resolveCopyBlock(copyOverrides, stage, 'opening_paragraph', copyCtx);
  const closingParagraph = resolveCopyBlock(copyOverrides, stage, 'closing_paragraph', copyCtx);
  const signatureBlock = resolveCopyBlock(copyOverrides, stage, 'signature_block', copyCtx);
  const footerNote = resolveCopyBlock(copyOverrides, stage, 'footer_note', copyCtx);

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
    // Bedrock cornerstone mark — uses the canonical brand PNG (2026-05-31
    // refresh) instead of the legacy inline 3-trapezoid path. Lives at
    // public/brand-assets/bedrock-mark-email-2x.png — same single source
    // of truth as every other branded surface. If the file is missing
    // (shouldn't happen in production) we silently skip — letter still
    // renders cleanly, just without the mark on the top right.
    const csW = 24, csH = 30;
    const csX = PAGE.width - PAGE.margin - csW;
    const csY = y + 2;
    try {
      const _markPath = require('path').join(__dirname, '..', '..', 'public', 'brand-assets', 'bedrock-mark-email-2x.png');
      doc.image(_markPath, csX, csY, { fit: [csW, csH], align: 'right', valign: 'top' });
    } catch (e) {
      console.warn('[letter] cornerstone mark embed failed:', e.message);
    }

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
    // Case reference — short code derived from violation UUID. Lets the
    // homeowner quote it when they reply ("re: Case V-A7F4-B2") so the
    // email intake can auto-attach the reply to this violation. For
    // bundles, stamp every member's case ref so the operator can find any
    // of them from a quoted reply.
    const caseRefs = violations
      .map(v => refFromViolationId(v.violation_id))
      .filter(Boolean);
    const caseRefLine = caseRefs.length === 1
      ? `Case ${caseRefs[0]}`
      : caseRefs.length > 1
      ? `Cases ${caseRefs.join(', ')}`
      : '';
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
       .text(`Reference: ${propRefLine}${caseRefLine ? '  ·  ' + caseRefLine : ''}`, PAGE.margin, y, { width: contentWidth, align: 'center' });
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
      // Preamble that introduces the violation INSIDE the same paragraph
      // (the bold violation phrase is appended in the violation loop below).
      // Rewritten 2026-06-07 per Ed's review: dropped the "Community
      // Associations, like the one in which you live, have the
      // responsibility of maintaining harmony" boilerplate. Replaced with
      // a sentence that ties directly into the Authority Statement theme —
      // the Association is administering/enforcing on behalf of owners, not
      // a generic "harmony" appeal that reads like a form letter.
      opening = `The Association is responsible for administering and enforcing the community's governing documents for the benefit of all owners and to help preserve the appearance and value of the community. A recent inspection on ${inspectionDateStr} found that the condition of certain things at your property do not meet the standards set forth in the Declaration of Covenants, Conditions and Restrictions and/or Rules and Regulations for your Association. Specifically, the following ${isMulti ? 'have' : 'has'} been found to be out of compliance:`;
    } else if (isSecond) {
      // Courtesy 2 — drops the mission-statement preamble (kept on C1 for
      // warmth) in favor of starting directly with the inspection finding.
      // C2's job is to register "this is still here" with a firmer posture.
      // The mission line on C1 sets up the Authority Statement; on C2 it
      // would soften an escalation that should feel firmer.
      opening = `A follow-up inspection conducted on ${inspectionDateStr} found that the condition${isMulti ? 's' : ''} previously identified at your property ${isMulti ? 'remain' : 'remains'} unresolved and may be inconsistent with the Declaration of Covenants, Conditions and Restrictions and/or Rules and Regulations for your Association. Specifically, the following ${isMulti ? 'continue' : 'continues'} to be out of compliance:`;
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
    // AUTHORITY STATEMENT — courtesy stages read warmer when this lives at
    // the BOTTOM (just above the footer) as a small disclosure. Certified
    // stages keep it up here next to the opening so legal posture is
    // unambiguous from the first read.
    // -----------------------------------------------------------------------
    // Substantive citation + obligation quote are the first violation's
    // governing-doc lookup result. Only used on single-violation letters —
    // bundles use the generic formulation since multiple substantive
    // provisions are in play (each cited in its own block above).
    const _firstGoverning = (violations[0] && violations[0].governing_doc) || null;
    const _substantiveCitation = _firstGoverning && _firstGoverning.reference;
    const _substantiveQuote = _firstGoverning && _firstGoverning.quote;
    const authorityText = buildAuthorityStatement(
      stage,
      hoaName,
      c.enforcement_authority_citation,
      _substantiveCitation,
      isMulti,
      _substantiveQuote
    );
    if (!isFirstCo && !isSecond) {
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9)
         .text(authorityText, PAGE.margin, y, { width: contentWidth, align: 'left', lineGap: 1.5 });
      y = doc.y + 14;
      doc.fillColor(INK).font('Helvetica').fontSize(11);  // reset back to body style
    }

    // -----------------------------------------------------------------------
    // WIDE-SHOT — property identification (the wrong-house insurance).
    // Skipped on courtesy stages — defensive documentation matters at §209
    // + fine stages, not the soft asks. Saves a page of vertical real estate.
    // -----------------------------------------------------------------------
    if (ctx.wide_photo_buffer && !isFirstCo && !isSecond) {
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
    // ----------------------------------------------------------------------
    // Courtesy 1 uses INLINE NARRATIVE layout: bold category title, then a
    // description-and-rule paragraph that weaves the CC&R citation into the
    // sentence ("Per Article VII, Section 7.3 of the Declaration..."). Mirrors
    // the existing Bedrock courtesy letter voice.
    //
    // Courtesy 2 / §209 / fine use the structured layout — item bar header,
    // separated description / governing doc / quote blocks — because legal
    // posture matters more at those stages than warmth.
    // -----------------------------------------------------------------------
    for (let i = 0; i < violations.length; i++) {
      const v = violations[i];
      if (y > PAGE.height - 260) { doc.addPage(); y = PAGE.margin; }

      if (isFirstCo || isSecond) {
        // ---- Inline narrative format (courtesy 1 + courtesy 2) ----
        const catLabel = v.category_label || 'Covenant violation';
        // Bold category as its own line — easier to scan than buried in a paragraph
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5)
           .text(`${isMulti ? (i + 1) + '. ' : ''}${catLabel}`, PAGE.margin, y);
        y = doc.y + 4;

        // Description sentence
        if (v.ai_description) {
          doc.fillColor(INK).font('Helvetica').fontSize(11)
             .text(v.ai_description, PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
          y = doc.y + 6;
        }

        // Inline citation — woven into the body text, NOT a separate block.
        // The AI-extracted shape is { reference: "Section 4(c)", document_title:
        // "Declaration of...", quote: "..." }. Reference is the bare section
        // number; we compose the "of the [document]" wrapper here. Falls
        // back gracefully when only one piece is present.
        if (v.governing_doc && v.governing_doc.reference) {
          const ref = v.governing_doc.reference.replace(/^the\s+/i, '').trim();
          const docName = (v.governing_doc.document_title || '').trim();
          // If AI gave us both, render "Per Section X of the Declaration".
          // If the reference already CONTAINS the doc kind (older format),
          // render as-is. If we have only the reference, end the phrase short.
          let fullCitation;
          if (docName && !/declaration|bylaws|rules|guidelines|covenants/i.test(ref)) {
            fullCitation = `${ref} of the ${docName}`;
          } else {
            fullCitation = ref;
          }
          const lead = `Per ${fullCitation.charAt(0).toLowerCase() + fullCitation.slice(1)},`;
          if (v.governing_doc.quote) {
            const quote = v.governing_doc.quote.replace(/^["']|["']$/g, '').trim();
            doc.fillColor(INK).font('Helvetica').fontSize(11)
               .text(`${lead} ${quote.charAt(0).toLowerCase() + quote.slice(1)}`,
                     PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
          } else {
            doc.fillColor(INK).font('Helvetica').fontSize(11)
               .text(`${lead} owners are responsible for maintaining their property in compliance with the community's covenant standards.`,
                     PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
          }
          y = doc.y + 8;
        }

        // Close-up photo — placed under the narrative
        if (v.close_up_photo_buffer) {
          try {
            if (y > PAGE.height - 220) { doc.addPage(); y = PAGE.margin; }
            const imgY = y;
            doc.image(v.close_up_photo_buffer, PAGE.margin, imgY, { fit: [contentWidth, 180], align: 'left' });
            y = imgY + 180 + 4;
            if (v.observation_captured_at) {
              doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
                 .text(`Photographed ${fmtShortDate(v.observation_captured_at)}.`, PAGE.margin, y);
              y = doc.y + 12;
            }
          } catch (e) {
            console.warn('[letter] close-up photo embed failed:', e.message);
          }
        }
        y += 6;
        continue; // skip the structured-layout blocks below
      }

      // ---- Structured layout (courtesy 2, certified, fine) ----
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

    if (isFirstCo) {
      // Soft ask — editable opening + closing paragraphs. Default copy
      // mirrors the historical Bedrock courtesy voice ("We're sure that
      // this was just an oversight..."). Per-community overrides via
      // letter_copy_overrides table — placeholders already resolved.
      doc.fillColor(INK).font('Helvetica').fontSize(11)
         .text(openingParagraph,
               PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
      y = doc.y + 10;
      doc.fillColor(INK).font('Helvetica').fontSize(11)
         .text(closingParagraph,
               PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
      y = doc.y + 10;
    } else if (isSecond) {
      // Courtesy 2 — narrative cure paragraph with a HARD DATE inlined
      // (Ed's addition; Vantaca itself keeps Second Notice soft). Opening
      // + closing are editable; the legal escalation warning and "in error"
      // path stay code-driven so they always cite §209 correctly.
      doc.fillColor(INK).font('Helvetica').fontSize(11)
         .text(openingParagraph,
               PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
      y = doc.y + 10;
      doc.fillColor(INK).font('Helvetica').fontSize(11)
         .text(closingParagraph,
               PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
      y = doc.y + 10;
      doc.fillColor(INK).font('Helvetica').fontSize(11)
         .text(`If you believe this letter was sent in error and you are in compliance with the above-cited provisions, please email violations@bedrocktx.com with details so we can review and close out the matter.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
      y = doc.y + 10;
      doc.fillColor(INK).font('Helvetica').fontSize(11)
         .text(`We appreciate your cooperation in correcting this matter as quickly as possible.`,
               PAGE.margin, y, { width: contentWidth, lineGap: 2.5 });
      y = doc.y + 10;
    } else if (!isFine) {
      // Courtesy stages: "correct" reads less attorney-speak than "cure" /
      // "remedy." Certified+ stages keep "remedy" since they're tracking
      // statutory framework. Plus the labels swap to action verbs the
      // homeowner actually uses day-to-day.
      const isCourtesyStage = isFirstCo || isSecond;
      const dateLabel = isCourtesyStage
        ? (isMulti ? 'Please correct all items above on or before:' : 'Please correct on or before:')
        : (isMulti ? 'Please remedy all items above by:' : 'Please remedy by:');
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5)
         .text(dateLabel, PAGE.margin, y);
      y = doc.y + 4;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14)
         .text(fmtLongDate(cureBy), PAGE.margin, y);
      y = doc.y + 8;

      if (isSecond) {
        // Per Ed's review (2026-06-07): trim Courtesy 2's escalation warning.
        // The previous version enumerated 'preserves the Association's right
        // to assess fines and recover attorney fees and costs' which reads
        // as a threat — those consequences belong in the certified §209
        // notice itself, not previewed here. Just signal the next step.
        doc.fillColor(INK).font('Helvetica').fontSize(10.5)
           .text(`If the condition${isMulti ? 's remain' : ' remains'} unresolved after that date, the Association may proceed with the next step in the enforcement process, which includes issuance of a certified notice in accordance with Texas Property Code Chapter 209. That notice will provide additional information regarding the Association's enforcement rights and your opportunity to respond. Please contact our office at ${BRAND.service.phone} if circumstances are preventing the correction.`,
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

    // Courtesy 2 fee heads-up: softer language per Ed's review (2026-06-07).
    // Avoids anchoring on a specific dollar amount before the certified
    // notice (the certified letter itself states the specific fee per
    // §209.005(b)(1)). Reads less threatening than the prior "$35 will be
    // assessed" anchor while still putting the homeowner on notice that
    // escalation has a cost.
    const cert209FeeCents = Number(c.letter_fee_certified_209_cents || 3500);
    if (isSecond && cert209FeeCents > 0) {
      if (y > PAGE.height - 100) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9.5)
         .text(`Additional administrative charges may be assessed in accordance with the Association's governing documents and adopted enforcement policies if a certified notice becomes necessary.`,
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
    // SIGN-OFF — editable signature_block (per-community per-stage override).
    // Default copy renders the historical structure (sign-off word, blank
    // line, sender name, sender title, "Issued by Bedrock as managing
    // agent"). Communities can rewrite the whole block via the Letter
    // format editor — multi-line plain text, no bold formatting in
    // overridden mode.
    // -----------------------------------------------------------------------
    if (y > PAGE.height - 130) { doc.addPage(); y = PAGE.margin; }
    const sigLines = (signatureBlock || '').split(/\r?\n/);
    doc.fillColor(INK).font('Helvetica').fontSize(11);
    for (let i = 0; i < sigLines.length; i++) {
      const line = sigLines[i];
      if (line.trim() === '') {
        // blank line → spacer for sign-off → signature gap
        y += i === 1 ? 22 : 6;
        continue;
      }
      // Preserve historical visual hierarchy for the DEFAULT signature only:
      //   • line 2 (sender name) bold
      //   • line 3 (sender title) muted
      // Override mode renders flat — operator chooses the structure.
      const isDefault = (signatureBlock === resolveCopyBlock({}, stage, 'signature_block', copyCtx));
      if (isDefault && i === 2) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
      } else if (isDefault && i === 3) {
        doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      } else if (isDefault && i === 4) {
        doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      } else {
        doc.font('Helvetica').fontSize(11).fillColor(INK);
      }
      doc.text(line, PAGE.margin, y, { width: contentWidth });
      y = doc.y + 2;
    }
    y += 6;

    // Per-community optional footer note — sits just below the signature
    // and above the "Authority" / page footer. Empty by default. Rendered
    // muted-small so it doesn't compete with the body copy.
    if (footerNote && footerNote.trim()) {
      if (y > PAGE.height - 110) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
         .text(footerNote, PAGE.margin, y, { width: contentWidth, lineGap: 2 });
      y = doc.y + 6;
    }

    // Courtesy stages: authority statement lives at the bottom of the body,
    // just above the page footer — keeps the warm tone in the body and the
    // defensible posture in the disclosure footer.
    if (isFirstCo || isSecond) {
      if (y > PAGE.height - 110) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5)
         .text(authorityText, PAGE.margin, y, { width: contentWidth, align: 'left', lineGap: 1.5 });
      y = doc.y + 6;
    }

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
      violation_id: ctx.violation && ctx.violation.id,
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
    copy_overrides: ctx.copy_overrides,
    options: ctx.options,
  });
}

module.exports = { renderViolationLetterPdf, renderViolationLetterBundlePdf };
