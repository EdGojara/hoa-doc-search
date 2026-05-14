// Income Statement template — renders a Bedrock-branded Statement of Revenues
// and Expenses. Same letterhead pattern as the balance sheet and reserve
// performance. Output is dense (a typical HOA IS has 40-60 line items + 5-10
// category subtotals) so the layout has to be tight without feeling cramped.

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
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtMoney(n) {
  if (n == null) return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return escapeHtml(String(n));
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `($${abs})` : `$${abs}`;
}

const FINDING_STYLES = {
  good:  { icon: '✓', color: '#15803d' },
  note:  { icon: '•', color: '#475569' },
  warn:  { icon: '⚠', color: '#a16207' },
  alert: { icon: '🛑', color: '#b91c1c' },
};

function valTd(v, { bold = false, indent = false } = {}) {
  const display = v == null ? '' : escapeHtml(fmtMoney(v));
  const cls = `num${bold ? ' b' : ''}`;
  return `<td class="${cls}">${display}</td>`;
}

function varianceTd(v, { isIncome = true, bold = false } = {}) {
  if (v == null) return `<td class="num${bold ? ' b' : ''}"></td>`;
  const num = Number(v);
  const favorable = isIncome ? num >= 0 : num >= 0;
  const cls = `num${bold ? ' b' : ''} ${favorable ? 'fav' : 'unfav'}`;
  return `<td class="${cls}">${escapeHtml(fmtMoney(num))}</td>`;
}

function lineRow(line, kind) {
  const isIncome = kind === 'income';
  return `
    <tr>
      <td class="label indent">${escapeHtml(line.label || '')}</td>
      ${valTd(line.current_actual)}
      ${valTd(line.current_budget)}
      ${varianceTd(line.current_variance, { isIncome })}
      ${valTd(line.ytd_actual)}
      ${valTd(line.ytd_budget)}
      ${varianceTd(line.ytd_variance, { isIncome })}
      ${valTd(line.annual_budget)}
    </tr>
  `;
}

function subtotalRow(label, sub, kind) {
  if (!sub) return '';
  const isIncome = kind === 'income';
  return `
    <tr class="subtotal">
      <td class="label">${escapeHtml(label)}</td>
      ${valTd(sub.current_actual, { bold: true })}
      ${valTd(sub.current_budget, { bold: true })}
      ${varianceTd(sub.current_variance, { isIncome, bold: true })}
      ${valTd(sub.ytd_actual, { bold: true })}
      ${valTd(sub.ytd_budget, { bold: true })}
      ${varianceTd(sub.ytd_variance, { isIncome, bold: true })}
      ${valTd(sub.annual_budget, { bold: true })}
    </tr>
  `;
}

function grandTotalRow(label, tot, kind) {
  if (!tot) return '';
  const isIncome = kind === 'income';
  return `
    <tr class="grand-total">
      <td class="label">${escapeHtml(label)}</td>
      ${valTd(tot.current_actual, { bold: true })}
      ${valTd(tot.current_budget, { bold: true })}
      ${varianceTd(tot.current_variance, { isIncome, bold: true })}
      ${valTd(tot.ytd_actual, { bold: true })}
      ${valTd(tot.ytd_budget, { bold: true })}
      ${varianceTd(tot.ytd_variance, { isIncome, bold: true })}
      ${valTd(tot.annual_budget, { bold: true })}
    </tr>
  `;
}

function categoryBlock(sec) {
  const kind = sec.kind || 'expense';
  const linesHtml = (sec.lines || []).map((ln) => lineRow(ln, kind)).join('');
  const subHtml = sec.subtotal ? subtotalRow(`Total ${sec.title || ''}`, sec.subtotal, kind) : '';
  return `
    <tr class="category-row">
      <td class="cat">${escapeHtml(sec.title || '')}</td>
      <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>
    ${linesHtml}
    ${subHtml}
  `;
}

function renderIncomeStatementHTML({ community, data = {}, findings = [] }) {
  const logo = getCommunityLogo(community);
  const periodLabel = data.period_label || '';
  const sections = data.sections || [];
  const totals = data.totals || {};

  // Hero summary numbers
  const netTotal = totals.net_total || {};
  const opNet = totals.operating_net || {};
  const totalRev = totals.total_revenue || {};
  const totalExp = totals.total_expense || {};

  // Split sections by kind for visual rhythm
  const incomeSections = sections.filter((s) => s.kind === 'income');
  const expenseSections = sections.filter((s) => s.kind === 'expense');

  const findingsHtml = findings.length > 0
    ? `
      <div class="findings">
        <div class="findings-title">Bedrock Observations</div>
        ${findings.map((f) => {
          const s = FINDING_STYLES[f.severity] || FINDING_STYLES.note;
          return `<div class="finding"><span class="f-icon" style="color:${s.color};">${s.icon}</span> ${escapeHtml(f.text || '')}</div>`;
        }).join('')}
        <div class="findings-disclaimer">These observations are commentary from Bedrock Association Management for operational use by the Board and Treasurer. They do not constitute a review, audit, or any form of assurance opinion under AICPA standards.</div>
      </div>
    `
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter landscape; margin: 0.45in 0.55in 0.7in 0.55in; }
  body { font-family: Georgia, Cambria, "Times New Roman", serif; color: #1a1a1a; font-size: 8.5pt; line-height: 1.3; margin: 0; }

  .header { text-align: center; padding-bottom: 10px; border-bottom: 2px solid #1E2761; margin-bottom: 14px; }
  .header img { max-height: 65px; max-width: 160px; display: block; margin: 0 auto 6px; }
  .header .community { font-size: 14pt; font-weight: 700; color: #1E2761; }
  .header .doc-type { font-size: 8.5pt; color: #475569; letter-spacing: 2.5px; margin-top: 3px; text-transform: uppercase; font-weight: 600; }
  .header .period { font-size: 9pt; color: #1a1a1a; margin-top: 4px; font-style: italic; }

  .hero { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .hero-card { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 3px solid #1E2761; border-radius: 0 6px 6px 0; padding: 8px 10px; }
  .hero-card .lbl { font-size: 8pt; color: #475569; letter-spacing: 1.2px; text-transform: uppercase; font-weight: 700; font-family: Calibri, Arial, sans-serif; }
  .hero-card .val { font-size: 12pt; font-weight: 700; color: #1E2761; margin-top: 2px; font-family: Georgia, serif; }
  .hero-card .sub { font-size: 7.5pt; color: #64748b; margin-top: 1px; font-style: italic; }
  .hero-card .val.pos { color: #15803d; }
  .hero-card .val.neg { color: #b91c1c; }

  table.is { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  table.is thead th { font-family: Calibri, Arial, sans-serif; font-size: 7.5pt; color: #475569; padding: 4px 4px; border-bottom: 1.5px solid #1E2761; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; text-align: right; }
  table.is thead th.first { text-align: left; }
  table.is thead th.group { text-align: center; border-bottom: 0.5px solid #cbd5e1; padding-bottom: 2px; }
  table.is thead .group-spacer { border-bottom: 0; }
  table.is td { padding: 2.5px 4px; vertical-align: top; font-size: 8.5pt; }
  table.is td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.is td.num.b { font-weight: 700; }
  table.is td.num.fav { color: #15803d; }
  table.is td.num.unfav { color: #b91c1c; }
  table.is td.label { font-size: 8.5pt; }
  table.is td.label.indent { padding-left: 14px; color: #334155; }
  table.is td.cat { font-weight: 700; color: #1E2761; padding-top: 6px; padding-bottom: 2px; font-size: 8.5pt; letter-spacing: 0.2px; }
  table.is tr.subtotal td { font-weight: 700; border-top: 0.5px solid #cbd5e1; padding-top: 3px; padding-bottom: 3px; background: #fafbfc; }
  table.is tr.grand-total td { font-weight: 700; border-top: 1.5px solid #1E2761; border-bottom: 1.5px double #1E2761; padding-top: 4px; padding-bottom: 4px; color: #1E2761; font-size: 9pt; }

  .section-title { font-family: Calibri, Arial, sans-serif; font-size: 10pt; font-weight: 700; color: #1E2761; margin: 10px 0 4px; letter-spacing: 0.3px; text-transform: uppercase; }

  .findings { margin-top: 18px; padding: 12px 16px; background: #f8fafc; border-left: 3px solid #1E2761; border-radius: 0 6px 6px 0; }
  .findings-title { font-family: Calibri, Arial, sans-serif; font-size: 9pt; color: #1E2761; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; }
  .finding { font-size: 9.5pt; margin: 5px 0; color: #1a1a1a; line-height: 1.5; }
  .finding .f-icon { display: inline-block; width: 16px; font-weight: 700; }
  .findings-disclaimer { margin-top: 8px; padding-top: 6px; border-top: 1px dashed #cbd5e1; font-size: 7.5pt; color: #64748b; font-style: italic; line-height: 1.35; }

  .footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 8pt; color: #94a3b8; }
  .footer .b { color: #1E2761; font-weight: 700; }
</style></head><body>

<div class="header">
  ${logo ? `<img src="${logo}" alt="${escapeHtml(community)}">` : ''}
  <div class="community">${escapeHtml(community || '')}</div>
  <div class="doc-type">Statement of Revenues &amp; Expenses</div>
  ${periodLabel ? `<div class="period">${escapeHtml(periodLabel)}</div>` : ''}
</div>

<div class="hero">
  <div class="hero-card">
    <div class="lbl">YTD Revenue</div>
    <div class="val">${escapeHtml(fmtMoney(totalRev.ytd_actual))}</div>
    ${totalRev.ytd_variance != null ? `<div class="sub">${Number(totalRev.ytd_variance) >= 0 ? '+' : ''}${escapeHtml(fmtMoney(totalRev.ytd_variance))} vs budget</div>` : ''}
  </div>
  <div class="hero-card">
    <div class="lbl">YTD Expense</div>
    <div class="val">${escapeHtml(fmtMoney(totalExp.ytd_actual))}</div>
    ${totalExp.ytd_variance != null ? `<div class="sub">${Number(totalExp.ytd_variance) >= 0 ? '+' : ''}${escapeHtml(fmtMoney(totalExp.ytd_variance))} vs budget</div>` : ''}
  </div>
  <div class="hero-card">
    <div class="lbl">YTD Net</div>
    <div class="val ${(opNet.ytd_actual != null && Number(opNet.ytd_actual) >= 0) ? 'pos' : 'neg'}">${escapeHtml(fmtMoney(opNet.ytd_actual))}</div>
    ${opNet.ytd_variance != null ? `<div class="sub">${Number(opNet.ytd_variance) >= 0 ? '+' : ''}${escapeHtml(fmtMoney(opNet.ytd_variance))} vs budget</div>` : ''}
  </div>
  <div class="hero-card">
    <div class="lbl">Annual Budget Net</div>
    <div class="val">${escapeHtml(fmtMoney(opNet.annual_budget))}</div>
    <div class="sub">target for the year</div>
  </div>
</div>

<table class="is">
  <thead>
    <tr>
      <th class="first" rowspan="2">&nbsp;</th>
      <th class="group" colspan="3">Current Period</th>
      <th class="group" colspan="3">Year to Date</th>
      <th rowspan="2">Annual<br>Budget</th>
    </tr>
    <tr>
      <th>Actual</th>
      <th>Budget</th>
      <th>Var.</th>
      <th>Actual</th>
      <th>Budget</th>
      <th>Var.</th>
    </tr>
  </thead>
  <tbody>
    ${incomeSections.map(categoryBlock).join('')}
    ${grandTotalRow('Total Revenue', totals.total_revenue, 'income')}
    ${totals.total_income && totals.total_income !== totals.total_revenue ? grandTotalRow('Total Income', totals.total_income, 'income') : ''}

    ${expenseSections.map(categoryBlock).join('')}
    ${grandTotalRow('Total Expense', totals.total_expense, 'expense')}

    ${totals.operating_net ? grandTotalRow('Operating Net Total', totals.operating_net, 'income') : ''}
    ${totals.reserve_net ? grandTotalRow('Reserve Net Total', totals.reserve_net, 'income') : ''}
    ${totals.net_total && totals.net_total !== totals.operating_net ? grandTotalRow('Net Total', totals.net_total, 'income') : ''}
  </tbody>
</table>

${findingsHtml}

<div class="footer">
  Prepared by <span class="b">Bedrock Association Management</span> on behalf of ${escapeHtml(community || '')}<br>
  bedrocktx.com &nbsp;·&nbsp; (832) 588-2485
</div>

</body></html>`;
}

module.exports = { renderIncomeStatementHTML };
