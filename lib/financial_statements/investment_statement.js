// Investment / Reserve Performance template — renders a Bedrock-branded
// summary of a brokerage statement (Edward Jones, Schwab, Vanguard, etc.).
// Same letterhead pattern as balance_sheet.js so the monthly package reads
// as one coherent document produced by Bedrock — the AI underneath is invisible.

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
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v < 0 ? '($' : '$') +
    Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    (v < 0 ? ')' : '');
}

function fmtMoneyShort(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v < 0 ? '($' : '$') +
    Math.round(Math.abs(v)).toLocaleString('en-US') +
    (v < 0 ? ')' : '');
}

function fmtPct(d, places = 1) {
  if (d == null) return '—';
  const v = Number(d);
  if (!Number.isFinite(v)) return '—';
  const pct = (v * 100).toFixed(places);
  return (v >= 0 ? '+' : '') + pct + '%';
}

const FINDING_STYLES = {
  good:  { icon: '✓', color: '#15803d' },
  note:  { icon: '•', color: '#475569' },
  warn:  { icon: '⚠', color: '#a16207' },
  alert: { icon: '🛑', color: '#b91c1c' },
};

const ALLOC_LABELS = {
  cash:         'Cash',
  money_market: 'Money Market',
  fixed_income: 'Fixed Income',
  equities:     'Equities',
  other:        'Other',
};

const ALLOC_COLORS = {
  cash:         '#84a98c',
  money_market: '#cad2c5',
  fixed_income: '#52796f',
  equities:     '#1E2761',
  other:        '#94A3B8',
};

function renderInvestmentStatementHTML({ community, data = {}, findings = [] }) {
  const logo = getCommunityLogo(community);
  const periodLabel = data.period_label || '';
  const custodian = data.custodian || 'Investment Account';
  const accountType = data.account_type || '';
  const accountValue = data.account_value;
  const allocation = data.allocation || {};
  const returns = data.returns || {};

  // Build allocation rows (only include classes with non-zero values)
  const allocOrder = ['cash', 'money_market', 'fixed_income', 'equities', 'other'];
  const allocRows = allocOrder
    .filter((k) => allocation[k] && allocation[k].value != null && Number(allocation[k].value) !== 0)
    .map((k) => {
      const v = allocation[k];
      const valNum = Number(v.value) || 0;
      const pctNum = v.percent != null
        ? Number(v.percent)
        : (accountValue ? (valNum / Number(accountValue)) * 100 : 0);
      const barWidth = Math.max(0, Math.min(100, pctNum));
      return `
        <tr>
          <td class="alloc-label"><span class="swatch" style="background:${ALLOC_COLORS[k]};"></span>${ALLOC_LABELS[k]}</td>
          <td class="alloc-bar">
            <div class="bar-track"><div class="bar-fill" style="width:${barWidth}%; background:${ALLOC_COLORS[k]};"></div></div>
          </td>
          <td class="alloc-pct">${pctNum.toFixed(1)}%</td>
          <td class="alloc-val">${escapeHtml(fmtMoney(valNum))}</td>
        </tr>
      `;
    }).join('');

  // Returns row — show whatever we have
  const returnsCells = [
    { label: 'MTD',    val: returns.month_to_date },
    { label: 'YTD',    val: returns.year_to_date },
    { label: '3 mo',   val: returns.three_month },
    { label: '6 mo',   val: returns.six_month },
    { label: '12 mo',  val: returns.twelve_month },
  ].filter((r) => r.val != null);

  const returnsHtml = returnsCells.length > 0
    ? `
      <div class="returns-row">
        ${returnsCells.map((r) => {
          const v = Number(r.val);
          const cls = v >= 0 ? 'pos' : 'neg';
          return `
            <div class="return-card">
              <div class="return-label">${r.label}</div>
              <div class="return-val ${cls}">${escapeHtml(fmtPct(v))}</div>
            </div>
          `;
        }).join('')}
      </div>
    `
    : '';

  const findingsHtml = findings.length > 0
    ? `
      <div class="findings">
        <div class="findings-title">Bedrock Observations</div>
        ${findings.map((f) => {
          const s = FINDING_STYLES[f.severity] || FINDING_STYLES.note;
          return `<div class="finding"><span class="f-icon" style="color:${s.color};">${s.icon}</span> ${escapeHtml(f.text || '')}</div>`;
        }).join('')}
        <div class="findings-disclaimer">These observations are commentary from Bedrock Association Management for operational use by the Board and Treasurer. They do not constitute investment advice, a review, or any form of assurance opinion.</div>
      </div>
    `
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.7in 0.85in 0.85in 0.85in; }
  body { font-family: Georgia, Cambria, "Times New Roman", serif; color: #1a1a1a; font-size: 11pt; line-height: 1.45; margin: 0; }

  .header { text-align: center; padding-bottom: 14px; border-bottom: 2px solid #1E2761; margin-bottom: 22px; }
  .header img { max-height: 95px; max-width: 220px; display: block; margin: 0 auto 10px; }
  .header .community { font-size: 18pt; font-weight: 700; color: #1E2761; }
  .header .doc-type { font-size: 11pt; color: #475569; letter-spacing: 3px; margin-top: 4px; text-transform: uppercase; font-weight: 600; }
  .header .period { font-size: 11pt; color: #1a1a1a; margin-top: 6px; font-style: italic; }

  .hero { display: flex; justify-content: space-between; align-items: stretch; gap: 24px; margin-bottom: 24px; padding: 16px 20px; background: #f8fafc; border-left: 4px solid #1E2761; border-radius: 0 8px 8px 0; }
  .hero .acct-info { flex: 1; }
  .hero .acct-label { font-size: 10pt; color: #475569; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; font-family: Calibri, Arial, sans-serif; }
  .hero .acct-name { font-size: 14pt; font-weight: 700; color: #1E2761; margin-top: 4px; }
  .hero .acct-sub { font-size: 10pt; color: #475569; margin-top: 2px; font-style: italic; }
  .hero .acct-value-wrap { text-align: right; flex: 0 0 auto; }
  .hero .acct-value-label { font-size: 9pt; color: #475569; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; font-family: Calibri, Arial, sans-serif; }
  .hero .acct-value { font-size: 22pt; font-weight: 700; color: #1E2761; margin-top: 4px; font-family: Georgia, serif; }

  .section-title { font-family: Calibri, Arial, sans-serif; font-size: 12pt; font-weight: 700; color: #1E2761; margin: 14px 0 8px; letter-spacing: 0.3px; text-transform: uppercase; }

  .returns-row { display: flex; gap: 8px; margin-bottom: 18px; }
  .return-card { flex: 1; padding: 10px 12px; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; text-align: center; }
  .return-label { font-size: 9pt; color: #475569; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; font-family: Calibri, Arial, sans-serif; }
  .return-val { font-size: 14pt; font-weight: 700; margin-top: 4px; font-family: Georgia, serif; }
  .return-val.pos { color: #15803d; }
  .return-val.neg { color: #b91c1c; }

  table.alloc { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  table.alloc td { padding: 7px 8px; vertical-align: middle; font-size: 10.5pt; }
  table.alloc td.alloc-label { width: 25%; font-weight: 600; color: #1a1a1a; }
  table.alloc td.alloc-bar { width: 45%; }
  table.alloc td.alloc-pct { width: 12%; text-align: right; font-variant-numeric: tabular-nums; color: #475569; }
  table.alloc td.alloc-val { width: 18%; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar-track { width: 100%; height: 10px; background: #e2e8f0; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; transition: width 0.3s; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: middle; }

  .findings { margin-top: 24px; padding: 14px 18px; background: #f8fafc; border-left: 3px solid #1E2761; border-radius: 0 6px 6px 0; }
  .findings-title { font-family: Calibri, Arial, sans-serif; font-size: 10pt; color: #1E2761; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
  .finding { font-size: 10.5pt; margin: 6px 0; color: #1a1a1a; line-height: 1.5; }
  .finding .f-icon { display: inline-block; width: 18px; font-weight: 700; }
  .findings-disclaimer { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #cbd5e1; font-size: 8.5pt; color: #64748b; font-style: italic; line-height: 1.35; }

  .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 9pt; color: #94a3b8; }
  .footer .b { color: #1E2761; font-weight: 700; }
</style></head><body>

<div class="header">
  ${logo ? `<img src="${logo}" alt="${escapeHtml(community)}">` : ''}
  <div class="community">${escapeHtml(community || '')}</div>
  <div class="doc-type">Reserve Performance</div>
  ${periodLabel ? `<div class="period">${escapeHtml(periodLabel)}</div>` : ''}
</div>

<div class="hero">
  <div class="acct-info">
    <div class="acct-label">Account</div>
    <div class="acct-name">${escapeHtml(custodian)}</div>
    ${accountType ? `<div class="acct-sub">${escapeHtml(accountType)}</div>` : ''}
  </div>
  <div class="acct-value-wrap">
    <div class="acct-value-label">Period-end value</div>
    <div class="acct-value">${escapeHtml(fmtMoneyShort(accountValue))}</div>
  </div>
</div>

${returnsCells.length > 0 ? `<div class="section-title">Returns</div>${returnsHtml}` : ''}

${allocRows ? `<div class="section-title">Allocation</div><table class="alloc"><tbody>${allocRows}</tbody></table>` : ''}

${findingsHtml}

<div class="footer">
  Prepared by <span class="b">Bedrock Association Management</span> on behalf of ${escapeHtml(community || '')}<br>
  bedrocktx.com &nbsp;·&nbsp; (832) 588-2485
</div>

</body></html>`;
}

module.exports = { renderInvestmentStatementHTML };
