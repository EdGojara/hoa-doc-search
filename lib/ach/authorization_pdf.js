// ============================================================================
// lib/ach/authorization_pdf.js  (Ed 2026-09-16)
// ----------------------------------------------------------------------------
// Renders the signed ACH Authorization as a PDF: the retained record of the
// vendor's e-signature. Deterministic layout via pdfkit (already a dependency).
// This document is stored PRIVATELY (private bucket + a library_documents row)
// and is owner/admin gated — it contains full banking details on purpose,
// because it IS the authorization to pay that account.
// ============================================================================
const PDFDocument = require('pdfkit');

const NAVY = '#0B1D34';
const GOLD = '#C99A2E';
const INK = '#1a2230';
const MUTED = '#6b7a8d';

function fmtDateTime(d) {
  try {
    return new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'long', timeStyle: 'short' }) + ' Central';
  } catch (_) { return String(d || ''); }
}

/**
 * @param {object} r  vendor_ach_requests row (post-submission) + { community_name }
 * @returns {Promise<Buffer>}
 */
function renderAchAuthorizationPdf(r) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'LETTER', margin: 56, info: {
      Title: `ACH Authorization - ${r.vendor_name || ''}`,
      Author: 'Bedrock Association Management',
      Subject: 'Vendor ACH Payment Authorization',
    } });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    // Header
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text('Bedrock Association Management');
    doc.moveDown(0.1);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(11).text('VENDOR ACH PAYMENT AUTHORIZATION', { characterSpacing: 1 });
    doc.moveTo(left, doc.y + 6).lineTo(right, doc.y + 6).lineWidth(2).strokeColor(GOLD).stroke();
    doc.moveDown(1.2);

    const row = (label, value) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(String(label).toUpperCase(), { characterSpacing: 0.5 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(value || '—');
      doc.moveDown(0.6);
    };

    row('Vendor / Payee', r.vendor_name);
    if (r.community_name) row('On behalf of', r.community_name);
    doc.moveDown(0.2);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('Bank account for ACH payments');
    doc.moveDown(0.4);
    row('Account holder name', r.account_holder_name);
    row('Bank name', r.bank_name);
    row('Account type', r.account_type ? (r.account_type.charAt(0).toUpperCase() + r.account_type.slice(1)) : '');
    row('Routing number (ABA)', r.routing_number);
    row('Account number', r.account_number_full);

    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor('#d8d5cc').stroke();
    doc.moveDown(0.8);

    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('Authorization');
    doc.moveDown(0.4);
    doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(
      `I authorize Bedrock Association Management${r.community_name ? ', on behalf of ' + r.community_name + ',' : ''} to initiate electronic (ACH) payments to the bank account identified above, and to make corrections by electronic entry if needed. I certify that I am authorized to provide this banking information for ${r.vendor_name || 'the vendor'} and that the information is accurate. This authorization remains in effect until Bedrock receives written notice from me to cancel or change it, with reasonable time to act on it.`,
      { align: 'left', lineGap: 2 }
    );
    doc.moveDown(1);

    // Signature block
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('Electronic signature');
    doc.moveDown(0.4);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(r.signer_name || '');
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Signed electronically' + (r.signer_title ? ', ' + r.signer_title : ''));
    doc.moveDown(0.5);
    doc.fillColor(INK).font('Helvetica').fontSize(9.5)
      .text(`Signed: ${fmtDateTime(r.signed_at || r.submitted_at)}`)
      .text(`IP address: ${r.submitter_ip || 'n/a'}`)
      .text(`Device: ${(r.signer_user_agent || 'n/a').slice(0, 120)}`)
      .text(`Consent: the signer checked "I authorize" to sign electronically (E-SIGN Act).`);

    doc.moveDown(1.4);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text('Confidential. Retained in the association\'s records. Bedrock verifies these details by phone with the vendor before any payment is processed.', { align: 'left' });

    doc.end();
  });
}

module.exports = { renderAchAuthorizationPdf };
