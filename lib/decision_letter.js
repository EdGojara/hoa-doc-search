// Decision letter — renders an HTML letterhead for ACC approve/deny/conditions
// /more-info outcomes. Used by /acc-review/letter, which pipes the HTML through
// puppeteer to produce a printable PDF.

const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'logos', 'bedrock_logo.png');
let LOGO_DATA_URI = null;
function getLogoDataUri() {
  if (LOGO_DATA_URI !== null) return LOGO_DATA_URI;
  try {
    const b = fs.readFileSync(LOGO_PATH);
    LOGO_DATA_URI = 'data:image/png;base64,' + b.toString('base64');
  } catch (_) {
    LOGO_DATA_URI = '';
  }
  return LOGO_DATA_URI;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DECISION_META = {
  approved:                 { label: 'APPLICATION APPROVED',          cls: 'badge-approved' },
  approved_no_conditions:   { label: 'APPLICATION APPROVED',          cls: 'badge-approved' },
  approved_with_conditions: { label: 'APPROVED WITH CONDITIONS',      cls: 'badge-conditions' },
  request_more_info:        { label: 'ADDITIONAL INFORMATION NEEDED', cls: 'badge-info' },
  incomplete:               { label: 'ADDITIONAL INFORMATION NEEDED', cls: 'badge-info' },
  denied:                   { label: 'APPLICATION DENIED',            cls: 'badge-denied' },
};

function renderDecisionLetterHTML(args) {
  const {
    community = 'Your Community',
    homeowner_name = '',
    homeowner_address = '',
    project_summary = '',
    reference_number = '',
    decision_type = 'approved_with_conditions',
    body_text = '',
    date_str = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  } = args || {};

  const meta = DECISION_META[decision_type] || DECISION_META.approved_with_conditions;
  const logo = getLogoDataUri();
  const bodyHtml = escapeHtml(body_text || '').replace(/\n/g, '<br>');
  const salutation = homeowner_name
    ? `Dear ${escapeHtml(homeowner_name.split(/\s+/)[0])},`
    : 'Dear Homeowner,';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.85in 0.85in 1in 0.85in; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; color: #1a1a1a; line-height: 1.55; font-size: 11pt; margin: 0; }
  .header { display: flex; align-items: center; border-bottom: 3px solid #1E2761; padding-bottom: 12px; margin-bottom: 22px; }
  .logo { width: 56px; height: 56px; margin-right: 14px; flex: 0 0 auto; }
  .brand-name { font-size: 16pt; font-weight: 700; color: #1E2761; letter-spacing: -0.3px; }
  .brand-sub { font-size: 9pt; color: #6b7280; letter-spacing: 3px; margin-top: 2px; font-weight: 600; }
  .meta-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; gap: 24px; }
  .recipient { font-size: 11pt; }
  .recipient .name { font-weight: 700; }
  .date { font-size: 10pt; color: #475569; white-space: nowrap; }
  .reference { font-size: 9pt; color: #94A3B8; letter-spacing: 1px; margin-top: 4px; white-space: nowrap; }
  .re-line { font-size: 10pt; color: #475569; margin-bottom: 14px; }
  .decision-badge { display: inline-block; padding: 6px 14px; border-radius: 4px; font-size: 10pt; font-weight: 700; letter-spacing: 1.5px; margin: 4px 0 18px; }
  .badge-approved { background: #d1fae5; color: #065f46; }
  .badge-conditions { background: #fef3c7; color: #92400e; }
  .badge-denied { background: #fee2e2; color: #991b1b; }
  .badge-info { background: #dbeafe; color: #1e3a8a; }
  .salutation { margin-bottom: 12px; }
  .body { font-size: 11pt; text-align: left; }
  .signature { margin-top: 28px; font-size: 11pt; }
  .signature .name { font-weight: 700; color: #1E2761; }
  .footer { text-align: center; font-size: 8pt; color: #94a3b8; margin-top: 32px; padding-top: 10px; border-top: 1px solid #e5e7eb; }
</style></head><body>

<div class="header">
  ${logo ? `<img src="${logo}" class="logo" alt="Bedrock">` : ''}
  <div>
    <div class="brand-name">Bedrock Association Management</div>
    <div class="brand-sub">ARCHITECTURAL REVIEW DECISION</div>
  </div>
</div>

<div class="meta-row">
  <div class="recipient">
    ${homeowner_name ? `<div class="name">${escapeHtml(homeowner_name)}</div>` : ''}
    ${homeowner_address ? `<div>${escapeHtml(homeowner_address)}</div>` : ''}
    <div>${escapeHtml(community)}</div>
  </div>
  <div style="text-align:right;">
    <div class="date">${escapeHtml(date_str)}</div>
    ${reference_number ? `<div class="reference">REF: ${escapeHtml(reference_number)}</div>` : ''}
  </div>
</div>

${project_summary ? `<div class="re-line"><strong>Re:</strong> ${escapeHtml(project_summary)}</div>` : ''}

<div class="decision-badge ${meta.cls}">${meta.label}</div>

<div class="salutation">${salutation}</div>

<div class="body">${bodyHtml}</div>

<div class="signature">
  <p>Sincerely,</p>
  <p style="margin-top:24px;"><span class="name">Bedrock Association Management</span><br>
  on behalf of the ${escapeHtml(community)} Architectural Control Committee</p>
</div>

<div class="footer">Bedrock Association Management · bedrocktxai.com</div>

</body></html>`;
}

module.exports = { renderDecisionLetterHTML };
