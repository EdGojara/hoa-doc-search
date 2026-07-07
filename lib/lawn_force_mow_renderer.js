// ============================================================================
// lawn_force_mow_renderer.js — 10-day certified force-mow letter PDF
// ----------------------------------------------------------------------------
// Per CLAUDE.md catastrophic-output discipline:
//   Schema:   templates/lawn-force-mow-letter.schema.json
//   Template: templates/lawn-force-mow-letter.gold-standard.md
//   Statute:  lib/global_rules.js (TX §209.006-007, §209.006(b)(1), SCRA)
//
// One render pipeline. Validated input → fixed-format PDF. The Association is
// the principal; Bedrock is the managing agent — that legal posture appears
// in the signature block and footer.
//
// Render flow:
//   1. validateInput(data)   — JSON-schema validate against the schema file
//   2. renderForceMowLetterPdf(data) — produces a Buffer; caller decides what
//      to do with it (return as HTTP response, upload to storage, etc.)
//
// The renderer never freestyles statutory wording. Every legal paragraph
// comes from GLOBAL_RULES via injectGlobalRule(). The template structure
// itself (the hybrid Eaglewood/Waterview format) is fixed in this file —
// attorney-reviewed.
// ============================================================================

const PDFDocument = require('pdfkit');
const schema = require('../templates/lawn-force-mow-letter.schema.json');
const { injectGlobalRule, GLOBAL_RULES_VERSION } = require('./global_rules');

const PAGE = { margin: 56, width: 612, height: 792 };
const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const INK = '#1a1a1a';
const MUTED = '#5a5a5a';
const RED = '#b91c1c';

// ----------------------------------------------------------------------------
// Remedy modes — the SAME self-help letter (Declaration self-help authority +
// identical §209 scaffolding) with the remedy-description lines swapped. Only
// these non-statutory descriptive strings differ between a lawn force-mow and a
// general lot cleanup/abatement; every statutory paragraph (hearing rights,
// fee disclosure, civil damages, SCRA, cure period, self-help authority
// citation) is identical and injected from GLOBAL_RULES. 'lawn' is the default
// so existing callers are unchanged.
// ----------------------------------------------------------------------------
const REMEDY_COPY = {
  lawn: {
    re: 'Notice of Violation and Intent to Enter Property to Maintain the Yard',
    intro_action: 'to provide mowing services',
    violation_desc: 'Failure to keep the Lot in good condition, including the failure to mow the lawn.',
    services: 'Mowing and Yard Maintenance',
    reserve_sentence: 'and the Association reserves the right to continue to provide such self-help maintenance on a regular schedule without further notice if this violation continues.',
  },
  cleanup: {
    re: 'Notice of Violation and Intent to Enter Property to Abate and Clean the Lot',
    intro_action: 'to perform cleanup and abatement of the Lot',
    violation_desc: 'Failure to keep the Lot in good condition, including the accumulation of trash, debris, and unsightly materials in violation of the Declaration.',
    services: 'Property Cleanup and Debris Removal',
    reserve_sentence: 'and the Association reserves the right to take further self-help action to abate the condition without further notice if this violation continues or recurs.',
  },
};
function remedyCopy(mode) { return REMEDY_COPY[mode] || REMEDY_COPY.lawn; }

// Hand-rolled validation against the schema. Avoids adding ajv as a dep
// just for this one schema. Checks: required fields present, string fields
// non-empty, date fields YYYY-MM-DD, dollar fields '$X.XX', booleans typed.
function validateInput(data) {
  const errors = [];
  const required = schema.required || [];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      errors.push({ instancePath: '/' + field, message: 'is required' });
    }
  }
  for (const [field, def] of Object.entries(schema.properties || {})) {
    const value = data[field];
    if (value == null) continue;
    if (def.type === 'string' || (Array.isArray(def.type) && def.type.includes('string'))) {
      if (typeof value !== 'string') {
        errors.push({ instancePath: '/' + field, message: `must be string, got ${typeof value}` });
      } else if (def.minLength && value.length < def.minLength) {
        errors.push({ instancePath: '/' + field, message: `must be at least ${def.minLength} characters` });
      } else if (def.pattern && !new RegExp(def.pattern).test(value)) {
        errors.push({ instancePath: '/' + field, message: `must match pattern ${def.pattern}` });
      }
    }
    if (def.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ instancePath: '/' + field, message: `must be boolean, got ${typeof value}` });
    }
  }
  const result = errors.length === 0;
  validateInput.errors = errors;
  return result;
}

// ----------------------------------------------------------------------------
// Date formatters
// ----------------------------------------------------------------------------
function fmtLongDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  // Parse YYYY-MM-DD as a calendar date (not UTC) so it doesn't shift by tz
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ----------------------------------------------------------------------------
// Main renderer
// ----------------------------------------------------------------------------
function renderForceMowLetterPdf(data) {
  // Validation gate — schema catches typed/missing fields
  if (!validateInput(data)) {
    const errs = (validateInput.errors || []).map((e) => `${e.instancePath || '(root)'}: ${e.message}`).join('; ');
    const err = new Error(`Force-mow letter validation failed: ${errs}`);
    err.code = 'SCHEMA_VALIDATION_FAILED';
    err.details = validateInput.errors;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      bufferPages: true,
    });
    const { installDemoWatermark } = require('./pdf/demo_watermark');
    installDemoWatermark(doc, { community: data?.community || null });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ------------------------------------------------------------------
    // 1. Letterhead — community name primary, Bedrock as agent
    // ------------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY)
      .text(data.community_legal_name, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('c/o Bedrock Association Management, LLC', { align: 'center' })
      .text('12808 W. Airport Boulevard #253, Sugar Land, Texas 77478', { align: 'center' })
      .text('(832) 588-2485 · info@bedrocktx.com', { align: 'center' });

    doc.moveDown(2);

    // ------------------------------------------------------------------
    // 2. Title block
    // ------------------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY)
      .text('NOTICE OF INTENT TO ENTER PROPERTY', { align: 'center' })
      .text('AND NOTICE OF VIOLATION', { align: 'center' });

    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(RED)
      .text('VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED', { align: 'center' })
      .text('AND FIRST CLASS MAIL', { align: 'center' });

    if (data.certified_mail_number) {
      doc.font('Helvetica').fontSize(9).fillColor(INK)
        .text(`Certified Mail No.: ${data.certified_mail_number}`, { align: 'center' });
    }

    doc.moveDown(1.5);

    // ------------------------------------------------------------------
    // 3. Letter date
    // ------------------------------------------------------------------
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(fmtLongDate(data.letter_date));

    doc.moveDown(1);

    // ------------------------------------------------------------------
    // 4. Recipient address block
    // ------------------------------------------------------------------
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(data.homeowner_names_block);

    if (data.alt_mailing_address_block) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(MUTED)
        .text('Alternative mailing address:')
        .text(data.alt_mailing_address_block);
    }

    doc.moveDown(1);

    // ------------------------------------------------------------------
    // 5. Re/Property/Community/Declaration block
    // ------------------------------------------------------------------
    const refLine = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(label + ' ', { continued: true });
      doc.font('Helvetica').fillColor(INK).text(value);
    };
    const rc = remedyCopy(data.remedy_mode);
    refLine('Re:', rc.re);
    refLine('Property:', `${data.property_address_full} (the "Property")`);
    refLine('Community:', `${data.community_legal_name} (the "Association")`);
    refLine(
      'Declaration:',
      `Declaration of Covenants, Conditions, and Restrictions for ${data.community_short_name}, recorded as Document No. ${data.declaration_doc_number}, Official Public Records of ${data.declaration_county} County, Texas (the "Declaration")`,
    );

    doc.moveDown(1.2);

    // ------------------------------------------------------------------
    // 6. Body — notice of intent + violation
    // ------------------------------------------------------------------
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text('Dear Homeowner:');
    doc.moveDown(0.6);

    doc.text(
      `The Association provides this letter as the formal notice of intent to enter the Property ${rc.intro_action} and as your notice of violation of restrictive covenants. Please be advised that, on ${fmtLongDate(data.observation_date)}, it was observed that conditions on the Property constitute violations of the terms and provisions of the Declaration. The Property is subject to and encumbered by the Declaration.`,
      { align: 'justify' },
    );
    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').text('Violation: ', { continued: true });
    doc.font('Helvetica').text(`${data.declaration_section_full} — ${rc.violation_desc}`);
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').text('Observed condition: ', { continued: true });
    doc.font('Helvetica').text(data.observed_condition);
    doc.moveDown(0.8);

    doc.font('Helvetica').text(
      'You are entitled to a reasonable period to cure the Violation. The Association requests that you bring the Property into compliance with the Declaration and cure the Violation ',
      { continued: true },
    );
    doc.font('Helvetica-Bold').text('within ten (10) days of the date of this letter.', { continued: false });
    doc.moveDown(0.6);

    doc.font('Helvetica').text(
      `This letter is further provided as formal written notice that the Association intends to exercise its right of self-help to enter the Property under ${data.declaration_section_full} and hire a contractor to bring the Property into compliance. The expense associated therewith will constitute an Assessment in accordance with the Declaration, `,
      { continued: true, align: 'justify' },
    );
    doc.font('Helvetica-Bold').text(
      rc.reserve_sentence,
      { continued: false },
    );
    doc.moveDown(1);

    // ------------------------------------------------------------------
    // 7. Contractor/Services/Date/Cost block
    // ------------------------------------------------------------------
    const startY = doc.y;
    doc.rect(PAGE.margin, startY, PAGE.width - PAGE.margin * 2, 70).strokeColor('#d0d7de').stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY)
      .text('CONTRACTOR:', PAGE.margin + 10, startY + 8);
    doc.font('Helvetica').fillColor(INK).text('________________________', PAGE.margin + 100, startY + 8);

    doc.font('Helvetica-Bold').fillColor(NAVY)
      .text('SERVICES:', PAGE.margin + 10, startY + 24);
    doc.font('Helvetica').fillColor(INK).text(rc.services, PAGE.margin + 100, startY + 24);

    doc.font('Helvetica-Bold').fillColor(NAVY)
      .text('DATE OF SERVICE:', PAGE.margin + 10, startY + 40);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text('[No earlier than 10 days from date of letter]', PAGE.margin + 100, startY + 41);
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text('______________________________', PAGE.margin + 100, startY + 50);

    doc.font('Helvetica-Bold').fillColor(NAVY)
      .text('COST:', PAGE.margin + 350, startY + 8);
    doc.font('Helvetica').fillColor(INK).text('$________________', PAGE.margin + 380, startY + 8);

    doc.y = startY + 80;
    doc.moveDown(0.6);

    // ------------------------------------------------------------------
    // 8. Civil-damages disclosure — GLOBAL_RULES injection
    // ------------------------------------------------------------------
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(injectGlobalRule('tx_force_mow_civil_damages'), { align: 'justify' });
    doc.moveDown(0.6);

    doc.text('We sincerely solicit your cooperation and thank you for your compliance so that we do not have to pursue a lawsuit against you.', { align: 'justify' });
    doc.moveDown(0.8);

    // ------------------------------------------------------------------
    // 9. §209 hearing rights — CONDITIONAL
    // Only when no prior notice for the same violation in the past 6 months
    // ------------------------------------------------------------------
    if (data.include_hearing_rights) {
      doc.text(injectGlobalRule('tx_209_hearing_rights_conditional'), { align: 'justify' });
      doc.moveDown(0.8);
    }

    // ------------------------------------------------------------------
    // 10. §209.006(b)(1) admin fee disclosure
    // ------------------------------------------------------------------
    doc.text(
      injectGlobalRule('tx_209_admin_fee_disclosure', { admin_fee_amount: data.admin_fee_amount }),
      { align: 'justify' },
    );
    doc.moveDown(0.8);

    // ------------------------------------------------------------------
    // 11. Friendly closing — Waterview's "if already corrected, contact us"
    // ------------------------------------------------------------------
    doc.text(
      `If the violation has already been corrected or there are any extenuating circumstances, please contact ${data.community_legal_name} c/o Bedrock Association Management, LLC at (832) 588-2485 or email us at info@bedrocktx.com.`,
      { align: 'justify' },
    );
    doc.moveDown(0.6);

    doc.text(
      'Your immediate attention to this matter is required. This notice is not intended to advise you of your legal rights or obligations. You should consult an attorney of your choice to protect your interests. Please let us know immediately if you have or will retain the services of legal counsel in this matter.',
      { align: 'justify' },
    );
    doc.moveDown(0.6);

    // ------------------------------------------------------------------
    // 12. SCRA disclosure
    // ------------------------------------------------------------------
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(MUTED)
      .text(injectGlobalRule('servicemembers_relief_act'), { align: 'justify' });
    doc.moveDown(1.2);

    // ------------------------------------------------------------------
    // 13. Signature block — Association is the principal
    // ------------------------------------------------------------------
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text('Sincerely,');
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
      .text(data.community_legal_name);
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text('Board of Directors');
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
      .text('c/o Bedrock Association Management, LLC');

    // ------------------------------------------------------------------
    // 14. Footer — version stamp for audit
    // ------------------------------------------------------------------
    const pageRange = doc.bufferedPageRange();
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7).fillColor(MUTED)
        .text(
          `This community is professionally managed by Bedrock Association Management, LLC · GLOBAL_RULES v${GLOBAL_RULES_VERSION} · Page ${i + 1 - pageRange.start} of ${pageRange.count}`,
          PAGE.margin,
          PAGE.height - PAGE.margin / 2,
          { width: PAGE.width - PAGE.margin * 2, align: 'center' },
        );
    }

    doc.end();
  });
}

module.exports = {
  renderForceMowLetterPdf,
  validateInput,
};
