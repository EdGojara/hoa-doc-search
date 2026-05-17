// Decision letter — produces a clean homeowner-facing letterhead PDF that
// matches the long-running Bedrock format: community logo centered at top,
// return address block, recipient, salutation, body, closing, signature.
//
// This file ONLY renders the visible letter. The AI's internal analysis is
// shown in the manager's review panel (not this PDF). Server-side extracts a
// LETTER_BODY block from the AI output and passes it here as body_text.

const fs = require('fs');
const path = require('path');
const BRAND = require('./brand');

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');

// Maps community name (and a few common aliases) → logo filename.
const COMMUNITY_LOGOS = {
  'Lakes of Pine Forest':        'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch':  'canyon_gate_logo.png',
  'Canyon Gate':                 'canyon_gate_logo.png',
  'Waterview Estates':           'waterview_logo.jpg',
  'Waterview':                   'waterview_logo.jpg',
};

const dataUriCache = {};
function loadLogoDataUri(filename) {
  if (!filename) return '';
  if (dataUriCache[filename] !== undefined) return dataUriCache[filename];
  try {
    const buf = fs.readFileSync(path.join(LOGOS_DIR, filename));
    const mime = filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg' : 'image/png';
    dataUriCache[filename] = `data:${mime};base64,` + buf.toString('base64');
  } catch (_) {
    dataUriCache[filename] = '';
  }
  return dataUriCache[filename];
}

function getCommunityLogoDataUri(community) {
  if (!community) return '';
  if (COMMUNITY_LOGOS[community]) return loadLogoDataUri(COMMUNITY_LOGOS[community]);
  // Loose match
  for (const [name, file] of Object.entries(COMMUNITY_LOGOS)) {
    if (community.toLowerCase().includes(name.toLowerCase())) return loadLogoDataUri(file);
  }
  return '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert clean prose into safe HTML paragraphs. Strips common markdown
// artifacts that may have leaked through (** bold **, _italic_, leading #
// headings, --- dividers) and keeps numbered/bulleted lists as proper lists.
function bodyToHtml(text) {
  if (!text || !text.trim()) return '';
  // Normalize line endings
  let t = text.replace(/\r\n/g, '\n').trim();
  // Strip markdown headings entirely — homeowner letters never have section headings
  t = t.replace(/^#{1,6}\s+.*$/gm, '').trim();
  // Strip --- dividers
  t = t.replace(/^-{3,}\s*$/gm, '').trim();
  // Remove bold/italic markers (keep the content)
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/(?<![A-Za-z])_([^_\n]+)_(?![A-Za-z])/g, '$1');

  // Split into paragraph blocks separated by blank lines
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const html = blocks.map((block) => {
    // Numbered list?
    if (/^\s*\d+\.\s+/.test(block)) {
      const items = block.split(/\n+/).map((line) => line.replace(/^\s*\d+\.\s+/, '').trim()).filter(Boolean);
      return `<ol>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ol>`;
    }
    // Bulleted list?
    if (/^\s*[-*]\s+/.test(block)) {
      const items = block.split(/\n+/).map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
      return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
    }
    // Plain paragraph — preserve single line breaks as <br>
    return `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  return html;
}

function renderDecisionLetterHTML(args) {
  const {
    community = '',
    homeowner_name = '',
    homeowner_address = '',
    project_summary = '',
    reference_number = '',
    body_text = '',
    date_str = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  } = args || {};

  const logoDataUri = getCommunityLogoDataUri(community);
  const bodyHtml = bodyToHtml(body_text);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.85in 0.95in 1in 0.95in; }
  body {
    font-family: "Times New Roman", Cambria, Georgia, serif;
    color: #111;
    line-height: 1.45;
    font-size: 11.5pt;
    margin: 0;
  }
  .logo-wrap { text-align: center; margin-bottom: 18px; }
  .logo-wrap img { max-height: 110px; max-width: 220px; }
  .from-block, .date-block, .recipient-block, .salutation,
  .body-block, .closing, .signature {
    margin: 0;
  }
  .from-block { font-size: 11pt; }
  .from-block .name { font-weight: bold; }
  .date-block { margin-top: 18px; }
  .recipient-block { margin-top: 18px; }
  .re-line { margin-top: 14px; font-style: italic; color: #333; }
  .salutation { margin-top: 18px; }
  .body-block { margin-top: 14px; }
  .body-block p { margin: 0 0 12px; }
  .body-block ol, .body-block ul { margin: 4px 0 12px; padding-left: 28px; }
  .body-block li { margin-bottom: 6px; }
  .closing { margin-top: 18px; }
  .signature { margin-top: 18px; }
  .signature .line1 { font-weight: bold; }
  .footer-contact { margin-top: 6px; font-size: 11pt; color: #111; }
</style></head><body>

<div class="logo-wrap">
  ${logoDataUri
    ? `<img src="${logoDataUri}" alt="${escapeHtml(community)}">`
    : `<div style="font-size:18pt; font-weight:bold;">${escapeHtml(community)}</div>`}
</div>

<div class="from-block">
  <div class="name">${escapeHtml(community)}</div>
  <div>c/o ${BRAND.service.name}</div>
  <div>${BRAND.service.address}</div>
  <div>${BRAND.service.addressCityStateZip}</div>
</div>

<div class="date-block">${escapeHtml(date_str)}</div>

<div class="recipient-block">
  ${homeowner_name ? `<div>${escapeHtml(homeowner_name)}</div>` : ''}
  ${homeowner_address
      ? escapeHtml(homeowner_address).split(/\s*,\s*/).map((line) => `<div>${line}</div>`).join('')
      : ''}
</div>

${project_summary ? `<div class="re-line">Re: ${escapeHtml(project_summary)}${reference_number ? ` (Ref: ${escapeHtml(reference_number)})` : ''}</div>` : ''}

<div class="body-block">${bodyHtml}</div>

<div class="closing">On behalf of the ${escapeHtml(community)} Architectural Control Committee,</div>

<div class="signature">
  <div class="line1">${BRAND.service.name}</div>
  <div>On behalf of ${escapeHtml(community)} Homeowners Association</div>
  <div class="footer-contact">${BRAND.service.phone} &nbsp;|&nbsp; ${BRAND.service.website}</div>
</div>

</body></html>`;
}

module.exports = { renderDecisionLetterHTML };
