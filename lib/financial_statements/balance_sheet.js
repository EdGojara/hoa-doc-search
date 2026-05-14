// Balance sheet template — renders a Bedrock-branded HTML balance sheet.
// Designed to look like a CPA firm produced it (serif typography, restrained
// palette, community logo centered, "Reviewed by Bedrock" findings block).
//
// Input shape (extracted_data):
//   {
//     period_label: "April 30, 2026",
//     funds: ["Operating", "Reserve", "Adopt a School"],
//     assets: [
//       { category: "Cash", lines: [{ label, values: { Operating, Reserve, "Adopt a School", Total }}], total },
//       ...
//     ],
//     liabilities_equity: { liabilities: [...], equity: [...], totals: {...} },
//     totals: { total_assets: {...}, total_liab_equity: {...} }
//   }
//
// Findings shape: [ { severity: "good" | "note" | "warn" | "alert", text: "..." }, ... ]

const fs = require('fs');
const path = require('path');

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
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtMoney(n) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return escapeHtml(String(n));
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `($${formatted})` : `$${formatted}`;
}

const FINDING_STYLES = {
  good:  { icon: '✓', color: '#15803d' },
  note:  { icon: '•', color: '#475569' },
  warn:  { icon: '⚠', color: '#a16207' },
  alert: { icon: '🛑', color: '#b91c1c' },
};

function renderBalanceSheetHTML({ community, data = {}, findings = [] }) {
  const logo = getCommunityLogo(community);
  const periodLabel = data.period_label || '';
  const funds = Array.isArray(data.funds) && data.funds.length > 0
    ? data.funds
    : ['Operating', 'Reserve', 'Total'];

  // Render a row of values across the columns (Operating / Reserve / Total / etc.)
  function valueRow(values, isBold = false, isIndent = true) {
    return funds.map((f) => {
      const v = values && values[f] != null ? values[f] : null;
      return `<td class="num ${isBold ? 'b' : ''}">${v == null ? '' : escapeHtml(fmtMoney(v))}</td>`;
    }).join('');
  }

  function categoryBlock(cat) {
    const rowsHtml = (cat.lines || []).map((ln) => `
      <tr>
        <td class="label indent">${escapeHtml(ln.label || '')}</td>
        ${valueRow(ln.values || {})}
      </tr>
    `).join('');
    const totalHtml = cat.total
      ? `<tr class="subtotal">
           <td class="label">Total ${escapeHtml(cat.title || '')}</td>
           ${valueRow(cat.total, true)}
         </tr>`
      : '';
    return `
      <tr class="category-row">
        <td class="label cat">${escapeHtml(cat.title || '')}</td>
        ${funds.map(() => '<td></td>').join('')}
      </tr>
      ${rowsHtml}
      ${totalHtml}
    `;
  }

  const assetsHtml = (data.assets || []).map(categoryBlock).join('');
  const liabHtml = (data.liabilities || []).map(categoryBlock).join('');
  const equityHtml = (data.equity || []).map(categoryBlock).join('');

  const totalAssetsRow = data.totals && data.totals.total_assets
    ? `<tr class="grand-total">
         <td class="label">Total Assets</td>
         ${valueRow(data.totals.total_assets, true)}
       </tr>`
    : '';
  const totalLiabRow = data.totals && data.totals.total_liabilities
    ? `<tr class="subtotal">
         <td class="label">Total Liabilities</td>
         ${valueRow(data.totals.total_liabilities, true)}
       </tr>`
    : '';
  const totalEquityRow = data.totals && data.totals.total_equity
    ? `<tr class="subtotal">
         <td class="label">Total Equity</td>
         ${valueRow(data.totals.total_equity, true)}
       </tr>`
    : '';
  const totalLiabEquityRow = data.totals && data.totals.total_liabilities_equity
    ? `<tr class="grand-total">
         <td class="label">Total Liabilities &amp; Equity</td>
         ${valueRow(data.totals.total_liabilities_equity, true)}
       </tr>`
    : '';

  const findingsHtml = findings.length > 0
    ? `
      <div class="findings">
        <div class="findings-title">Reviewed by Bedrock</div>
        ${findings.map((f) => {
          const s = FINDING_STYLES[f.severity] || FINDING_STYLES.note;
          return `<div class="finding"><span class="f-icon" style="color:${s.color};">${s.icon}</span> ${escapeHtml(f.text || '')}</div>`;
        }).join('')}
      </div>
    `
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.7in 0.85in 0.85in 0.85in; }
  body { font-family: Georgia, Cambria, "Times New Roman", serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.4; margin: 0; }

  .header { text-align: center; padding-bottom: 14px; border-bottom: 2px solid #1E2761; margin-bottom: 22px; }
  .header img { max-height: 95px; max-width: 220px; display: block; margin: 0 auto 10px; }
  .header .community { font-size: 18pt; font-weight: 700; color: #1E2761; letter-spacing: -0.2px; }
  .header .doc-type { font-size: 11pt; color: #475569; letter-spacing: 3px; margin-top: 4px; text-transform: uppercase; font-weight: 600; }
  .header .period { font-size: 11pt; color: #1a1a1a; margin-top: 6px; font-style: italic; }

  table.bs { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  table.bs th { font-family: Calibri, Arial, sans-serif; font-size: 10pt; color: #475569; text-align: right; padding: 6px 6px; border-bottom: 1.5px solid #1E2761; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
  table.bs th.first { text-align: left; }
  table.bs td { padding: 4px 6px; vertical-align: top; }
  table.bs td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 10.5pt; }
  table.bs td.label { font-size: 10.5pt; }
  table.bs td.label.indent { padding-left: 18px; color: #334155; }
  table.bs td.label.cat { font-weight: 700; color: #1E2761; padding-top: 8px; font-size: 10.5pt; }
  table.bs tr.subtotal td { font-weight: 700; border-top: 0.5px solid #cbd5e1; padding-top: 4px; padding-bottom: 4px; }
  table.bs tr.grand-total td { font-weight: 700; border-top: 1.5px solid #1E2761; border-bottom: 1.5px double #1E2761; padding-top: 5px; padding-bottom: 5px; font-size: 11pt; color: #1E2761; }

  .section-title { font-family: Calibri, Arial, sans-serif; font-size: 12pt; font-weight: 700; color: #1E2761; margin: 14px 0 6px; letter-spacing: 0.3px; text-transform: uppercase; }

  .findings { margin-top: 24px; padding: 14px 18px; background: #f8fafc; border-left: 3px solid #1E2761; border-radius: 0 6px 6px 0; }
  .findings-title { font-family: Calibri, Arial, sans-serif; font-size: 10pt; color: #1E2761; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
  .finding { font-size: 10pt; margin: 4px 0; color: #1a1a1a; }
  .finding .f-icon { display: inline-block; width: 18px; font-weight: 700; }

  .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 9pt; color: #94a3b8; }
  .footer .b { color: #1E2761; font-weight: 700; }
</style></head><body>

<div class="header">
  ${logo ? `<img src="${logo}" alt="${escapeHtml(community)}">` : ''}
  <div class="community">${escapeHtml(community || '')}</div>
  <div class="doc-type">Balance Sheet</div>
  ${periodLabel ? `<div class="period">As of ${escapeHtml(periodLabel)}</div>` : ''}
</div>

<div class="section-title">Assets</div>
<table class="bs">
  <thead>
    <tr>
      <th class="first">&nbsp;</th>
      ${funds.map((f) => `<th>${escapeHtml(f)}</th>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${assetsHtml}
    ${totalAssetsRow}
  </tbody>
</table>

<div class="section-title">Liabilities &amp; Equity</div>
<table class="bs">
  <thead>
    <tr>
      <th class="first">&nbsp;</th>
      ${funds.map((f) => `<th>${escapeHtml(f)}</th>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${liabHtml}
    ${totalLiabRow}
    ${equityHtml}
    ${totalEquityRow}
    ${totalLiabEquityRow}
  </tbody>
</table>

${findingsHtml}

<div class="footer">
  Prepared by <span class="b">Bedrock Association Management</span> on behalf of ${escapeHtml(community || '')}<br>
  bedrocktx.com &nbsp;·&nbsp; (832) 588-2485
</div>

</body></html>`;
}

module.exports = { renderBalanceSheetHTML };
