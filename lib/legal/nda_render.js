// ============================================================================
// lib/legal/nda_render.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// The Bedrock MUTUAL NDA — the master template lives in the Legal Disclosures
// store (legal_documents, slug 'mutual-nda') so it's versioned + editable, and
// this module fills a counterparty's details into that text and renders a
// signable, Bedrock-branded PDF (with signature blocks) to send out.
//
// Why mutual: Bedrock shares trustEd platform internals with banks, insurers,
// media, and integration partners; those counterparties expect a mutual NDA and
// will sign it without sending back their own paper. It still fully protects
// Bedrock's confidential platform information as a disclosing party, and adds a
// no-reverse-engineering clause aimed squarely at the platform internals.
//
// NOT LEGAL ADVICE — a strong, standard Texas mutual NDA to be reviewed by
// counsel before first use. Record ownership: a Bedrock corporate workpaper.
// ============================================================================

const BRAND = require('../brand');

const NDA_SLUG = 'mutual-nda';
const NDA_TITLE = 'Mutual Non-Disclosure Agreement';

// The editable master. {{PLACEHOLDERS}} are filled at generation time; left as-is
// they read as blanks a person could complete by hand. Section headings use ##
// so the Legal Disclosures reader renders it too.
const NDA_TEMPLATE_MD = `## Mutual Non-Disclosure Agreement

This Mutual Non-Disclosure Agreement (this "Agreement") is entered into as of {{EFFECTIVE_DATE}} (the "Effective Date") by and between **Bedrock Association Management, LLC**, a Texas limited liability company, on behalf of itself and its affiliates and with respect to its trustEd platform ("Bedrock"), and **{{COUNTERPARTY}}** ("Counterparty"). Bedrock and Counterparty are each a "Party" and together the "Parties." Each Party may act as a discloser of its Confidential Information (a "Discloser") and as a recipient of the other Party's Confidential Information (a "Recipient").

## 1. Purpose

The Parties wish to explore a potential business relationship (the "Purpose"), and in connection with the Purpose each Party may disclose to the other certain confidential and proprietary information. Bedrock in particular may demonstrate and disclose non-public information about its trustEd platform, including its software, screens, architecture, data models, methods, and operations.

## 2. Confidential Information

"Confidential Information" means any non-public information disclosed by a Discloser to a Recipient, in any form (written, oral, visual, electronic, or by access to systems or demonstrations), that is designated as confidential or that a reasonable person would understand to be confidential given its nature or the circumstances of disclosure, including information learned, observed, inferred, or derived from a demonstration of or access to the Discloser's systems. It includes, without limitation: software, source and object code, user interfaces and screens, system and data architecture, database schemas, algorithms, models, know-how, processes and methods of operation, product roadmaps, security practices, pricing and financial information, business and marketing plans, customer, homeowner, association, and vendor information, and the existence and terms of this Agreement and of the discussions between the Parties.

## 3. Exclusions

Confidential Information does not include information that the Recipient can demonstrate: (a) was rightfully known to it without restriction before disclosure; (b) is or becomes publicly available through no act or omission of the Recipient; (c) is rightfully received from a third party without a duty of confidentiality; or (d) is independently developed by the Recipient without use of or reference to the Discloser's Confidential Information.

## 4. Obligations

The Recipient shall: (a) use the Discloser's Confidential Information solely for the Purpose; (b) protect it using at least the degree of care it uses for its own confidential information, and in no event less than a reasonable degree of care; (c) not disclose it to any third party except to the Recipient's employees, affiliates, and professional advisors who have a need to know it for the Purpose and who are bound by confidentiality obligations at least as protective as those in this Agreement (for whose compliance the Recipient remains responsible); and (d) not copy or reproduce it except as reasonably necessary for the Purpose.

## 5. Restricted Use; No Reverse Engineering

The Recipient shall not, and shall not permit any third party to, reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code, structure, or underlying ideas of any software, system, or platform disclosed or made accessible under this Agreement. The Recipient shall not use, or permit the use of, any Confidential Information to develop, improve, train, evaluate, benchmark, replicate, or assist in developing any product, service, feature, workflow, or functionality that competes with or substitutes for any product, service, feature, workflow, or functionality disclosed by the Discloser. The Recipient shall not use Confidential Information as training data, evaluation data, prompts, context, retrieval content, or other input to any artificial intelligence or machine learning system, except solely as necessary for the Purpose and in an environment that does not permit such Confidential Information to be used to train or improve any model available to a third party. The Recipient shall not photograph, screen-record, video-record, capture, scrape, or otherwise create a persistent reproduction of any demonstration, user interface, system, or platform made accessible by the Discloser, except with the Discloser's prior written consent. Nothing in this Section restricts the Recipient from independently developing products or services without use of or reference to the Discloser's Confidential Information.

## 6. No License; Ownership

All Confidential Information remains the property of the Discloser. Nothing in this Agreement grants the Recipient any license or right, by implication or otherwise, in or to the Discloser's Confidential Information or any patent, copyright, trademark, trade secret, or other intellectual property right, except the limited right to use it for the Purpose.

## 7. Compelled Disclosure

If the Recipient is required by law, regulation, or valid legal process to disclose Confidential Information, it may do so, provided that (to the extent legally permitted) it gives the Discloser prompt written notice and reasonable cooperation so the Discloser may seek a protective order, and discloses only the portion legally required.

## 8. Term and Survival

This Agreement begins on the Effective Date and continues for two (2) years, unless earlier terminated by either Party on thirty (30) days' written notice. The confidentiality obligations survive for three (3) years after disclosure of the applicable Confidential Information; obligations with respect to information that constitutes a trade secret survive for as long as the information remains a trade secret under applicable law.

## 9. Return or Destruction

Upon the Discloser's written request or termination of this Agreement, the Recipient shall promptly return or destroy the Discloser's Confidential Information and certify such destruction in writing, except for one archival copy retained solely for legal-compliance purposes and subject to continuing confidentiality. Notwithstanding the foregoing, Confidential Information contained in routine electronic backups or archival systems need not be returned or destroyed if it is not readily accessible in the ordinary course of business and remains subject to this Agreement for so long as it is retained.

## 10. No Warranty; No Obligation

All Confidential Information is provided "as is," without warranty of any kind. Nothing in this Agreement obligates either Party to proceed with any transaction or relationship, and each Party may terminate discussions at any time.

## 11. Remedies

The Parties agree that a breach of this Agreement may cause irreparable harm for which monetary damages would be inadequate, and that the non-breaching Party is entitled to seek injunctive relief in addition to any other remedies available at law or in equity, without the necessity of posting a bond.

## 12. Governing Law; Venue

This Agreement is governed by the laws of the State of Texas without regard to its conflict-of-laws rules. The Parties consent to the exclusive jurisdiction and venue of the state courts located in Fort Bend County, Texas, and the United States District Court for the Southern District of Texas, Houston Division.

## 13. Miscellaneous

This Agreement is the entire agreement between the Parties regarding its subject matter and supersedes all prior understandings. It may be amended only in a writing signed by both Parties. Neither Party may assign it without the other's prior written consent, except to a successor in connection with a merger or sale of substantially all assets. If any provision is held unenforceable, the remainder remains in effect. This Agreement may be executed in counterparts, including by electronic signature, each of which is deemed an original.

_The Parties have executed this Agreement as of the Effective Date._`;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Fill {{PLACEHOLDERS}}. Unknown/blank placeholders become a light underline so a
// missing field is obvious on the page rather than printing "{{X}}".
function fillNda(md, fields = {}) {
  const map = {
    COUNTERPARTY: fields.counterparty || '',
    EFFECTIVE_DATE: fields.effective_date_text || '',
  };
  return String(md || '').replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => map[k] || '__________');
}

// Minimal markdown -> HTML for the NDA body (## headings, **bold**, _italic_,
// paragraphs). Matches what the Legal Disclosures reader supports.
function ndaBodyToHtml(md) {
  const inline = (t) => escapeHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
  const out = [];
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^##\s+(.*)/);
    if (h) { out.push(`<h2>${inline(h[1])}</h2>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('\n');
}

function signatureBlock(fields) {
  const sig = (party, name, title) => `
    <table class="sig"><tr>
      <td>
        <div class="party">${escapeHtml(party)}</div>
        <div class="line">&nbsp;</div><div class="cap">Signature</div>
        <div class="line">${escapeHtml(name || '')}</div><div class="cap">Name</div>
        <div class="line">${escapeHtml(title || '')}</div><div class="cap">Title</div>
        <div class="line">&nbsp;</div><div class="cap">Date</div>
      </td>
    </tr></table>`;
  return `<div class="sigs">
    ${sig('BEDROCK ASSOCIATION MANAGEMENT, LLC', fields.signatory_name, fields.signatory_title)}
    ${sig(String(fields.counterparty || 'COUNTERPARTY').toUpperCase(), fields.cp_signer_name, fields.cp_signer_title)}
  </div>`;
}

function renderNdaHtml(fields = {}, opts = {}) {
  const md = opts.bodyMarkdown || NDA_TEMPLATE_MD;
  const meta = opts.docMeta || {};
  const body = ndaBodyToHtml(fillNda(md, fields));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0.85in 0.9in; }
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Cambria, Georgia, serif; color: #10151f; font-size: 11pt; line-height: 1.5; margin: 0; }
  .brandbar { color: ${BRAND.colors.navy}; font-weight: 700; font-size: 12pt; letter-spacing: .06em; }
  .rule { height: 2px; background: ${BRAND.colors.gold}; width: 70px; margin: 6px 0 16px; }
  h2 { font-size: 11.5pt; color: ${BRAND.colors.navy}; margin: 15px 0 4px; }
  h2:first-of-type { font-size: 15pt; text-align: center; margin-top: 2px; }
  p { margin: 6px 0; text-align: justify; }
  .sigs { margin-top: 26px; display: flex; gap: 34px; break-inside: avoid; }
  .sig { width: 100%; }
  .sig .party { font-weight: 700; font-size: 9.5pt; color: ${BRAND.colors.navy}; letter-spacing: .02em; margin-bottom: 20px; }
  .sig .line { border-bottom: 1px solid #444; min-height: 15px; margin-top: 14px; font-size: 11pt; }
  .sig .cap { font-size: 8pt; color: ${BRAND.colors.stone}; margin-top: 2px; }
  .foot { margin-top: 26px; border-top: 1px solid #d8dee8; padding-top: 8px; color: ${BRAND.colors.stone}; font-size: 8pt; }
  </style></head><body>
  <div class="brandbar">${escapeHtml(BRAND.service.name)}</div>
  <div class="rule"></div>
  ${body}
  ${signatureBlock(fields)}
  <div class="foot">${escapeHtml(BRAND.service.name)} &nbsp;|&nbsp; ${escapeHtml(BRAND.service.addressInline)} &nbsp;|&nbsp; ${escapeHtml(BRAND.service.phone)}${meta.version ? ` &nbsp;|&nbsp; Bedrock Mutual NDA · Template v${escapeHtml(meta.version)}${meta.generated ? ' · Generated ' + escapeHtml(meta.generated) : ''}` : ''}</div>
  </body></html>`;
}

async function buildNdaPdf(fields = {}, opts = {}) {
  const html = renderNdaHtml(fields, opts);
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    try { await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
    return Buffer.from(await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true }));
  } finally { try { await browser.close(); } catch (_) {} }
}

module.exports = { NDA_SLUG, NDA_TITLE, NDA_TEMPLATE_MD, fillNda, ndaBodyToHtml, renderNdaHtml, buildNdaPdf };
