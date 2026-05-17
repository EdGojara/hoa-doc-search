// ============================================================================
// management_agreement.js
// ----------------------------------------------------------------------------
// Bedrock-branded management agreement renderer. Per the brand-the-output
// rule: we never forward a vendor PDF; we render the whole agreement from
// data so every community gets a consistent Bedrock document.
//
// Inputs:
//   contract        — row from `contracts` (with new lot_count, per_lot_monthly_fee,
//                     monthly_fee_override, term_months fields from migration 041)
//   community       — row from `communities` (name, address, legal entity)
//   defaults        — row from `bedrock_contract_defaults` (legal body template)
//   fixedItems      — rows from contract_fixed_items for this contract
//   reimbursables   — rows from contract_reimbursables for this contract
//   ownerCharges    — rows from contract_owner_charges for this contract
//
// Output: complete HTML string ready to feed into puppeteer for PDF generation.
//
// Per-lot math is INTERNAL ONLY. The customer-facing total prints as a single
// formatted dollar amount; lot_count and per_lot_monthly_fee never appear.
// ============================================================================

const fs = require('fs');
const path = require('path');
const BRAND = require('../brand');

const LOGOS_DIR = path.join(__dirname, '..', '..', 'public', 'logos');

const COMMUNITY_LOGOS = {
  'Lakes of Pine Forest':        'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch':  'canyon_gate_logo.png',
  'Canyon Gate':                 'canyon_gate_logo.png',
  'Waterview Estates':           'waterview_logo.jpg',
  'Waterview':                   'waterview_logo.jpg',
};
const dataUriCache = {};
function logoDataUri(filename) {
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
function getCommunityLogo(community) {
  if (!community) return '';
  if (COMMUNITY_LOGOS[community]) return logoDataUri(COMMUNITY_LOGOS[community]);
  for (const [name, file] of Object.entries(COMMUNITY_LOGOS)) {
    if (community.toLowerCase().includes(name.toLowerCase())) return logoDataUri(file);
  }
  return '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// computeMonthlyFee — internal-only math. monthly_fee_override beats the
// per-lot calc; absent both, falls back to summing contract_fixed_items.
function computeMonthlyFee(contract, fixedItems) {
  if (contract && contract.monthly_fee_override != null) {
    return Number(contract.monthly_fee_override);
  }
  if (contract && contract.lot_count && contract.per_lot_monthly_fee) {
    return Number(contract.lot_count) * Number(contract.per_lot_monthly_fee);
  }
  // Fallback: sum the management line(s) in contract_fixed_items.
  const sum = (fixedItems || []).reduce((s, r) => s + Number(r.monthly_amount || 0), 0);
  return sum;
}

// applyMergeTokens — replace {{token}} placeholders in the contract body.
// Tokens not provided are left untouched (rendered literally) so the writer
// gets feedback that something is missing rather than silent blanks.
function applyMergeTokens(template, tokens) {
  if (!template) return '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(tokens, key)) return escapeHtml(tokens[key] ?? '');
    return m;
  });
}

function rateSheetTableHtml({ fixedItems, reimbursables, ownerCharges, monthlyFee }) {
  const fmtRows = (rows, valueKey, valueFmt) => {
    if (!rows || rows.length === 0) return '<tr><td colspan="2" class="empty">— none —</td></tr>';
    return rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.description || r.category || '')}${r.notes ? `<div class="note">${escapeHtml(r.notes)}</div>` : ''}</td>
        <td class="amt">${valueFmt(r[valueKey])}</td>
      </tr>
    `).join('');
  };

  return `
<div class="rate-sheet">
  <h2 class="section-title">Compensation &amp; Rate Schedule</h2>

  <div class="mgmt-fee-card">
    <div class="lbl">Monthly Management Fee</div>
    <div class="val">${fmtMoney(monthlyFee)}</div>
  </div>

  <h3 class="sub-title">Additional Fixed Monthly Items</h3>
  <table class="rate-table">
    <thead><tr><th>Description</th><th class="amt">Monthly</th></tr></thead>
    <tbody>${fmtRows((fixedItems || []).filter((r) => !/management\s*fee/i.test(r.description || '')), 'monthly_amount', fmtMoney)}</tbody>
  </table>

  <h3 class="sub-title">Reimbursable Items (billed as used)</h3>
  <table class="rate-table">
    <thead><tr><th>Item</th><th class="amt">Rate</th></tr></thead>
    <tbody>${(reimbursables || []).length === 0
      ? '<tr><td colspan="2" class="empty">— none —</td></tr>'
      : reimbursables.map((r) => `
        <tr>
          <td>${escapeHtml(r.description || r.category || '')}${r.notes ? `<div class="note">${escapeHtml(r.notes)}</div>` : ''}</td>
          <td class="amt">${r.billing_method === 'at_cost' ? 'At cost' : (r.unit_price != null ? fmtMoney(r.unit_price) + (r.billing_method === 'hourly' ? ' / hr' : r.billing_method === 'per_lot_plus_postage' ? ' / lot + postage' : ' / unit') : '—')}</td>
        </tr>
      `).join('')}</tbody>
  </table>

  <h3 class="sub-title">Owner-Billable Charges (collected from owner where legally permitted)</h3>
  <table class="rate-table">
    <thead><tr><th>Charge</th><th class="amt">Fee</th></tr></thead>
    <tbody>${fmtRows(ownerCharges, 'fee_amount', fmtMoney)}</tbody>
  </table>
</div>`;
}

function signatureBlockHtml({ community, communityLegalName }) {
  return `
<div class="signatures">
  <div class="sig-col">
    <div class="sig-line"></div>
    <div class="sig-label">For ${escapeHtml(communityLegalName || community)}</div>
    <div class="sig-fields">
      <div>Name: ____________________________</div>
      <div>Title: ____________________________</div>
      <div>Date: ____________________________</div>
    </div>
  </div>
  <div class="sig-col">
    <div class="sig-line"></div>
    <div class="sig-label">For ${BRAND.service.legal}</div>
    <div class="sig-fields">
      <div>Name: ____________________________</div>
      <div>Title: ____________________________</div>
      <div>Date: ____________________________</div>
    </div>
  </div>
</div>`;
}

// renderManagementAgreementHTML — full HTML document for puppeteer → PDF.
async function renderManagementAgreementHTML({
  contract,
  community,
  defaults,
  fixedItems,
  reimbursables,
  ownerCharges,
}) {
  const communityName = (community && community.name) || 'the Association';
  const communityLegalName = (community && community.legal_entity_name) || `${communityName} Homeowners Association, Inc.`;
  const communityAddress = (community && community.address) || '';

  const monthlyFee = computeMonthlyFee(contract, fixedItems);
  const annualFee = monthlyFee * 12;
  const termMonths = contract && contract.term_months ? Number(contract.term_months) : (defaults && defaults.default_term_months) || 12;

  const tokens = {
    community_name: communityName,
    community_legal_entity: communityLegalName,
    community_address: communityAddress,
    effective_date: fmtDate(contract && contract.effective_date),
    term_months: String(termMonths),
    term_summary: termMonths === 12 ? 'twelve (12) months' : `${termMonths} months`,
    monthly_fee: fmtMoney(monthlyFee),
    annual_fee: fmtMoney(annualFee),
    bedrock_legal_name: BRAND.service.legal,
    bedrock_address: BRAND.service.addressInline,
    bedrock_phone: BRAND.service.phone,
    bedrock_email: BRAND.service.email,
  };

  const bodyTemplate = (defaults && defaults.contract_body_template) ||
    `<p><em>The Bedrock-standard management agreement text has not been pasted in yet. Visit the Bedrock Office → Contract Defaults to enter the legal body of the agreement once; it will then apply to every new community contract.</em></p>`;

  let body = applyMergeTokens(bodyTemplate, tokens);

  // If the writer didn't explicitly place {{rate_sheet}} or {{signature_block}}
  // in the template, append both at the end of the body.
  const rateSheetHtml = rateSheetTableHtml({ fixedItems, reimbursables, ownerCharges, monthlyFee });
  const sigBlockHtml = signatureBlockHtml({ community: communityName, communityLegalName });

  if (body.includes('{{rate_sheet}}')) {
    body = body.replace(/\{\{\s*rate_sheet\s*\}\}/g, rateSheetHtml);
  } else {
    body = body + '\n' + rateSheetHtml;
  }
  if (body.includes('{{signature_block}}')) {
    body = body.replace(/\{\{\s*signature_block\s*\}\}/g, sigBlockHtml);
  } else {
    body = body + '\n' + sigBlockHtml;
  }

  const logo = getCommunityLogo(communityName);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.75in 0.9in 0.85in 0.9in; }
  body {
    font-family: Georgia, Cambria, "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.55;
    font-size: 11pt;
    margin: 0;
  }
  .head {
    text-align: center;
    padding-bottom: 14px;
    border-bottom: 2px solid ${BRAND.colors.navy};
    margin-bottom: 18px;
  }
  .head img { max-height: 80px; max-width: 220px; display: block; margin: 0 auto 6px; }
  .head .parties { font-size: 13pt; font-weight: 700; color: ${BRAND.colors.navy}; }
  .head .sub { font-size: 9.5pt; color: #475569; margin-top: 4px; }
  .doc-title {
    text-align: center;
    font-family: Calibri, Arial, sans-serif;
    font-size: 15pt;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: ${BRAND.colors.navy};
    font-weight: 700;
    margin: 16px 0 12px;
  }
  p { margin: 0 0 11px; text-align: justify; }
  h2.section-title {
    font-family: Calibri, Arial, sans-serif;
    font-size: 13pt;
    color: ${BRAND.colors.navy};
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 22px 0 10px;
    padding-bottom: 4px;
    border-bottom: 1px solid ${BRAND.colors.gold};
  }
  h3.sub-title {
    font-family: Calibri, Arial, sans-serif;
    font-size: 11pt;
    color: ${BRAND.colors.navy};
    margin: 14px 0 6px;
  }
  .mgmt-fee-card {
    margin: 10px 0 14px;
    padding: 12px 16px;
    border: 2px solid ${BRAND.colors.navy};
    border-radius: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #fff;
  }
  .mgmt-fee-card .lbl {
    font-family: Calibri, Arial, sans-serif;
    font-size: 10pt;
    color: #475569;
    letter-spacing: 1px;
    text-transform: uppercase;
    font-weight: 700;
  }
  .mgmt-fee-card .val {
    font-size: 18pt;
    font-weight: 700;
    color: ${BRAND.colors.navy};
  }
  table.rate-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5pt;
    margin-bottom: 4px;
  }
  table.rate-table th {
    text-align: left;
    font-family: Calibri, Arial, sans-serif;
    font-size: 9pt;
    color: #475569;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border-bottom: 1.5px solid ${BRAND.colors.navy};
    padding: 5px 8px;
  }
  table.rate-table th.amt, table.rate-table td.amt { text-align: right; }
  table.rate-table td {
    padding: 5px 8px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
  }
  table.rate-table td.empty { color: #94A3B8; font-style: italic; text-align: center; }
  table.rate-table .note { font-size: 9.5pt; color: #64748b; font-style: italic; margin-top: 2px; }

  .signatures {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 36px;
    margin-top: 36px;
    page-break-inside: avoid;
  }
  .sig-col .sig-line {
    border-bottom: 1px solid #1a1a1a;
    height: 38px;
    margin-bottom: 4px;
  }
  .sig-col .sig-label {
    font-family: Calibri, Arial, sans-serif;
    font-size: 10pt;
    font-weight: 700;
    color: ${BRAND.colors.navy};
    margin-bottom: 8px;
  }
  .sig-col .sig-fields { font-size: 10pt; color: #334155; line-height: 1.8; }
</style></head><body>

<div class="head">
  ${logo
    ? `<img src="${logo}" alt="${escapeHtml(communityName)}">`
    : `<div style="font-size:20pt; font-weight:700; color:${BRAND.colors.navy};">${escapeHtml(communityName)}</div>`}
  <div class="parties">${escapeHtml(communityLegalName)}</div>
  <div class="sub">and ${BRAND.service.legal}</div>
</div>

<div class="doc-title">Management Agreement</div>

${body}

</body></html>`;
}

module.exports = {
  renderManagementAgreementHTML,
  computeMonthlyFee,
  applyMergeTokens,
};
