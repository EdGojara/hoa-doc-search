// ============================================================================
// lib/vendors/board_memo.js
// ----------------------------------------------------------------------------
// Renders the Vendor Selection Board Memo as HTML, ready to hand to
// puppeteer for PDF generation.
//
// Per CLAUDE.md catastrophic-output discipline:
//   • Board-facing document — `mixed` ownership; the delivered PDF is
//     association_record, the underlying AI extraction is workpaper.
//   • Operator-signed recommendation — Bedrock does NOT auto-recommend
//     a vendor; the operator dictates the recommendation in their own
//     words. The renderer just packages the structured comparison +
//     recommendation + audit trail into a polished document.
//   • Transparency layer is structural: the "Bids Considered and Not
//     Recommended" appendix renders every eliminated bid + reason from
//     vendor_proposals.eliminated_reason. Operator can't ship a memo
//     that hides cuts.
//
// Brand: pulls from lib/brand.js (single source of truth — Heritage Gold
// #D4AF37, navy #0B1D34, Cormorant Garamond serif).
//
// Layout (page targets are puppeteer Letter portrait, 0.5" margins):
//   Page 1: Letterhead + recommendation summary + 3 finalists side-by-side
//   Page 2-N: Scope comparison matrix (per-item × per-vendor table)
//   Page N+1: Insurance / compliance check
//   Final: "Bids Considered and Not Recommended" — every eliminated bid
//          one-lined with operator + reason
// ============================================================================

const BRAND = require('../brand');

const NAVY        = '#0B1D34';
const GOLD        = '#D4AF37';
const INK         = '#1a1a1a';
const INK_SOFT    = '#4a4a4a';
const INK_FAINT   = '#7a7a7a';
const CREAM       = '#FAFAF6';
const RULE        = '#c8c5b8';
const PANEL_BG    = '#FBFAF3';
const RED         = '#b91c1c';
const GREEN       = '#15803d';
const AMBER       = '#92400e';

const FONT_SERIF = "'Cormorant Garamond', Georgia, serif";
const FONT_SANS  = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function fmtUSD(n) {
  if (n == null || n === '' || isNaN(n)) return '<span style="color:#999; font-style:italic;">unparsed</span>';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) { return String(d); }
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Linkify newlines for paragraph text the operator dictated
function paragraphize(s) {
  if (!s) return '';
  return esc(s).split(/\n\n+/).map((p) => `<p style="margin: 0 0 10px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('');
}

// ----------------------------------------------------------------------------
// Build the scope union — every distinct scope item across all 3 finalists,
// returned in a stable order (most common first, then alphabetical). Used
// for the apples-to-apples comparison matrix.
// ----------------------------------------------------------------------------
function buildScopeUnion(finalists) {
  const counts = new Map();
  for (const f of finalists) {
    const items = (f.extracted_data && f.extracted_data.scope_items) || [];
    for (const it of items) {
      const name = (it.name || '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const arr = Array.from(counts.entries());
  arr.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return arr.map(([name]) => name);
}

// Look up a single scope item on a finalist; returns the matching scope_item
// or null. Match is case-insensitive on name.
function findScopeItem(finalist, name) {
  const items = (finalist.extracted_data && finalist.extracted_data.scope_items) || [];
  const target = name.toLowerCase();
  return items.find((it) => (it.name || '').toLowerCase() === target) || null;
}

function renderScopeCell(item) {
  if (!item) return '<span style="color:#dc2626; font-weight:600;">✗ not included</span>';
  if (item.included === false) {
    return '<span style="color:#dc2626;">✗ excluded</span>';
  }
  const freq = item.frequency ? ` <span style="color:#999;">(${esc(item.frequency)})</span>` : '';
  const notes = item.notes ? `<br><span style="color:#666; font-size:9.5pt;">${esc(item.notes)}</span>` : '';
  return `<span style="color:#15803d;">✓</span>${freq}${notes}`;
}

// ----------------------------------------------------------------------------
// Main renderer
// data = {
//   rfp: { id, title, service_category, community: { name, ... }, ... },
//   finalists: [ vendor_proposal, ... ] (1-3 rows),
//   eliminated: [ vendor_proposal, ... ],
//   pending: [ vendor_proposal, ... ],         // mention but don't elevate
//   recommendation: { vendor_id, vendor_name, paragraph_text },
//   prepared_by: 'Ed Gojara, Bedrock Association Management',
//   prepared_at: ISO date string
// }
// ----------------------------------------------------------------------------
function renderBoardMemoHTML(data) {
  const { rfp, finalists, eliminated, recommendation, prepared_by, prepared_at } = data;
  const communityName = (rfp.community && rfp.community.name) || 'Community';
  const serviceLabel = (rfp.service_category || '').replace(/_/g, ' ');
  const memoDate = fmtDate(prepared_at || new Date());

  // Three column widths for the finalists grid (handles 1, 2, or 3)
  const colCount = Math.max(1, finalists.length);
  const colPct = (100 / colCount).toFixed(2) + '%';

  const scopeUnion = buildScopeUnion(finalists);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Vendor Selection Memo — ${esc(rfp.title || serviceLabel)} — ${esc(communityName)}</title>
<style>
  @page { size: Letter; margin: 0.5in 0.5in 0.6in 0.5in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: ${FONT_SANS}; font-size: 10.5pt; color: ${INK}; line-height: 1.5; }
  body { background: #fff; }

  /* Letterhead */
  .letterhead { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid ${GOLD}; padding-bottom: 12px; margin-bottom: 18px; }
  .lh-brand { font-family: ${FONT_SERIF}; font-weight: 600; font-size: 22pt; color: ${NAVY}; letter-spacing: 0.04em; line-height: 1; }
  .lh-brand em { font-style: normal; color: ${GOLD}; }
  .lh-meta { font-size: 9pt; color: ${INK_FAINT}; text-align: right; line-height: 1.5; }
  .lh-meta b { color: ${NAVY}; }

  /* Memo title */
  h1.memo-title { font-family: ${FONT_SERIF}; font-weight: 600; font-size: 24pt; color: ${NAVY}; margin: 0 0 4px 0; line-height: 1.1; letter-spacing: 0.01em; }
  .memo-subtitle { font-size: 11pt; color: ${INK_SOFT}; margin-bottom: 16px; }

  /* Section header */
  h2.section { font-family: ${FONT_SERIF}; font-weight: 600; font-size: 15pt; color: ${NAVY}; margin: 22px 0 8px 0; border-bottom: 1px solid ${RULE}; padding-bottom: 4px; }
  h3.subsec { font-family: ${FONT_SERIF}; font-weight: 600; font-size: 12pt; color: ${NAVY}; margin: 14px 0 6px 0; }

  /* Recommendation block */
  .rec-box { background: ${PANEL_BG}; border-left: 4px solid ${GOLD}; padding: 14px 18px; margin: 12px 0 18px 0; border-radius: 4px; }
  .rec-label { font-size: 9.5pt; font-weight: 700; color: ${GOLD}; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 4px; }
  .rec-vendor { font-family: ${FONT_SERIF}; font-weight: 600; font-size: 18pt; color: ${NAVY}; margin-bottom: 8px; line-height: 1.1; }
  .rec-text { font-size: 10.5pt; line-height: 1.55; color: ${INK}; }

  /* Finalist grid */
  table.finalists { width: 100%; border-collapse: collapse; margin: 6px 0 14px 0; }
  table.finalists th { background: ${NAVY}; color: white; padding: 8px 10px; text-align: left; font-size: 10pt; font-weight: 600; font-family: ${FONT_SANS}; }
  table.finalists th:first-child { width: 25%; }
  table.finalists td { padding: 8px 10px; border-bottom: 1px solid #e5e5dc; font-size: 10pt; vertical-align: top; }
  table.finalists td.label { background: #f9f7ee; font-weight: 600; color: ${NAVY}; width: 25%; }
  table.finalists tr.totalrow td { background: #f3eed8; font-weight: 700; color: ${NAVY}; }
  .finalist-name { font-family: ${FONT_SERIF}; font-size: 12pt; font-weight: 600; color: ${NAVY}; }
  .finalist-meta { font-size: 9pt; color: ${INK_FAINT}; }
  .winner-badge { display: inline-block; background: ${GOLD}; color: white; font-size: 8.5pt; font-weight: 700; padding: 2px 7px; border-radius: 10px; margin-left: 6px; letter-spacing: 0.05em; }

  /* Scope matrix */
  table.scope { width: 100%; border-collapse: collapse; margin: 8px 0 18px 0; }
  table.scope th { background: ${NAVY}; color: white; padding: 6px 8px; text-align: left; font-size: 9pt; font-weight: 600; font-family: ${FONT_SANS}; }
  table.scope th.itm { width: 28%; }
  table.scope td { padding: 6px 8px; border-bottom: 1px solid #ececec; font-size: 9.5pt; vertical-align: top; }
  table.scope td.itm { background: #f9f7ee; font-weight: 600; color: ${NAVY}; }

  /* Cut-list (eliminated bids) */
  table.cutlist { width: 100%; border-collapse: collapse; margin: 8px 0 14px 0; font-size: 9.5pt; }
  table.cutlist th { background: #fef2f2; color: ${RED}; padding: 6px 8px; text-align: left; font-weight: 600; border-bottom: 1px solid #fecaca; }
  table.cutlist td { padding: 6px 8px; border-bottom: 1px solid #fee2e2; vertical-align: top; }
  table.cutlist td.vendor { font-weight: 600; color: ${INK}; }
  table.cutlist td.reason { color: ${INK_SOFT}; }
  table.cutlist td.op { color: ${INK_FAINT}; font-size: 8.5pt; }

  /* Signature */
  .signature { margin-top: 28px; padding-top: 12px; border-top: 1px solid ${RULE}; font-size: 9.5pt; color: ${INK_SOFT}; }
  .signature b { color: ${NAVY}; font-size: 10.5pt; font-weight: 600; }

  /* Page-break helpers (puppeteer respects) */
  .page-break { page-break-after: always; }
  table { page-break-inside: auto; }
  tr { page-break-inside: avoid; page-break-after: auto; }
</style>
</head>
<body>

<!-- LETTERHEAD -->
<div class="letterhead">
  <div class="lh-brand">B<em>E</em>DROCK</div>
  <div class="lh-meta">
    <b>Bedrock Association Management</b><br>
    Vendor Selection Memo<br>
    ${esc(memoDate)}
  </div>
</div>

<!-- MEMO TITLE -->
<h1 class="memo-title">${esc(rfp.title || (serviceLabel.charAt(0).toUpperCase() + serviceLabel.slice(1) + ' — Vendor Selection'))}</h1>
<div class="memo-subtitle">${esc(communityName)} · ${esc(serviceLabel)}</div>

<!-- RECOMMENDATION -->
<div class="rec-box">
  <div class="rec-label">Recommendation</div>
  <div class="rec-vendor">${esc(recommendation && recommendation.vendor_name) || '(no recommendation selected)'}</div>
  <div class="rec-text">${paragraphize(recommendation && recommendation.paragraph_text)}</div>
</div>

<!-- FINALISTS SIDE-BY-SIDE -->
<h2 class="section">Finalists</h2>
<table class="finalists">
  <thead><tr>
    <th>&nbsp;</th>
    ${finalists.map((f) => `<th style="width:${colPct};">
      <div class="finalist-name">${esc(f.proposer_company_name || '(unparsed)')}${recommendation && recommendation.vendor_id === f.id ? '<span class="winner-badge">RECOMMENDED</span>' : ''}</div>
    </th>`).join('')}
  </tr></thead>
  <tbody>
    <tr class="totalrow">
      <td class="label">Total annual cost</td>
      ${finalists.map((f) => `<td>${fmtUSD(f.total_annual_amount)}</td>`).join('')}
    </tr>
    <tr>
      <td class="label">Term (months)</td>
      ${finalists.map((f) => `<td>${f.term_months ? esc(String(f.term_months)) : '—'}</td>`).join('')}
    </tr>
    <tr>
      <td class="label">Escalator clause</td>
      ${finalists.map((f) => `<td>${esc((f.extracted_data && f.extracted_data.escalator_clause) || '—')}</td>`).join('')}
    </tr>
    <tr>
      <td class="label">Crew / capacity</td>
      ${finalists.map((f) => `<td>${esc((f.extracted_data && f.extracted_data.crew_size_or_capacity) || '—')}</td>`).join('')}
    </tr>
    <tr>
      <td class="label">Warranty</td>
      ${finalists.map((f) => `<td>${esc((f.extracted_data && f.extracted_data.warranty_terms) || '—')}</td>`).join('')}
    </tr>
    <tr>
      <td class="label">References supplied</td>
      ${finalists.map((f) => {
        const refs = (f.extracted_data && f.extracted_data.references) || [];
        if (!refs.length) return `<td><span style="color:${RED};">none on file</span></td>`;
        return `<td>${refs.slice(0, 3).map(r => esc(r.community_or_client || 'unnamed')).join('<br>')}${refs.length > 3 ? `<br><span style="color:#999;">+${refs.length - 3} more</span>` : ''}</td>`;
      }).join('')}
    </tr>
    <tr>
      <td class="label">Proposal contact</td>
      ${finalists.map((f) => {
        const e = (f.extracted_data && f.extracted_data.submitter_name) || '';
        const em = (f.extracted_data && f.extracted_data.submitter_email) || '';
        return `<td>${esc(e)}${em ? `<br><span style="color:#666;">${esc(em)}</span>` : ''}</td>`;
      }).join('')}
    </tr>
  </tbody>
</table>

${scopeUnion.length === 0 ? '' : `
<!-- SCOPE COMPARISON MATRIX -->
<h2 class="section">Scope comparison</h2>
<table class="scope">
  <thead><tr>
    <th class="itm">Scope item</th>
    ${finalists.map((f) => `<th>${esc(f.proposer_company_name || '(unparsed)')}</th>`).join('')}
  </tr></thead>
  <tbody>
    ${scopeUnion.map((name) => `<tr>
      <td class="itm">${esc(name)}</td>
      ${finalists.map((f) => `<td>${renderScopeCell(findScopeItem(f, name))}</td>`).join('')}
    </tr>`).join('')}
  </tbody>
</table>
`}

<!-- INSURANCE -->
<h2 class="section">Insurance &amp; compliance</h2>
<table class="finalists">
  <thead><tr>
    <th>&nbsp;</th>
    ${finalists.map((f) => `<th style="width:${colPct};">${esc(f.proposer_company_name || '(unparsed)')}</th>`).join('')}
  </tr></thead>
  <tbody>
    ${['GL', 'workers_comp', 'auto', 'umbrella'].map((typeKey) => `<tr>
      <td class="label">${esc({ GL: 'General Liability', workers_comp: 'Workers Comp', auto: 'Auto', umbrella: 'Umbrella' }[typeKey] || typeKey)}</td>
      ${finalists.map((f) => {
        const policies = (f.extracted_data && f.extracted_data.insurance_policies) || [];
        const p = policies.find((x) => (x.type || '').toLowerCase().includes(typeKey.toLowerCase().split('_')[0]));
        if (!p) return `<td><span style="color:${RED};">not on file</span></td>`;
        const limit = p.limit_per_occurrence ? fmtUSD(p.limit_per_occurrence) : '—';
        const exp = p.expires_at ? fmtDate(p.expires_at) : '—';
        return `<td>${limit}<br><span style="color:#666; font-size:9pt;">expires ${exp}</span></td>`;
      }).join('')}
    </tr>`).join('')}
  </tbody>
</table>

${eliminated.length === 0 ? '' : `
<!-- CUT LIST — TRANSPARENCY APPENDIX -->
<h2 class="section">Bids considered and not recommended</h2>
<p style="font-size:10pt; color:${INK_SOFT}; margin: 0 0 10px 0;">The Board was presented with ${finalists.length + eliminated.length} total bids for this RFP. The ${finalists.length} finalists above were selected from this set; the bids below were considered but eliminated. Reason captured at the time of decision is shown verbatim.</p>
<table class="cutlist">
  <thead><tr>
    <th style="width: 28%;">Vendor</th>
    <th style="width: 14%;">Bid (annual)</th>
    <th>Reason eliminated</th>
    <th style="width: 18%;">Decided by / when</th>
  </tr></thead>
  <tbody>
    ${eliminated.map((b) => `<tr>
      <td class="vendor">${esc(b.proposer_company_name || '(unparsed)')}</td>
      <td>${fmtUSD(b.total_annual_amount)}</td>
      <td class="reason">${esc(b.eliminated_reason || '(no reason recorded — data integrity issue)')}</td>
      <td class="op">${esc(b.eliminated_by || '?')}<br>${esc(fmtDate(b.eliminated_at))}</td>
    </tr>`).join('')}
  </tbody>
</table>
`}

<!-- SIGNATURE -->
<div class="signature">
  Prepared by:<br>
  <b>${esc(prepared_by || 'Bedrock Association Management')}</b><br>
  ${esc(memoDate)}
</div>

</body>
</html>`;
}

module.exports = { renderBoardMemoHTML };
