// ============================================================================
// Board Packets — Bedrock board packet generator
// ----------------------------------------------------------------------------
// Endpoints under /api/board-packets to assemble Bedrock-branded board meeting
// packets. "Build the workflow, stub the data" pattern: each section accepts
// manual / upload / auto-from-trustEd input modes. The "auto" mode is stubbed
// today; gets wired to live modules (financials, vendors, contracts) later.
//
//   POST   /                              create new draft packet
//   GET    /                              list packets (filter by community/status)
//   GET    /:id                           packet + sections detail
//   PATCH  /:id                           update packet metadata
//   DELETE /:id                           delete packet
//
//   GET    /templates                     canonical section templates
//
//   PATCH  /:id/sections/:section_key     update a section's input_data / mode
//   POST   /:id/sections/:section_key/upload     upload PDF for a section
//   POST   /:id/sections/:section_key/auto-fill  auto-fill from trustEd (stub today)
//   POST   /:id/sections/:section_key/ai-generate  AI writes the section content
//
//   POST   /:id/render                    generate final HTML packet
//   GET    /:id/preview                   view rendered HTML inline
//   GET    /:id/download                  download rendered PDF (Day 3)
//
//   POST   /:id/distribute                log a distribution event
//   GET    /:id/distribution              distribution log
//
// Design principles applied:
//   - Frustration Test: pick community + period, get 11 sections waiting, fill or skip
//   - Calm Test: section status indicators show what's done / pending at a glance
//   - Proactive Guidance: AI watch-outs surface issues before the meeting
//   - askEd template voice: AI-generated copy uses Action/Output/Reasoning/Watch Outs
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const BRAND = require('../lib/brand');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// Community visual assets (logo + hero image) per the Bedrock design system.
// Hardcoded for now (only 3 communities have full assets); later this moves
// to a logo_path / hero_path column on the communities table so Ed can
// upload new community photos from the UI.
// ----------------------------------------------------------------------------
const COMMUNITY_ASSETS = {
  'Lakes of Pine Forest': {
    hero: '/photos/communities/LPF_hero.jpg',
    logo: '/logos/lakes_of_pine_forest_logo.png',
    legal_suffix: 'Homeowners Association'
  },
  'Canyon Gate at Cinco Ranch': {
    hero: null,
    logo: '/logos/canyon_gate_logo.png',
    legal_suffix: 'Homeowners Association'
  },
  'Waterview Estates': {
    hero: null,
    logo: '/logos/waterview_logo.jpg',
    legal_suffix: 'Homeowners Association'
  }
};

function getCommunityAssets(communityName) {
  return COMMUNITY_ASSETS[communityName] || { hero: null, logo: null, legal_suffix: '' };
}

// Build the per-community asset set used by the renderer. Prefers a logo
// uploaded via the Community Settings panel (community.logo_signed_url) over
// any hard-coded file in COMMUNITY_ASSETS — so every association controls
// its own brand without a code change.
function resolveCommunityAssets(community) {
  const fromMap = getCommunityAssets(community && community.name);
  const uploadedLogo = community && community.logo_signed_url ? community.logo_signed_url : null;
  return {
    hero: fromMap.hero,
    logo: uploadedLogo || fromMap.logo,
    legal_suffix: fromMap.legal_suffix,
    has_custom_logo: !!uploadedLogo,
  };
}

// ----------------------------------------------------------------------------
// Money + variance helpers used by the polished per-section renderers
// ----------------------------------------------------------------------------
function fmtMoney(n, opts = {}) {
  if (n == null || Number.isNaN(Number(n))) return opts.dash || '—';
  const negative = Number(n) < 0;
  const abs = Math.abs(Number(n));
  const out = abs.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: opts.precision != null ? opts.precision : 2, maximumFractionDigits: opts.precision != null ? opts.precision : 2 });
  return negative ? `(${out})` : out;
}
function pct(numerator, denominator) {
  if (!denominator || Number(denominator) === 0) return null;
  return (Number(numerator) / Number(denominator)) * 100;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '(date TBD)';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) { return String(d); }
}

function fmtDateShort(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) { return String(d); }
}

// ============================================================================
// PER-SECTION STANDALONE RENDERERS
// ----------------------------------------------------------------------------
// Each section can be previewed individually so operators see exactly what
// the board will see before approving the packet. The renderer dispatches
// on section_key — financial section gets the full polished treatment
// (logo header, narrative callout, revenue/expense tables, budget variance,
// cash card, "from our records" sources line). Other sections fall back
// to a generic Bedrock-branded card.
//
// The "from our records" framing intentionally hides the mechanism (we don't
// say "extracted from Vantaca PDF via AI vision" on the board-facing page —
// to the board, this is Bedrock institutional data).
// ============================================================================

function renderSectionStandaloneHtml({ packet, section, embed = false }) {
  if (section.section_key === 'financials') {
    return renderFinancialStatementsStandaloneHtml({ packet, section, embed });
  }
  if (section.section_key === 'ar_aging') {
    return renderArAgingStandaloneHtml({ packet, section, embed });
  }
  // 'drv' = Deed Restriction Violations. Pre-migration-069 it was mislabeled
  // as "Doctivity Variance Report" (budget variance). Now consolidated:
  // one section, properly named, using the violations workflow.
  if (section.section_key === 'drv') {
    return renderViolationsSummaryStandaloneHtml({ packet, section, embed });
  }
  return renderGenericSectionStandaloneHtml({ packet, section, embed });
}

// Shared HTML shell — header lockup (community logo + Bedrock cornerstone),
// styles, footer. Body content slots in via the `bodyHtml` arg.
function renderStandalonePage({ packet, section, bodyHtml, accent = '#1F3A5F', embed = false }) {
  const community = packet.community || {};
  const assets = resolveCommunityAssets(community);
  const hoaName = community.legal_name || (community.name ? `${community.name} Homeowners Association` : 'Your Association');
  const periodLabel = packet.period_label || '';
  const meetingDate = packet.meeting_date ? fmtDate(packet.meeting_date) : '';
  const title = (section.template && section.template.display_name) || section.section_key;

  // Embed mode: the page is being shown inside a packet iframe that already
  // has its own community header + section title. Drop the outer .page card,
  // the header lockup, and the sources footer — just emit the styled body.
  // Auto-height the document so the parent can resize the iframe to fit.
  if (embed) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(hoaName)} — ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    color: #1a1a1a; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; font-feature-settings: "tnum" 1; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  :root {
    --navy: #1F3A5F; --navy-deep: #14283F; --navy-tint: #EAF0F7;
    --gold: #D4AF37; --gold-tint: #FFFBEB;
    --ink: #1a1a1a; --ink-soft: #4a4a4a; --ink-muted: #888;
    --rule: #E5E7EB; --paper: #ffffff;
    --good: #166534; --good-tint: #DCFCE7;
    --bad: #B91C1C; --bad-tint: #FEE2E2;
  }
  * { box-sizing: border-box; }
  .embed-body { padding: 0; }
  .narrative { background: var(--gold-tint); border-left: 4px solid var(--gold); padding: 14px 18px; border-radius: 0 8px 8px 0; margin: 0 0 18px 0; font-size: 14px; color: var(--ink); line-height: 1.65; }
  .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 12px 0 18px; }
  .kpi-card { background: var(--navy-tint); border: 1px solid var(--rule); border-radius: 8px; padding: 14px 16px; }
  .kpi-card .label { font-size: 11px; font-weight: 700; color: var(--navy); text-transform: uppercase; letter-spacing: 0.08em; }
  .kpi-card .value { font-size: 22px; font-weight: 800; color: var(--navy-deep); margin-top: 6px; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .kpi-card .delta { font-size: 11px; font-weight: 600; margin-top: 4px; }
  .kpi-card .delta.good { color: var(--good); }
  .kpi-card .delta.bad { color: var(--bad); }
  .data-table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
  .data-table thead th { background: var(--navy-tint); color: var(--navy); font-weight: 700; text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--navy); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .data-table thead th.num { text-align: right; }
  .data-table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--rule); font-variant-numeric: tabular-nums; }
  .data-table tbody td.num { text-align: right; }
  .data-table tbody tr:nth-child(even) { background: #fafbfc; }
  .data-table tfoot td { padding: 9px 10px; border-top: 2px solid var(--navy); font-weight: 800; color: var(--navy); background: var(--navy-tint); font-variant-numeric: tabular-nums; }
  .data-table tfoot td.num { text-align: right; }
  .variance-bar { display: inline-block; height: 6px; min-width: 4px; border-radius: 3px; vertical-align: middle; margin-left: 6px; }
  .table-h2 { font-size: 14px; font-weight: 700; color: var(--navy); text-transform: uppercase; letter-spacing: 0.06em; margin: 22px 0 6px; }
</style>
</head>
<body>
<div class="embed-body">
  ${bodyHtml}
</div>
<script>
  // Tell the parent how tall this iframe needs to be so it can resize.
  function _postHeight() {
    var h = document.documentElement.scrollHeight;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ kind: 'bp-section-iframe-height', height: h }, '*');
    }
  }
  window.addEventListener('load', _postHeight);
  // Recompute on font-load (Inter takes a beat) and on resize.
  document.fonts && document.fonts.ready && document.fonts.ready.then(_postHeight);
  window.addEventListener('resize', _postHeight);
</script>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(hoaName)} — ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --navy: #1F3A5F;
    --navy-deep: #14283F;
    --navy-tint: #EAF0F7;
    --gold: #D4AF37;
    --gold-tint: #FFFBEB;
    --ink: #1a1a1a;
    --ink-soft: #4a4a4a;
    --ink-muted: #888;
    --rule: #E5E7EB;
    --paper: #ffffff;
    --good: #166534;
    --good-tint: #DCFCE7;
    --bad: #B91C1C;
    --bad-tint: #FEE2E2;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: #f4f5f7; color: var(--ink);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; font-feature-settings: "tnum" 1; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 880px; margin: 24px auto; background: var(--paper); border: 1px solid var(--rule); border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(15,23,42,0.06); }
  .page-header { display: flex; align-items: center; gap: 14px; padding: 18px 28px; border-bottom: 2px solid ${accent}; background: linear-gradient(180deg, #fff 0%, #fafbfc 100%); }
  .page-header .logo-box { width: 64px; height: 64px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: #fff; border-radius: 8px; padding: 4px; }
  .page-header .logo-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .page-header .meta { flex: 1; min-width: 0; }
  .page-header .hoa-name { font-size: 18px; font-weight: 700; color: var(--navy); line-height: 1.2; }
  .page-header .sub { font-size: 12px; color: var(--ink-muted); margin-top: 3px; }
  .page-header .br-mark { font-size: 11px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.1em; }
  .page-header .br-mark strong { color: var(--gold); font-weight: 800; }
  .section-title { padding: 22px 28px 0 28px; }
  .section-title h1 { font-size: 26px; font-weight: 800; color: var(--navy); margin: 0 0 4px; letter-spacing: -0.02em; }
  .section-title .period { font-size: 13px; color: var(--ink-muted); }
  .section-body { padding: 18px 28px 28px; }
  .narrative { background: var(--gold-tint); border-left: 4px solid var(--gold); padding: 14px 18px; border-radius: 0 8px 8px 0; margin: 18px 0; font-size: 14px; color: var(--ink); line-height: 1.65; }
  .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 18px 0; }
  .kpi-card { background: var(--navy-tint); border: 1px solid var(--rule); border-radius: 8px; padding: 14px 16px; }
  .kpi-card .label { font-size: 11px; font-weight: 700; color: var(--navy); text-transform: uppercase; letter-spacing: 0.08em; }
  .kpi-card .value { font-size: 22px; font-weight: 800; color: var(--navy-deep); margin-top: 6px; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .kpi-card .delta { font-size: 11px; font-weight: 600; margin-top: 4px; }
  .kpi-card .delta.good { color: var(--good); }
  .kpi-card .delta.bad { color: var(--bad); }
  .data-table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
  .data-table thead th { background: var(--navy-tint); color: var(--navy); font-weight: 700; text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--navy); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .data-table thead th.num { text-align: right; }
  .data-table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--rule); font-variant-numeric: tabular-nums; }
  .data-table tbody td.num { text-align: right; }
  .data-table tbody tr:nth-child(even) { background: #fafbfc; }
  .data-table tfoot td { padding: 9px 10px; border-top: 2px solid var(--navy); font-weight: 800; color: var(--navy); background: var(--navy-tint); font-variant-numeric: tabular-nums; }
  .data-table tfoot td.num { text-align: right; }
  .variance-bar { display: inline-block; height: 6px; min-width: 4px; border-radius: 3px; vertical-align: middle; margin-left: 6px; }
  .table-h2 { font-size: 14px; font-weight: 700; color: var(--navy); text-transform: uppercase; letter-spacing: 0.06em; margin: 22px 0 6px; }
  .sources { font-size: 11px; color: var(--ink-muted); font-style: italic; padding: 14px 28px 22px; border-top: 1px dashed var(--rule); background: #fafbfc; }
  .sources strong { color: var(--ink-soft); font-style: normal; }
</style>
</head>
<body>
<div class="page">
  <header class="page-header">
    <div class="logo-box">
      ${assets.logo ? `<img src="${esc(assets.logo)}" alt="${esc(hoaName)}">` : `<div style="color:var(--navy); font-weight:800; font-size:11px; text-align:center;">${esc(community.name || '')}</div>`}
    </div>
    <div class="meta">
      <div class="hoa-name">${esc(hoaName)}</div>
      <div class="sub">${esc(periodLabel)}${meetingDate ? ` · Meeting ${esc(meetingDate)}` : ''}</div>
    </div>
    <div class="br-mark">Managed by <strong>Bedrock</strong></div>
  </header>
  <div class="section-title">
    <h1>${esc(title)}</h1>
    ${(section.template && section.template.description) ? `<div class="period">${esc(section.template.description)}</div>` : ''}
  </div>
  <div class="section-body">
    ${bodyHtml}
  </div>
  <div class="sources">
    Reflects current Association financial records as of ${esc(periodLabel)}. Maintained by ${esc(BRAND.service.legal)} on behalf of the ${esc(community.name || 'Association')} Board of Directors.
  </div>
</div>
</body>
</html>`;
}

function renderFinancialStatementsStandaloneHtml({ packet, section, embed = false }) {
  const d = section.input_data || {};
  const narrative = d.narrative || null;

  // Normalize into BS + IS objects. Supports two data shapes:
  //   - New: input_data.balance_sheet + input_data.income_statement (rich)
  //   - Legacy: flat fields on input_data (line_items, total_revenue, etc.)
  // The renderer treats either consistently.
  const bs = d.balance_sheet || null;
  const is = d.income_statement || {
    period_label: d.current_period_label || (packet.period_label || ''),
    total_revenue: d.total_revenue,
    total_expense: d.total_expense,
    net_income: d.net_income,
    current_period: d.current_period,
    by_fund: null,
    trailing_months: Array.isArray(d.trailing_months) ? d.trailing_months : [],
    line_items: Array.isArray(d.line_items) ? d.line_items : [],
  };

  const currentLabel = d.current_period_label || is.period_label || (packet.period_label || '');
  const lineItems = Array.isArray(is.line_items) ? is.line_items : [];
  const trailing = Array.isArray(is.trailing_months) ? is.trailing_months : [];
  const isTrend = trailing.length >= 3;
  const currentPeriod = is.current_period || null;

  // Income-statement totals + per-fund totals
  const totalRev = is.total_revenue != null ? Number(is.total_revenue) : null;
  const totalExp = is.total_expense != null ? Number(is.total_expense) : null;
  const netIncome = is.net_income != null ? Number(is.net_income) : null;
  const monthlyAvgNet = isTrend && netIncome != null ? netIncome / trailing.length : null;

  const revenueRows = lineItems.filter((x) => x && x.type === 'revenue');
  const expenseRows = lineItems.filter((x) => x && x.type === 'expense');
  const sumActual = (rows) => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const sumBudget = (rows) => rows.reduce((s, r) => s + (Number(r.budget) || 0), 0);
  const revTotal = totalRev != null ? totalRev : sumActual(revenueRows);
  const revBudget = sumBudget(revenueRows);
  const expTotal = totalExp != null ? totalExp : sumActual(expenseRows);
  const expBudget = sumBudget(expenseRows);
  const niBudget = revBudget - expBudget;
  const niActual = netIncome != null ? netIncome : (revTotal - expTotal);
  const niVariance = niActual - niBudget;
  const niVarPct = pct(niVariance, Math.abs(niBudget || 0));

  // Per-fund summary — derived from is.by_fund (preferred) OR by aggregating
  // line_items.fund when present. Falls back to "operating-only" attribution
  // for legacy data with no fund tags.
  function fundTotals(fundKey) {
    if (is.by_fund && is.by_fund[fundKey]) {
      const f = is.by_fund[fundKey];
      return {
        revenue: f.revenue != null ? Number(f.revenue) : null,
        expense: f.expense != null ? Number(f.expense) : null,
        net:     f.net     != null ? Number(f.net)     : null,
      };
    }
    const fundLineItems = lineItems.filter((r) => r.fund === fundKey);
    if (fundLineItems.length === 0 && fundKey !== 'operating') return { revenue: null, expense: null, net: null };
    if (fundLineItems.length === 0 && fundKey === 'operating') {
      return { revenue: revTotal, expense: expTotal, net: niActual };
    }
    const r = sumActual(fundLineItems.filter((x) => x.type === 'revenue'));
    const e = sumActual(fundLineItems.filter((x) => x.type === 'expense'));
    return { revenue: r, expense: e, net: r - e };
  }
  const fundOperating = fundTotals('operating');
  const fundReserves  = fundTotals('reserves');
  const fundSavings   = fundTotals('savings');

  // BS fund cash summary — preferred source for the headline cash card
  const bsFundCash = bs && bs.fund_cash_summary ? bs.fund_cash_summary : null;
  const cashOp  = bsFundCash && bsFundCash.operating != null ? Number(bsFundCash.operating)
                : (d.cash_operating != null ? Number(d.cash_operating) : null);
  const cashRes = bsFundCash && bsFundCash.reserves != null ? Number(bsFundCash.reserves)
                : (d.cash_reserves != null ? Number(d.cash_reserves) : null);
  const cashSav = bsFundCash && bsFundCash.savings != null ? Number(bsFundCash.savings) : null;

  // ---------- BALANCE SHEET helpers (fund-balance layout) ----------
  // Vantaca BS has 4 columns: Operating · Reserve · Savings · Total.
  // Each row populates one or more fund columns; blanks render as '—'.
  // Section subtotal rows + grand totals match the source PDF structure.
  function bsCell(v) {
    return v == null ? '<td class="num" style="color:var(--ink-muted);">—</td>' : `<td class="num">${fmtMoney(Number(v))}</td>`;
  }
  function bsRow(r) {
    return `<tr>
      <td>${esc(r.account || '(unnamed)')}</td>
      ${bsCell(r.operating)}
      ${bsCell(r.reserve)}
      ${bsCell(r.savings)}
      <td class="num" style="font-weight:600;">${fmtMoney(Number(r.total) || 0)}</td>
    </tr>`;
  }
  function bsSubtotalRow(label, t) {
    return `<tr style="background:#fafbfc;">
      <td style="font-weight:700; color:var(--navy);">${esc(label)}</td>
      <td class="num" style="font-weight:700;">${t.operating != null ? fmtMoney(Number(t.operating)) : '—'}</td>
      <td class="num" style="font-weight:700;">${t.reserve != null ? fmtMoney(Number(t.reserve)) : '—'}</td>
      <td class="num" style="font-weight:700;">${t.savings != null ? fmtMoney(Number(t.savings)) : '—'}</td>
      <td class="num" style="font-weight:800; color:var(--navy);">${fmtMoney(Number(t.total) || 0)}</td>
    </tr>`;
  }
  function bsGrandTotalRow(label, t) {
    return `<tr>
      <td style="font-weight:800; color:var(--navy);">${esc(label)}</td>
      <td class="num" style="font-weight:800;">${t.operating != null ? fmtMoney(Number(t.operating)) : '—'}</td>
      <td class="num" style="font-weight:800;">${t.reserve != null ? fmtMoney(Number(t.reserve)) : '—'}</td>
      <td class="num" style="font-weight:800;">${t.savings != null ? fmtMoney(Number(t.savings)) : '—'}</td>
      <td class="num" style="font-weight:900; color:var(--navy);">${fmtMoney(Number(t.total) || 0)}</td>
    </tr>`;
  }
  function bsSection(title, rows, subtotals, grandTotal) {
    if ((!rows || rows.length === 0) && (!grandTotal)) return '';
    // Group rows by sub_section and interleave with subtotals when available
    const grouped = [];
    if (rows && rows.length) {
      const seen = new Set();
      for (const r of rows) {
        const key = r.sub_section || '';
        if (!seen.has(key)) {
          grouped.push({ section: key, rows: [], subtotal: null });
          seen.add(key);
        }
        grouped[grouped.length - 1].rows.push(r);
      }
      // Attach subtotals to matching sections
      if (Array.isArray(subtotals)) {
        for (const st of subtotals) {
          const g = grouped.find((x) => x.section === st.section);
          if (g) g.subtotal = st;
        }
      }
    }
    return `
      <div class="table-h2">${esc(title)}</div>
      <table class="data-table">
        <thead><tr>
          <th>Account</th>
          <th class="num">Operating</th>
          <th class="num">Reserve</th>
          <th class="num">Savings</th>
          <th class="num">Total</th>
        </tr></thead>
        <tbody>
          ${grouped.map((g) => `
            ${g.section ? `<tr style="background:#f1f5fb;"><td colspan="5" style="font-weight:700; color:var(--navy); padding:6px 10px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">${esc(g.section)}</td></tr>` : ''}
            ${g.rows.map(bsRow).join('')}
            ${g.subtotal ? bsSubtotalRow('Total ' + (g.section || title).toLowerCase(), g.subtotal) : ''}
          `).join('')}
        </tbody>
        ${grandTotal ? `<tfoot>${bsGrandTotalRow('Total ' + title.toLowerCase(), grandTotal)}</tfoot>` : ''}
      </table>`;
  }

  // ---------- INCOME-STATEMENT helpers ----------
  function rowsWithVariance(rows) {
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs((Number(r.amount) || 0) - (Number(r.budget) || 0))), 1);
    return rows.map((r) => {
      const amt = Number(r.amount) || 0;
      const bud = r.budget != null ? Number(r.budget) : null;
      const variance = bud != null ? amt - bud : null;
      const barW = bud != null ? Math.min(60, Math.round((Math.abs(variance) / maxAbs) * 60)) : 0;
      const varianceFavorable = variance != null && (
        (r.type === 'revenue' && variance >= 0) || (r.type === 'expense' && variance <= 0)
      );
      return { ...r, _amt: amt, _bud: bud, _variance: variance, _barW: barW, _favorable: varianceFavorable };
    });
  }
  function isTableHtml(title, rows, totalActual, totalBudget) {
    if (!rows.length) return '';
    const withVar = rowsWithVariance(rows);
    const hasBudget = withVar.some((r) => r._bud != null);
    return `
      <div class="table-h2">${esc(title)}</div>
      <table class="data-table">
        <thead><tr>
          <th>Account</th>
          ${hasBudget ? `<th class="num">Actual</th><th class="num">Budget</th><th class="num">Variance</th>` : `<th class="num">Amount</th>`}
        </tr></thead>
        <tbody>
          ${withVar.map((r) => hasBudget ? `
            <tr>
              <td>${esc(r.account || '(unnamed)')}</td>
              <td class="num">${fmtMoney(r._amt)}</td>
              <td class="num">${r._bud != null ? fmtMoney(r._bud) : '—'}</td>
              <td class="num" style="color:${r._variance == null ? 'var(--ink-muted)' : (r._favorable ? 'var(--good)' : 'var(--bad)')};">
                ${r._variance == null ? '—' : fmtMoney(r._variance)}
                ${r._barW ? `<span class="variance-bar" style="background:${r._favorable ? 'var(--good)' : 'var(--bad)'}; width:${r._barW}px;"></span>` : ''}
              </td>
            </tr>` : `
            <tr>
              <td>${esc(r.account || '(unnamed)')}</td>
              <td class="num">${fmtMoney(r._amt)}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td>Total ${esc(title.toLowerCase())}</td>
          ${hasBudget ? `
            <td class="num">${fmtMoney(totalActual)}</td>
            <td class="num">${totalBudget ? fmtMoney(totalBudget) : '—'}</td>
            <td class="num" style="color:${(totalActual - (totalBudget || 0)) === 0 ? 'var(--ink)' : (((title === 'Revenue' ? 1 : -1) * (totalActual - (totalBudget || 0))) >= 0 ? 'var(--good)' : 'var(--bad)')};">${totalBudget ? fmtMoney(totalActual - totalBudget) : '—'}</td>
          ` : `<td class="num">${fmtMoney(totalActual)}</td>`}
        </tr></tfoot>
      </table>
    `;
  }

  const niDeltaClass = niVariance == null ? '' : (niVariance >= 0 ? 'good' : 'bad');
  const niDeltaSign = niVariance == null ? '' : (niVariance >= 0 ? '+' : '');

  // Trend chart — bar per month, height proportional to net income, current
  // month highlighted in gold. Negative net renders below the zero line in red.
  // Only rendered when we have ≥ 3 months of trailing data.
  let trendChartHtml = '';
  if (isTrend) {
    const nets = trailing.map((m) => Number(m.net) || 0);
    const maxAbs = nets.reduce((m, n) => Math.max(m, Math.abs(n)), 1);
    const barMaxPx = 80;  // tallest bar height
    const zeroBaselinePx = barMaxPx + 2;  // baseline y-position for zero
    const chartH = barMaxPx * 2 + 28;  // total chart height (above + below zero + labels)
    trendChartHtml = `
      <div class="table-h2">12-month net-income trend</div>
      <div style="display:flex; align-items:flex-end; gap:6px; padding:4px 0 6px; border-bottom:1px dashed var(--rule); margin: 4px 0;">
        ${trailing.map((m, i) => {
          const n = Number(m.net) || 0;
          const h = Math.round((Math.abs(n) / maxAbs) * barMaxPx);
          const positive = n >= 0;
          const isCurrent = i === trailing.length - 1;
          const color = isCurrent ? '#D4AF37' : (positive ? '#315A87' : '#dc2626');
          return `<div style="flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; height:${chartH}px; justify-content:flex-end;">
            <div style="height:${barMaxPx}px; display:flex; flex-direction:column; justify-content:flex-end; width:100%;">
              ${positive ? `<div title="${esc(m.month_label)}: ${fmtMoney(n)}" style="width:100%; height:${h}px; background:${color}; border-radius:2px 2px 0 0;"></div>` : ''}
            </div>
            <div style="width:100%; height:2px; background:#cbd5e1;"></div>
            <div style="height:${barMaxPx}px; width:100%; display:flex; flex-direction:column; justify-content:flex-start;">
              ${!positive ? `<div title="${esc(m.month_label)}: ${fmtMoney(n)}" style="width:100%; height:${h}px; background:${color}; border-radius:0 0 2px 2px;"></div>` : ''}
            </div>
            <div style="font-size:10px; color:${isCurrent ? '#1F3A5F' : 'var(--ink-muted)'}; margin-top:4px; font-weight:${isCurrent ? '700' : '400'}; text-align:center; word-break:break-word;">${esc(String(m.month_label || '').slice(0, 6))}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--ink-muted); margin-bottom:14px;">
        <span><span style="display:inline-block; width:10px; height:10px; background:#315A87; border-radius:2px; vertical-align:middle; margin-right:5px;"></span>Prior months</span>
        <span><span style="display:inline-block; width:10px; height:10px; background:#D4AF37; border-radius:2px; vertical-align:middle; margin-right:5px;"></span>This month (${esc(currentLabel)})</span>
        <span>Range: ${fmtMoney(Math.min(...nets), { precision: 0 })} to ${fmtMoney(Math.max(...nets), { precision: 0 })}</span>
      </div>`;
  }

  // KPI layout — adapts based on whether this is a single-period or 12-month
  // trend report. Trend mode leads with "This month" + "YTD" + "Monthly avg";
  // single-period leads with "Net income (YTD)" + revenue + expense.
  let kpiHtml = '';
  if (isTrend && currentPeriod) {
    const thisMonthNet = Number(currentPeriod.net) || 0;
    const avgNet = monthlyAvgNet != null ? monthlyAvgNet : 0;
    const monthVsAvg = thisMonthNet - avgNet;
    const monthDeltaClass = monthVsAvg >= 0 ? 'good' : 'bad';
    const monthDeltaSign = monthVsAvg >= 0 ? '+' : '';
    kpiHtml = `
      <div class="kpi-row">
        <div class="kpi-card">
          <div class="label">This month — ${esc(currentLabel)}</div>
          <div class="value">${fmtMoney(thisMonthNet, { precision: 0 })}</div>
          ${monthlyAvgNet != null ? `<div class="delta ${monthDeltaClass}">${monthDeltaSign}${fmtMoney(monthVsAvg, { precision: 0 })} vs. monthly avg</div>` : ''}
        </div>
        <div class="kpi-card">
          <div class="label">YTD net income</div>
          <div class="value">${fmtMoney(niActual, { precision: 0 })}</div>
          <div class="delta">${trailing.length} months · ${fmtMoney(revTotal, { precision: 0 })} rev / ${fmtMoney(expTotal, { precision: 0 })} exp</div>
        </div>
        <div class="kpi-card">
          <div class="label">Monthly average net</div>
          <div class="value">${fmtMoney(monthlyAvgNet || 0, { precision: 0 })}</div>
          <div class="delta">run-rate baseline</div>
        </div>
        ${(cashOp != null || cashRes != null) ? `
          <div class="kpi-card">
            <div class="label">Cash position</div>
            <div class="value">${fmtMoney((cashOp || 0) + (cashRes || 0), { precision: 0 })}</div>
            <div class="delta">${cashOp != null ? `Operating ${fmtMoney(cashOp, { precision: 0 })}` : ''}${cashOp != null && cashRes != null ? ' · ' : ''}${cashRes != null ? `Reserves ${fmtMoney(cashRes, { precision: 0 })}` : ''}</div>
          </div>` : ''}
      </div>`;
  } else {
    kpiHtml = `
      <div class="kpi-row">
        <div class="kpi-card">
          <div class="label">Net income${currentLabel ? ` — ${esc(currentLabel)}` : ' (YTD)'}</div>
          <div class="value">${fmtMoney(niActual, { precision: 0 })}</div>
          ${niBudget ? `<div class="delta ${niDeltaClass}">${niDeltaSign}${fmtMoney(niVariance, { precision: 0 })} vs. budget${niVarPct != null ? ` (${niDeltaSign}${niVarPct.toFixed(1)}%)` : ''}</div>` : ''}
        </div>
        <div class="kpi-card">
          <div class="label">Total revenue</div>
          <div class="value">${fmtMoney(revTotal, { precision: 0 })}</div>
          ${revBudget ? `<div class="delta">Budgeted ${fmtMoney(revBudget, { precision: 0 })}</div>` : ''}
        </div>
        <div class="kpi-card">
          <div class="label">Total expense</div>
          <div class="value">${fmtMoney(expTotal, { precision: 0 })}</div>
          ${expBudget ? `<div class="delta">Budgeted ${fmtMoney(expBudget, { precision: 0 })}</div>` : ''}
        </div>
        ${(cashOp != null || cashRes != null) ? `
          <div class="kpi-card">
            <div class="label">Cash position</div>
            <div class="value">${fmtMoney((cashOp || 0) + (cashRes || 0), { precision: 0 })}</div>
            <div class="delta">${cashOp != null ? `Operating ${fmtMoney(cashOp, { precision: 0 })}` : ''}${cashOp != null && cashRes != null ? ' · ' : ''}${cashRes != null ? `Reserves ${fmtMoney(cashRes, { precision: 0 })}` : ''}</div>
          </div>` : ''}
      </div>`;
  }

  // ---------- BALANCE SHEET block ----------
  let balanceSheetHtml = '';
  if (bs && (Array.isArray(bs.assets) && bs.assets.length > 0)) {
    const totals = bs.totals || {};
    const totalCash = (cashOp || 0) + (cashRes || 0) + (cashSav || 0);
    balanceSheetHtml = `
      <div style="margin-top: 8px;">
        <h2 style="font-family: 'Inter', sans-serif; font-size: 18px; font-weight: 800; color: var(--navy); margin: 6px 0 2px; letter-spacing: -0.01em;">Balance Sheet</h2>
        <div style="font-size: 12px; color: var(--ink-muted); margin-bottom: 12px;">As of ${esc(bs.as_of_date ? fmtDate(bs.as_of_date) : currentLabel)}</div>

        ${(cashOp != null || cashRes != null || cashSav != null) ? `
          <div class="kpi-row">
            <div class="kpi-card">
              <div class="label">Operating cash</div>
              <div class="value">${fmtMoney(cashOp || 0, { precision: 0 })}</div>
              <div class="delta">day-to-day ops</div>
            </div>
            <div class="kpi-card" style="background:#fffbeb; border-color:#fde68a;">
              <div class="label" style="color:#78350f;">Reserves cash</div>
              <div class="value" style="color:#1F3A5F;">${fmtMoney(cashRes || 0, { precision: 0 })}</div>
              <div class="delta">long-term capital</div>
            </div>
            ${cashSav != null ? `
              <div class="kpi-card">
                <div class="label">Savings cash</div>
                <div class="value">${fmtMoney(cashSav, { precision: 0 })}</div>
                <div class="delta">overflow / interim</div>
              </div>` : ''}
            <div class="kpi-card">
              <div class="label">Total cash</div>
              <div class="value">${fmtMoney(totalCash, { precision: 0 })}</div>
              <div class="delta">across all funds</div>
            </div>
          </div>` : ''}

        ${bsSection('Assets',                bs.assets,      bs.asset_subtotals,     totals.total_assets)}
        ${bsSection('Liabilities',           bs.liabilities, bs.liability_subtotals, null)}
        ${bsSection('Equity / Fund Balance', bs.equity,      bs.equity_subtotals,    null)}

        ${totals.total_liabilities_and_equity ? `
          <table class="data-table" style="margin-top: 6px;">
            <tbody>
              ${bsGrandTotalRow('Total liabilities + equity', totals.total_liabilities_and_equity)}
            </tbody>
          </table>` : ''}
      </div>`;
  }

  // ---------- INCOME-STATEMENT block ----------
  // Fund-breakdown card row when by_fund data is meaningful (at least one
  // non-operating fund populated). For operating-only reports, falls back
  // to the single KPI row below.
  const fundBreakdownAvailable = (fundReserves.net != null) || (fundSavings.net != null);
  let fundBreakdownHtml = '';
  if (fundBreakdownAvailable) {
    fundBreakdownHtml = `
      <div class="table-h2">Net by fund — ${esc(currentLabel)}</div>
      <div class="kpi-row" style="margin-top:4px;">
        <div class="kpi-card">
          <div class="label">Operating</div>
          <div class="value" style="color:${(fundOperating.net || 0) >= 0 ? 'var(--good)' : 'var(--bad)'};">${fmtMoney(fundOperating.net || 0, { precision: 0 })}</div>
          <div class="delta">${fmtMoney(fundOperating.revenue || 0, { precision: 0 })} rev / ${fmtMoney(fundOperating.expense || 0, { precision: 0 })} exp</div>
        </div>
        <div class="kpi-card" style="background:#fffbeb; border-color:#fde68a;">
          <div class="label" style="color:#78350f;">Reserves</div>
          <div class="value" style="color:${(fundReserves.net || 0) >= 0 ? 'var(--good)' : 'var(--bad)'};">${fundReserves.net != null ? fmtMoney(fundReserves.net, { precision: 0 }) : '—'}</div>
          <div class="delta">${fundReserves.revenue != null ? fmtMoney(fundReserves.revenue, { precision: 0 }) : '—'} contrib / ${fundReserves.expense != null ? fmtMoney(fundReserves.expense, { precision: 0 }) : '—'} cap-ex</div>
        </div>
        ${fundSavings.net != null ? `
          <div class="kpi-card">
            <div class="label">Savings</div>
            <div class="value" style="color:${fundSavings.net >= 0 ? 'var(--good)' : 'var(--bad)'};">${fmtMoney(fundSavings.net, { precision: 0 })}</div>
            <div class="delta">${fundSavings.revenue != null ? fmtMoney(fundSavings.revenue, { precision: 0 }) : '—'} in / ${fundSavings.expense != null ? fmtMoney(fundSavings.expense, { precision: 0 }) : '—'} out</div>
          </div>` : ''}
      </div>`;
  }

  const incomeStatementHtml = `
    <div style="margin-top: 14px;">
      <h2 style="font-family: 'Inter', sans-serif; font-size: 18px; font-weight: 800; color: var(--navy); margin: 18px 0 2px; letter-spacing: -0.01em;">Income Statement</h2>
      <div style="font-size: 12px; color: var(--ink-muted); margin-bottom: 12px;">${esc(currentLabel)}${isTrend ? ` · ${trailing.length}-month trailing` : ''}</div>

      ${fundBreakdownHtml || kpiHtml}

      ${trendChartHtml}

      ${isTableHtml('Revenue', revenueRows, revTotal, revBudget)}
      ${isTableHtml('Expenses', expenseRows, expTotal, expBudget)}
    </div>`;

  const bodyHtml = `
    ${narrative ? `<div class="narrative">${esc(narrative)}</div>` : ''}

    ${balanceSheetHtml}
    ${incomeStatementHtml}
  `;

  return renderStandalonePage({ packet, section, bodyHtml, accent: '#1F3A5F', embed });
}

// ----------------------------------------------------------------------------
// AR Aging — polished board-facing summary. Distills the raw aging dump into
// the 30-second-readable picture: total AR + delinquent count, an aging
// bucket bar, the top 10 worst accounts by balance with status, and the
// AI's flagged watchouts. Full underlying data still lives in input_data
// for the audit trail.
// ----------------------------------------------------------------------------
function renderArAgingStandaloneHtml({ packet, section, embed = false }) {
  const d = section.input_data || {};
  const narrative = d.narrative || null;
  const watchouts = Array.isArray(d.watchouts) ? d.watchouts : [];
  const total = d.total_ar != null ? Number(d.total_ar) : null;
  const buckets = d.buckets || {};
  const b0_30   = Number(buckets['0_30']   || 0);
  const b31_60  = Number(buckets['31_60']  || 0);
  const b61_90  = Number(buckets['61_90']  || 0);
  const bOver90 = Number(buckets['over_90'] || 0);
  const computedTotal = b0_30 + b31_60 + b61_90 + bOver90;
  const arTotal = total != null && total > 0 ? total : computedTotal;
  const counts = d.homeowner_count || {};
  const delinqCount = counts.delinquent != null ? Number(counts.delinquent) : null;
  const currentCount = counts.current != null ? Number(counts.current) : null;
  const totalAccounts = (delinqCount != null && currentCount != null) ? delinqCount + currentCount : null;
  const pctDelinq = totalAccounts ? (delinqCount / totalAccounts) * 100 : null;

  // Aging-bucket horizontal bar — each segment proportional to its share of
  // total AR. Color shifts redder as buckets age.
  const segs = arTotal > 0 ? [
    { label: '0–30',  amt: b0_30,   color: '#bbf7d0' },
    { label: '31–60', amt: b31_60,  color: '#fde68a' },
    { label: '61–90', amt: b61_90,  color: '#fdba74' },
    { label: '>90',   amt: bOver90, color: '#fca5a5' },
  ].map((s) => ({ ...s, pct: (s.amt / arTotal) * 100 })) : [];

  // Top delinquents (cap at 10 — board can't action more than that in one meeting)
  const top = Array.isArray(d.top_delinquent) ? d.top_delinquent : [];
  const topRows = top.slice(0, 10).map((r) => ({
    address:    r.unit || r.address || '(unknown)',
    owner:      r.owner || null,
    balance:    Number(r.balance) || 0,
    oldest:     r.oldest_charge_days != null ? Number(r.oldest_charge_days) : null,
    status:     r.status || null,
  })).sort((a, b) => b.balance - a.balance);

  const asOf = d.as_of_date ? fmtDateShort(d.as_of_date) : (packet.period_label || '');

  const bodyHtml = `
    ${narrative ? `<div class="narrative">${esc(narrative)}</div>` : ''}

    <div class="kpi-row">
      <div class="kpi-card">
        <div class="label">Total AR outstanding</div>
        <div class="value">${fmtMoney(arTotal, { precision: 0 })}</div>
        ${asOf ? `<div class="delta">As of ${esc(asOf)}</div>` : ''}
      </div>
      ${delinqCount != null ? `
        <div class="kpi-card">
          <div class="label">Delinquent accounts</div>
          <div class="value">${delinqCount}${totalAccounts ? ` <span style="font-size:14px; color:var(--ink-muted); font-weight:600;">/ ${totalAccounts}</span>` : ''}</div>
          ${pctDelinq != null ? `<div class="delta">${pctDelinq.toFixed(1)}% past due</div>` : ''}
        </div>` : ''}
      <div class="kpi-card" style="${bOver90 > 0 ? 'background:#fef2f2; border-color:#fecaca;' : ''}">
        <div class="label" style="${bOver90 > 0 ? 'color:#991b1b;' : ''}">Over 90 days</div>
        <div class="value" style="${bOver90 > 0 ? 'color:#7f1d1d;' : ''}">${fmtMoney(bOver90, { precision: 0 })}</div>
        <div class="delta ${bOver90 > 0 ? 'bad' : 'good'}">${bOver90 > 0 ? '⚠ Collection candidates' : '✓ Clean'}</div>
      </div>
    </div>

    ${arTotal > 0 ? `
      <div class="table-h2">Aging distribution</div>
      <div style="display:flex; height:32px; border-radius:6px; overflow:hidden; border:1px solid var(--rule); margin: 6px 0 6px;">
        ${segs.map((s) => s.pct > 0 ? `<div title="${s.label}: ${fmtMoney(s.amt)}" style="width:${s.pct}%; background:${s.color}; display:flex; align-items:center; justify-content:center; font-size:11px; color:#1a1a1a; font-weight:600; min-width:0; overflow:hidden;">${s.pct >= 8 ? esc(`${s.label}: ${fmtMoney(s.amt, { precision: 0 })}`) : ''}</div>` : '').join('')}
      </div>
      <div style="display:flex; gap:14px; font-size:11px; color:var(--ink-muted); flex-wrap:wrap;">
        ${segs.map((s) => `<span><span style="display:inline-block; width:10px; height:10px; background:${s.color}; border-radius:2px; vertical-align:middle; margin-right:5px;"></span>${esc(s.label)}: ${fmtMoney(s.amt, { precision: 0 })} (${s.pct.toFixed(0)}%)</span>`).join('')}
      </div>` : ''}

    ${(() => {
      // At-legal callout — accounts at "With Attorney" or "Violation
      // Collections - With Attorney". Surfaced FIRST because they're the
      // high-stakes pool the board acts on.
      const atLegal = Array.isArray(d.at_legal_accounts) ? d.at_legal_accounts : [];
      if (!atLegal.length) return '';
      const sumLegal = atLegal.reduce((s, a) => s + (Number(a.balance) || 0), 0);
      return `
        <div class="table-h2" style="color:#7f1d1d;">⚖️ Accounts at legal (with attorney)</div>
        <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:14px 16px; margin: 6px 0 12px;">
          <div style="font-size:13px; color:#7f1d1d; margin-bottom:8px;"><strong>${atLegal.length} account${atLegal.length === 1 ? '' : 's'}</strong> currently in legal collections — total exposure <strong>${fmtMoney(sumLegal, { precision: 0 })}</strong>.</div>
          <table class="data-table" style="margin: 4px 0;">
            <thead><tr>
              <th>Address</th>
              <th>Owner</th>
              <th class="num">Balance</th>
              <th class="num">Over 90</th>
              <th>Status</th>
            </tr></thead>
            <tbody>
              ${atLegal.map((r) => `
                <tr>
                  <td><strong>${esc(r.address || '—')}</strong></td>
                  <td>${esc(r.owner || '—')}</td>
                  <td class="num" style="color:var(--bad); font-weight:700;">${fmtMoney(Number(r.balance) || 0)}</td>
                  <td class="num">${r.over_90 != null ? fmtMoney(Number(r.over_90)) : '—'}</td>
                  <td><span style="background:#fee2e2; color:#7f1d1d; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:700;">${esc(r.status || 'With Attorney')}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    })()}

    ${(() => {
      // Status breakdown chips — quick read on where accounts sit in the
      // collection ladder. Skipped silently when not in input_data.
      const sb = d.status_summary || null;
      if (!sb) return '';
      const chips = [
        { k: 'with_attorney',       label: 'With Attorney',          bg: '#fee2e2', fg: '#7f1d1d' },
        { k: 'notice_209',          label: '§209 Notice',            bg: '#fef3c7', fg: '#78350f' },
        { k: 'board_review',        label: 'Board Review',           bg: '#fef3c7', fg: '#78350f' },
        { k: 'payment_plan',        label: 'Payment Plan',           bg: '#dcfce7', fg: '#166534' },
        { k: 'delinquent_reminder', label: 'Delinquency Reminder',   bg: '#e0e7ff', fg: '#3730a3' },
        { k: 'late_notice',         label: 'Late Notice',            bg: '#e0e7ff', fg: '#3730a3' },
        { k: 'other',               label: 'Other',                  bg: '#f1f5f9', fg: '#475569' },
      ].filter((c) => sb[c.k] != null && sb[c.k] > 0);
      if (!chips.length) return '';
      return `
        <div class="table-h2">Collection status</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin: 4px 0 12px;">
          ${chips.map((c) => `<div style="background:${c.bg}; color:${c.fg}; padding:6px 12px; border-radius:8px; font-size:12px; font-weight:600;"><span style="font-size:18px; font-weight:800;">${sb[c.k]}</span> · ${esc(c.label)}</div>`).join('')}
        </div>`;
    })()}

    ${topRows.length ? `
      <div class="table-h2">Top delinquent accounts (non-legal)</div>
      <table class="data-table">
        <thead><tr>
          <th>Address</th>
          <th>Owner</th>
          <th class="num">Balance</th>
          <th class="num">Over 90</th>
          <th>Status</th>
        </tr></thead>
        <tbody>
          ${topRows.map((r) => `
            <tr>
              <td><strong>${esc(r.address)}</strong></td>
              <td>${esc(r.owner || '—')}</td>
              <td class="num" style="color:${r.balance >= 1000 ? 'var(--bad)' : 'var(--ink)'}; font-weight:${r.balance >= 1000 ? '700' : '400'};">${fmtMoney(r.balance)}</td>
              <td class="num">${r.over_90 != null ? fmtMoney(Number(r.over_90)) : (r.oldest != null ? `${r.oldest}d` : '—')}</td>
              <td>${r.status ? `<span style="background:var(--rule); padding:2px 8px; border-radius:99px; font-size:11px;">${esc(r.status)}</span>` : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}

    ${watchouts.length ? `
      <div class="table-h2">🚩 Watchouts</div>
      <ul style="margin: 6px 0 16px 0; padding-left: 18px;">
        ${watchouts.map((w) => `<li style="margin-bottom: 4px;">${esc(w)}</li>`).join('')}
      </ul>` : ''}
  `;
  return renderStandalonePage({ packet, section, bodyHtml, embed });
}

// ----------------------------------------------------------------------------
// Deed Restriction Violations — polished summary of the Vantaca Violation
// Report Detail. Distills 12 pages of per-violation rows into the board's
// 30-second-readable picture: stage counts, top categories, certified §209
// cases, fine-assessed cases, pending hearings, top problem properties.
// ----------------------------------------------------------------------------
function renderViolationsSummaryStandaloneHtml({ packet, section, embed = false }) {
  const d = section.input_data || {};
  const narrative = d.narrative || null;
  const watchouts = Array.isArray(d.watchouts) ? d.watchouts : [];
  const period = d.report_period || (packet.period_label || '');
  const byStage = d.by_stage || {};
  const stages = [
    { k: 'first_notice',            label: 'First Notice',            bg: '#dcfce7', fg: '#166534' },
    { k: 'second_notice',           label: 'Second Notice',           bg: '#fef3c7', fg: '#78350f' },
    { k: 'certified_letter_notice', label: 'Certified §209',          bg: '#fecaca', fg: '#7f1d1d' },
    { k: 'pending_hearing',         label: 'Pending Hearing',         bg: '#e0e7ff', fg: '#3730a3' },
    { k: 'monthly_fine_assessed',   label: 'Monthly Fine Assessed',   bg: '#fca5a5', fg: '#7f1d1d' },
    { k: 'closed',                  label: 'Closed (period)',         bg: '#bbf7d0', fg: '#14532d' },
  ];
  const totalOpen = ['first_notice', 'second_notice', 'certified_letter_notice', 'pending_hearing', 'monthly_fine_assessed']
    .reduce((s, k) => s + (Number(byStage[k]) || 0), 0);
  const totalAll = d.total_violations != null ? Number(d.total_violations) : (totalOpen + (Number(byStage.closed) || 0));

  const topCategories = Array.isArray(d.top_categories) ? d.top_categories.slice(0, 10) : [];
  const certified = Array.isArray(d.certified_cases) ? d.certified_cases : [];
  const fines = Array.isArray(d.fine_assessed_cases) ? d.fine_assessed_cases : [];
  const hearings = Array.isArray(d.pending_hearing_cases) ? d.pending_hearing_cases : [];
  const problems = Array.isArray(d.top_problem_properties) ? d.top_problem_properties.slice(0, 8) : [];

  function caseTable(rows, opts = {}) {
    if (!rows.length) return `<div style="font-size:12px; color:var(--ink-muted); font-style:italic; margin: 4px 0 12px;">None.</div>`;
    const showHearing = !!opts.showHearing;
    return `
      <table class="data-table" style="margin: 4px 0 14px;">
        <thead><tr>
          <th>Address</th>
          <th>Homeowner</th>
          <th>Category</th>
          ${showHearing ? `<th>Hearing</th>` : ''}
          <th>Account</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><strong>${esc(r.address || '—')}</strong></td>
              <td>${esc(r.homeowner || '—')}</td>
              <td>${esc(r.category || '—')}</td>
              ${showHearing ? `<td>${r.hearing_date ? esc(fmtDateShort(r.hearing_date)) : '—'}</td>` : ''}
              <td style="font-family:monospace; color:var(--ink-muted); font-size:11px;">${esc(r.account || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // Distribution bar — top 10 categories by percentage. Width proportional
  // to share of all violations in the period.
  const maxCatPct = topCategories.reduce((m, c) => Math.max(m, Number(c.pct) || 0), 1);

  const bodyHtml = `
    ${narrative ? `<div class="narrative">${esc(narrative)}</div>` : ''}

    <div class="kpi-row">
      <div class="kpi-card">
        <div class="label">Total tracked</div>
        <div class="value">${totalAll || '—'}</div>
        <div class="delta">${esc(period)}</div>
      </div>
      <div class="kpi-card" style="background:#fef2f2; border-color:#fecaca;">
        <div class="label" style="color:#991b1b;">High-stakes pool</div>
        <div class="value" style="color:#7f1d1d;">${(Number(byStage.certified_letter_notice) || 0) + (Number(byStage.monthly_fine_assessed) || 0) + (Number(byStage.pending_hearing) || 0)}</div>
        <div class="delta bad">§209 + Fines + Pending Hearing</div>
      </div>
      <div class="kpi-card" style="background:#dcfce7; border-color:#bbf7d0;">
        <div class="label" style="color:#14532d;">Closed in period</div>
        <div class="value" style="color:#166534;">${byStage.closed || 0}</div>
        <div class="delta good">resolved</div>
      </div>
    </div>

    <div class="table-h2">Distribution by stage</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin: 4px 0 14px;">
      ${stages.map((s) => (Number(byStage[s.k]) || 0) > 0 ? `<div style="background:${s.bg}; color:${s.fg}; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; display:flex; flex-direction:column; align-items:flex-start; min-width:120px;"><span style="font-size:20px; font-weight:800; line-height:1;">${byStage[s.k]}</span><span>${esc(s.label)}</span></div>` : '').join('')}
    </div>

    ${topCategories.length ? `
      <div class="table-h2">Top categories</div>
      <div style="display:flex; flex-direction:column; gap:4px; margin: 4px 0 14px;">
        ${topCategories.map((c) => {
          const pct = Number(c.pct) || 0;
          const w = (pct / maxCatPct) * 100;
          return `<div style="display:flex; align-items:center; gap:10px; font-size:12px;">
            <div style="flex:0 0 200px; color:var(--ink);">${esc(c.category)}</div>
            <div style="flex:1; height:14px; background:#f1f5f9; border-radius:3px; overflow:hidden;"><div style="height:100%; width:${w}%; background:linear-gradient(90deg, #1F3A5F 0%, #315A87 100%);"></div></div>
            <div style="flex:0 0 60px; text-align:right; font-weight:700; color:var(--navy); font-variant-numeric:tabular-nums;">${pct.toFixed(1)}%</div>
            ${c.count != null ? `<div style="flex:0 0 30px; text-align:right; font-size:11px; color:var(--ink-muted);">${c.count}</div>` : ''}
          </div>`;
        }).join('')}
      </div>` : ''}

    ${(certified.length || fines.length) ? `
      <div class="table-h2" style="color:#7f1d1d;">⚖️ High-stakes cases</div>` : ''}

    ${certified.length ? `
      <div style="font-size:12px; font-weight:700; color:#1a3a5c; margin: 8px 0 2px; text-transform:uppercase; letter-spacing:0.04em;">Certified §209 (${certified.length})</div>
      ${caseTable(certified)}` : ''}

    ${fines.length ? `
      <div style="font-size:12px; font-weight:700; color:#1a3a5c; margin: 8px 0 2px; text-transform:uppercase; letter-spacing:0.04em;">Monthly Fine Assessed (${fines.length})</div>
      ${caseTable(fines)}` : ''}

    ${hearings.length ? `
      <div class="table-h2">Pending Hearing (${hearings.length})</div>
      ${caseTable(hearings, { showHearing: true })}` : ''}

    ${problems.length ? `
      <div class="table-h2">Top problem properties (multiple open violations)</div>
      <table class="data-table" style="margin: 4px 0 14px;">
        <thead><tr>
          <th>Address</th>
          <th>Homeowner</th>
          <th class="num">Violations</th>
          <th>Categories</th>
        </tr></thead>
        <tbody>
          ${problems.map((p) => `
            <tr>
              <td><strong>${esc(p.address || '—')}</strong></td>
              <td>${esc(p.homeowner || '—')}</td>
              <td class="num" style="font-weight:700;">${p.violation_count || '—'}</td>
              <td style="font-size:11.5px; color:var(--ink-soft);">${(Array.isArray(p.categories) ? p.categories : []).map((c) => esc(c)).join(' · ')}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}

    ${watchouts.length ? `
      <div class="table-h2">🚩 Watchouts</div>
      <ul style="margin: 6px 0 16px 0; padding-left: 18px;">
        ${watchouts.map((w) => `<li style="margin-bottom: 4px;">${esc(w)}</li>`).join('')}
      </ul>` : ''}
  `;

  return renderStandalonePage({ packet, section, bodyHtml, embed });
}

// ----------------------------------------------------------------------------
function renderGenericSectionStandaloneHtml({ packet, section, embed = false }) {
  const d = section.input_data || {};
  const narrative = (d.narrative || d.text || '').trim();
  const watchouts = Array.isArray(d.watchouts) ? d.watchouts : [];

  const bodyHtml = `
    ${narrative ? `<div class="narrative">${esc(narrative).replace(/\n+/g, '<br><br>')}</div>` : ''}
    ${watchouts.length ? `
      <div class="table-h2">🚩 Watchouts</div>
      <ul style="margin: 6px 0 16px 0; padding-left: 18px;">
        ${watchouts.map((w) => `<li style="margin-bottom: 4px;">${esc(w)}</li>`).join('')}
      </ul>` : ''}
    ${!narrative && !watchouts.length ? `<p style="color:var(--ink-muted); font-style:italic;">This section is in progress. Upload the source PDF or run AI generation to populate the polished view.</p>` : ''}
  `;
  return renderStandalonePage({ packet, section, bodyHtml, embed });
}

// ----------------------------------------------------------------------------
// HTML renderer for a packet preview. Produces a Bedrock-branded multi-page
// document: Cover + TOC + (placeholder pages for each non-skipped section).
// The TOC reflects ONLY the sections Ed kept checked (status != 'skipped').
//
// Day 3 will replace section placeholders with real rendered content per
// section type. Day 4 will add Puppeteer/Chromium server-side PDF export.
// ----------------------------------------------------------------------------
function renderPacketPreviewHtml({ packet, sections, volume }) {
  const community = packet.community || {};
  const assets = resolveCommunityAssets(community);
  // Solid navy base color ensures the cover never reads as "empty" even if
  // the hero image 404s on Render — the rgba gradient overlay alone would
  // otherwise fade against the white .page underneath.
  const heroStyle = assets.hero
    ? `background-color: #1F3A5F; background-image: linear-gradient(180deg, rgba(31,58,95,0.35) 0%, rgba(31,58,95,0.55) 55%, rgba(31,58,95,0.92) 100%), url('${assets.hero}'); background-size: cover; background-position: center;`
    : `background: linear-gradient(180deg, #4a7ab0 0%, #315A87 50%, #1F3A5F 100%);`;

  const visibleSections = (sections || []).filter(s => s.status !== 'skipped').sort((a, b) => a.section_order - b.section_order);

  // Estimate page numbers — cover = 1, TOC = 2, sections start at 3
  let pageCursor = 3;
  const tocItems = visibleSections.map((s, i) => {
    const num = String(i + 1).padStart(2, '0');
    const t = s.template || {};
    const startPage = pageCursor;
    pageCursor += 1;  // 1 page per section in v0; Day 3 will compute realistically
    return {
      num,
      title: t.display_name || s.section_key,
      description: t.description || '',
      page: startPage,
      sectionKey: s.section_key,
      hasData: s.input_data && Object.keys(s.input_data).length > 0,
      inputMode: s.input_mode,
      status: s.status
    };
  });

  const totalPages = 2 + visibleSections.length;  // cover + TOC + sections

  // Common page footer template
  const footer = (pageNum) => `
    <div class="page-foot">
      <span class="foot-brand">${BRAND.service.name} <span class="foot-tag">· ${BRAND.service.tagline}</span></span>
      <span class="foot-context">${esc(community.name || '')} · ${esc(packet.period_label || '')} · pg ${pageNum} / ${totalPages}</span>
    </div>`;

  // Common interior page header template
  const pageHeader = `
    <div class="page-header">
      <div class="page-header-brand">
        <img src="${assets.logo || '/logos/bedrock_logo.png'}" alt="${esc(community.name)}">
        ${assets.logo && assets.logo !== '/logos/bedrock_logo.png' ? `<img src="/logos/bedrock_logo.png" alt="${BRAND.service.short}" style="height:42px; margin-left:10px;">` : ''}
      </div>
      <div class="page-header-context">
        <strong>${esc(community.name || '')}</strong>
        Board Packet · ${esc(packet.period_label || '')}
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(community.name)} — ${esc(packet.period_label)} Board Packet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bedrock-navy: #315A87;
    --bedrock-navy-deep: #1F3A5F;
    --bedrock-navy-tint: #EAF0F7;
    --bedrock-navy-mute: #6E89AB;
    --ink: #1a1a1a;
    --ink-soft: #4a4a4a;
    --ink-muted: #888;
    --rule: #E5E7EB;
    --rule-soft: #F1F2F4;
    --paper: #ffffff;
    --accent-warn: #B47B00;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: #f4f5f7; color: var(--ink);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; font-feature-settings: "tnum" 1; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    width: 8.5in; min-height: 11in; margin: 32px auto;
    background: var(--paper); box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    display: flex; flex-direction: column; position: relative; overflow: hidden;
  }
  /* ========== COVER PAGE ========== */
  .cover { padding: 0; color: var(--paper); }
  .cover-hero {
    flex: 0 0 5.5in; ${heroStyle}
    position: relative; padding: 0.7in 0.8in;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .cover-brand { display: flex; align-items: center; gap: 16px; }
  .cover-brand img { height: 110px; width: auto; filter: brightness(0) invert(1); }
  .cover-period {
    font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
    font-weight: 600; color: rgba(255,255,255,0.85); align-self: flex-end;
  }
  .cover-title { margin-top: auto; }
  .cover-eyebrow {
    font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
    font-weight: 600; color: rgba(255,255,255,0.85); margin-bottom: 12px;
  }
  .cover-community {
    font-size: 42px; font-weight: 700; line-height: 1.05; letter-spacing: -0.01em;
    color: var(--paper); margin-bottom: 12px;
  }
  .cover-month { font-size: 22px; font-weight: 300; color: rgba(255,255,255,0.92); }
  .cover-meta {
    flex: 1; padding: 0.6in 0.8in; background: var(--paper); color: var(--ink);
    display: grid; grid-template-columns: 1fr 1fr; gap: 32px; align-content: start;
  }
  .cover-meta-block .label {
    font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    font-weight: 600; color: var(--ink-muted); margin-bottom: 8px;
  }
  .cover-meta-block .body { font-size: 14px; line-height: 1.6; color: var(--ink); }
  .cover-meta-block .body strong { font-weight: 600; }

  /* ========== INTERIOR PAGES ========== */
  .interior { padding: 0.6in 0.7in; }
  .page-header {
    display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 16px; margin-bottom: 32px;
    border-bottom: 2px solid var(--bedrock-navy);
  }
  .page-header-brand { display: flex; align-items: center; gap: 12px; }
  .page-header-brand img { height: 52px; width: auto; }
  .page-header-context {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    font-weight: 600; color: var(--bedrock-navy-mute); text-align: right; line-height: 1.5;
  }
  .page-header-context strong {
    display: block; color: var(--bedrock-navy-deep); font-size: 12px; letter-spacing: 0.18em;
  }
  .section-eyebrow {
    font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
    font-weight: 600; color: var(--bedrock-navy); margin-bottom: 6px;
  }
  .section-title {
    font-size: 28px; font-weight: 700; line-height: 1.15;
    color: var(--bedrock-navy-deep); letter-spacing: -0.01em; margin: 0 0 8px 0;
  }
  .section-lede {
    font-size: 14px; color: var(--ink-soft); line-height: 1.6;
    margin: 0 0 32px 0; max-width: 520px;
  }
  .page-foot {
    margin-top: auto; padding-top: 18px; border-top: 1px solid var(--rule);
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 10px; color: var(--ink-muted); letter-spacing: 0.05em;
  }
  .page-foot .foot-brand { font-weight: 500; color: var(--ink); letter-spacing: 0.04em; }
  .page-foot .foot-tag {
    color: var(--bedrock-navy); font-weight: 600; letter-spacing: 0.08em; margin-left: 4px;
  }

  /* ========== TOC ========== */
  .toc { list-style: none; padding: 0; margin: 0; }
  .toc li {
    display: flex; align-items: baseline; padding: 14px 0;
    border-bottom: 1px solid var(--rule); font-size: 14px;
  }
  .toc li:last-child { border-bottom: none; }
  .toc .num {
    font-feature-settings: "tnum" 1; width: 32px;
    color: var(--bedrock-navy); font-weight: 600; font-size: 13px;
  }
  .toc .title-cell { flex: 1; color: var(--ink); font-weight: 500; }
  .toc .title-cell .desc {
    display: block; color: var(--ink-muted); font-weight: 400; font-size: 12px; margin-top: 2px;
  }
  .toc .dots {
    flex: 0 0 auto; color: var(--rule); margin: 0 12px;
    letter-spacing: 0.2em; font-size: 11px;
  }
  .toc .pg {
    font-feature-settings: "tnum" 1; color: var(--ink-muted);
    font-size: 13px; width: 24px; text-align: right;
  }

  /* ========== Section placeholder (Day 2 — pending real renderers) ========== */
  .section-placeholder {
    background: var(--bedrock-navy-tint); border: 1px dashed var(--bedrock-navy-mute);
    border-radius: 8px; padding: 24px; margin-top: 20px;
  }
  .section-placeholder h4 { margin: 0 0 8px 0; color: var(--bedrock-navy-deep); }
  .section-placeholder p { margin: 0 0 12px 0; color: var(--ink-soft); font-size: 13px; }
  .section-placeholder pre {
    background: white; border: 1px solid var(--rule); border-radius: 4px;
    padding: 12px; font-size: 11px; overflow-x: auto; max-height: 320px;
    color: var(--ink-soft); white-space: pre-wrap;
  }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
  }
  .badge-ready { background: #dff5e0; color: #2e7d32; }
  .badge-pending { background: #f0f0f0; color: #666; }
  .badge-mode { background: #f5f5f5; color: #555; margin-left: 6px; }

  @media print {
    body { background: white; }
    .page { box-shadow: none; margin: 0; page-break-after: always; }
  }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="page cover">
  <div class="cover-hero">
    <div class="cover-brand">
      <img src="/logos/bedrock_logo.png" alt="${BRAND.service.name}">
    </div>
    <div class="cover-period">${esc(packet.period_label || '')}</div>
    <div class="cover-title">
      <div class="cover-eyebrow">Board Meeting Packet</div>
      <div class="cover-community">${esc(community.name || '')}${assets.legal_suffix ? `<br>${esc(assets.legal_suffix)}` : ''}</div>
      <div class="cover-month">For the meeting of ${esc(fmtDate(packet.meeting_date))}</div>
    </div>
  </div>
  <div class="cover-meta">
    <div class="cover-meta-block">
      <div class="label">Meeting</div>
      <div class="body">
        <strong>${esc(fmtDate(packet.meeting_date))}${packet.meeting_time ? ' — ' + esc(packet.meeting_time) : ''}</strong><br>
        ${packet.meeting_location ? esc(packet.meeting_location) : '<span style="color:var(--ink-muted);">(location TBD)</span>'}
      </div>
    </div>
    <div class="cover-meta-block">
      <div class="label">Prepared by</div>
      <div class="body">
        <strong>${BRAND.service.legal}</strong><br>
        ${BRAND.service.address}<br>
        ${BRAND.service.addressCityStateZip}
      </div>
    </div>
    <div class="cover-meta-block">
      <div class="label">Period covered</div>
      <div class="body"><strong>${esc(packet.period_label || '')}</strong></div>
    </div>
    <div class="cover-meta-block">
      <div class="label">Issued</div>
      <div class="body"><strong>${esc(fmtDateShort(packet.created_at || new Date()))}</strong></div>
    </div>
  </div>
</div>

<!-- TOC PAGE -->
<div class="page interior">
  ${pageHeader}
  <div class="section-eyebrow">Inside this packet</div>
  <h1 class="section-title">Table of Contents</h1>
  <p class="section-lede">A curated, navigable structure rather than 47 pages of source documents stapled together. Source docs are preserved in the appendices.</p>
  <ul class="toc">
    ${tocItems.map(it => `
      <li>
        <span class="num">${it.num}</span>
        <span class="title-cell">${esc(it.title)} <span class="desc">${esc(it.description)}</span></span>
        <span class="dots">·······························</span>
        <span class="pg">${it.page}</span>
      </li>`).join('')}
  </ul>
  ${footer(2)}
</div>

<!-- SECTION PAGES -->
<script>
  // Iframe height messaging from the embed-mode section previews. Each
  // section iframe posts its scrollHeight; we resize accordingly so the
  // packet page grows to fit the polished section content.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.kind !== 'bp-section-iframe-height') return;
    var frames = document.querySelectorAll('iframe.bp-section-iframe');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) {
        frames[i].style.height = (e.data.height + 16) + 'px';
        break;
      }
    }
  });
</script>
${tocItems.map(it => `
${(() => {
  const sec = sections.find(s => s.section_key === it.sectionKey) || {};
  const data = sec.input_data;
  const isAgendaText = sec.section_key === 'agenda' && data?.format === 'text' && data?.text;
  const isExecSummaryText = sec.section_key === 'exec_summary' && (data?.text || typeof data === 'string');
  // Section keys that have polished embed-mode renderers.
  const POLISHED_KEYS = new Set(['financials', 'ar_aging', 'drv']);
  const hasPolished = it.hasData && POLISHED_KEYS.has(sec.section_key);
  return `<div class="page interior">
  ${pageHeader}
  <div class="section-eyebrow">${esc(it.num)} of ${tocItems.length}</div>
  <h1 class="section-title">${esc(it.title)}</h1>
  ${it.description ? `<p class="section-lede">${esc(it.description)}</p>` : ''}
  ${isAgendaText
    ? `<div style="white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: var(--ink);">${esc(data.text)}</div>`
    : isExecSummaryText
    ? `<div style="font-size: 14px; line-height: 1.65; color: var(--ink); white-space: pre-wrap;">${esc(data.text || data)}</div>`
    : hasPolished
    ? `<iframe class="bp-section-iframe"
              src="/api/board-packets/${esc(packet.id)}/sections/${esc(sec.section_key)}/preview?embed=1"
              style="width:100%; min-height:280px; border:0; display:block;"
              scrolling="no"
              loading="lazy"></iframe>`
    : `<div class="section-placeholder">
        <h4>
          Section data ${it.hasData ? '<span class="badge badge-ready">ready</span>' : '<span class="badge badge-pending">pending</span>'}
          <span class="badge badge-mode">${esc(it.inputMode)}</span>
        </h4>
        ${it.hasData
          ? (() => {
              // Non-polished sections: prefer narrative if the extraction
              // produced one (generic Ed-voiced commentary), else fall back
              // to a clean structured-data summary, not the raw JSON dump.
              const nar = data && typeof data.narrative === 'string' && data.narrative.trim();
              if (nar) {
                return `<div style="background:#FFFBEB; border-left:4px solid #D4AF37; padding:14px 18px; border-radius:0 8px 8px 0; font-size:14px; color:var(--ink); line-height:1.65; margin: 8px 0 0;">${esc(nar)}</div>`;
              }
              return `<p style="color:var(--ink-muted); font-size:13px;">Data captured. Polished in-packet renderer for this section ships next — for now, view via the section's Preview button.</p>`;
            })()
          : `<p style="color: var(--ink-muted);"><em>No data entered yet. Use the wizard to add Manual, Upload, Auto-fill, or AI-generated content for this section.</em></p>`
        }
      </div>`
  }
  ${footer(it.page)}
</div>`;
})()}`).join('')}

</body>
</html>`;
}
// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Per-section extraction prompts. Each returns structured JSON matching the
// section's data_schema_hint. Keep these short and concrete.
const SECTION_EXTRACTION_PROMPTS = {
  agenda: `Extract the meeting agenda from this PDF. Return JSON:
{
  "items": [
    { "topic": "string", "presenter": "string or null", "duration_min": <int or null>, "notes": "string or null" }
  ]
}
Return ONLY the JSON, no preamble.`,

  prior_minutes: `This is the previous board meeting minutes. Extract:
{
  "prior_meeting_date": "YYYY-MM-DD or null",
  "summary": "2-3 sentence summary of what happened",
  "motions": [{ "motion": "string", "moved_by": "string", "seconded_by": "string", "result": "passed|failed|tabled" }],
  "action_items_status": [{ "item": "string", "status": "complete|in_progress|carried_forward" }]
}
Return ONLY the JSON, no preamble.`,

  financials: `You are reviewing an HOA financial package. The package usually
contains BOTH a Balance Sheet AND an Income Statement (Statement of Revenues
and Expenses). Either may be present on its own, or both together. The
Income Statement may be:
  (A) Single-period P&L with a Budget column for variance, OR
  (B) 12-month trailing actuals report ("Summary Statement of Revenues and
      Expenses For MM/DD/YYYY") — columns are months.

The Balance Sheet on a Vantaca-style HOA report has FOUR columns that are
FUND-BALANCE columns, not a period-over-period comparison:
  Operating · Reserve · Savings · Total
Each account row populates ONE OR MORE of those fund columns (a cash account
sits in one fund; an "intercompany" line like "Due from Operating to Savings"
can sit in two). The "Total" column is the sum across funds.

Assets are usually grouped under sub-section headers ("Cash", "Accounts
Receivable", "Other Assets") each with its own subtotal row. Same for
Liabilities ("Current Liabilities", "Deferred Revenue", "Prepaids and Other
Liabilities") and Equity ("Current Year Surplus", "Accumulated Fund Balance").
The Balance Sheet always balances: Total Assets = Total Liabilities + Equity.

Extract the data AND write a short Ed-voiced narrative the board can act on.
Output JSON with this exact shape:

{
  "period_start": "YYYY-MM-DD or null",
  "period_end": "YYYY-MM-DD or null",
  "current_period_label": "string — e.g., 'April 2026'",
  "prior_period_label": "string or null — e.g., 'March 2026' or 'April 2025' — the BS comparison column header",

  "balance_sheet": {
    "as_of_date": "YYYY-MM-DD or null",
    "assets": [
      {
        "account": "string — exact GL account name, e.g., '1000 - Operating Cash Account'",
        "operating": <number or null — value in the Operating column for this row, null if blank>,
        "reserve":   <number or null>,
        "savings":   <number or null>,
        "total":     <number — Total column>,
        "sub_section": "string — section header this account sits under, e.g., 'Cash', 'Accounts Receivable', 'Other Assets'"
      }
    ],
    "asset_subtotals": [
      {
        "section": "string — 'Cash' / 'Accounts Receivable' / 'Other Assets' / etc.",
        "operating": <number or null>,
        "reserve":   <number or null>,
        "savings":   <number or null>,
        "total":     <number>
      }
    ],
    "liabilities": [
      { "account": "string", "operating": <number or null>, "reserve": <number or null>, "savings": <number or null>, "total": <number>, "sub_section": "string" }
    ],
    "liability_subtotals": [
      { "section": "string", "operating": <number or null>, "reserve": <number or null>, "savings": <number or null>, "total": <number> }
    ],
    "equity": [
      { "account": "string", "operating": <number or null>, "reserve": <number or null>, "savings": <number or null>, "total": <number>, "sub_section": "string or null" }
    ],
    "equity_subtotals": [
      { "section": "string", "operating": <number or null>, "reserve": <number or null>, "savings": <number or null>, "total": <number> }
    ],
    "totals": {
      "total_assets":               { "operating": <number>, "reserve": <number>, "savings": <number>, "total": <number> },
      "total_liabilities_and_equity": { "operating": <number>, "reserve": <number>, "savings": <number>, "total": <number> }
    },
    "fund_cash_summary": {
      "operating": <number or null — sum of all rows under "Cash" section in the operating column>,
      "reserves":  <number or null — sum under "Cash" in the reserve column>,
      "savings":   <number or null — sum under "Cash" in the savings column>
    }
  },

  "income_statement": {
    "period_label": "string — e.g., 'April 2026' or 'YTD through April 2026'",
    "total_revenue": <number — current-period or YTD revenue, whatever the report's primary column is>,
    "total_expense": <number>,
    "net_income":    <number>,
    "current_period": {
      "revenue": <number — latest-month revenue (rightmost non-Total column on format B; same as total_revenue on format A)>,
      "expense": <number>,
      "net": <number>
    },
    "by_fund": {
      "operating": { "revenue": <number or null>, "expense": <number or null>, "net": <number or null> },
      "reserves":  { "revenue": <number or null>, "expense": <number or null>, "net": <number or null> },
      "savings":   { "revenue": <number or null>, "expense": <number or null>, "net": <number or null> }
    },
    "trailing_months": [
      { "month_label": "May 2025", "revenue": <number>, "expense": <number>, "net": <number> }
      // 12 entries when format (B); empty array when format (A)
    ],
    "line_items": [
      { "account": "string — full GL account name including code", "amount": <number — period or YTD total>, "budget": <number or null — only when format A has a Budget column>, "type": "revenue|expense", "fund": "operating|reserves|savings|other" }
    ]
  },

  "narrative": "Ed-voiced commentary, 120-200 words. Treasurer-grade prose. Cover BOTH statements when both are present: lead with the Balance Sheet headline (cash position by fund — '$X operating, $Y reserves, $Z savings'), call out any material change vs. prior period (e.g., 'Operating cash up $15k from end of March, AR down $5k'). Then turn to the Income Statement: latest-month or YTD net income, key variances or seasonal patterns. End with one sentence on what to watch. Flowing prose, no bullets. Reference the Association by name if visible. Don't invent numbers."
}

EXTRACTION RULES:

Balance Sheet:
- 4 columns: Operating · Reserve · Savings · Total. Each row's values
  populate only the column(s) where the account has a balance — blank
  cells stay null. Total = sum of the three fund columns for that row.
- Section headers visible on the report ("Cash", "Accounts Receivable",
  "Other Assets" under Assets; "Current Liabilities", "Deferred Revenue",
  "Prepaids and Other Liabilities" under Liabilities; "Equity") become
  the "sub_section" value for the rows under them, AND each one has its
  own subtotal row in the PDF (e.g., "Total Cash $292,179.31 $239,285.50
  $196,698.69 $728,163.50"). Capture those subtotals into
  asset_subtotals / liability_subtotals / equity_subtotals.
- "Total Assets" line at the bottom of page 1 goes into
  totals.total_assets. The grand "Total Liabilities / Equity" line on
  page 2 goes into totals.total_liabilities_and_equity (the BS balances,
  so these match).
- "fund_cash_summary": sum the cash + cash-equivalent rows (everything
  under the "Cash" section header) per fund. This is the headline number
  the board cares about — used for the cash KPI cards at the top of the
  rendered Balance Sheet.
- Intercompany lines like "Due from Operating to Savings" or "Due to
  Savings from Operating" populate the column they sit in (look at
  account name + section to disambiguate). They net to zero across the
  full BS but show separately on each side.

Income Statement Format (B) — 12-month trend:
- Column header is "May Jun Jul Aug Sep Oct Nov Dec Jan Feb Mar Apr Total".
- "current_period" = the column IMMEDIATELY LEFT of "Total" (the latest month).
- "trailing_months" = all 12 month columns, oldest to newest.
- "line_items.amount" = the Total column (YTD).
- A 12-month trailing statement typically only shows the OPERATING fund. by_fund.operating gets all the revenue/expense totals; by_fund.reserves and by_fund.savings stay null UNLESS the statement has separate fund sections (sometimes Vantaca exports a multi-fund statement with sub-headers per fund).

Income Statement Format (A) — single period with budget:
- Capture line_items.budget when a Budget column is visible.
- trailing_months stays empty (length 0).

Money values are NUMBERS not strings. Use null for missing. Return ONLY the JSON.`,

  // section_key='drv' is the Deed Restriction Violations summary.
  // Powered by the same extraction prompt that violations_summary used to
  // have (which is now removed — migration 069 consolidates the two).
  drv: `You are reviewing a Vantaca "Violation Report - Detail" PDF for an HOA.
The report lists every violation in a date range, grouped by stage (First
Notice / Second Notice / Certified Letter Notice / Pending Hearing /
Monthly Fine Assessed / Closed) and includes a top "Distribution by Type"
pie summary.

Extract the data AND write a short Ed-voiced narrative the board can act on.
Output JSON with this exact shape:

{
  "report_period": "MM/DD/YYYY - MM/DD/YYYY or null",
  "total_violations": <int>,
  "by_stage": {
    "first_notice": <int>,
    "second_notice": <int>,
    "certified_letter_notice": <int>,
    "pending_hearing": <int>,
    "monthly_fine_assessed": <int>,
    "closed": <int>
  },
  "top_categories": [
    { "category": "string — e.g. 'Trash Cans/Recycling Containers'", "pct": <number 0-100>, "count": <int or null> }
  ],
  "certified_cases": [
    { "address": "string", "homeowner": "string or null", "category": "string", "account": "string or null" }
  ],
  "fine_assessed_cases": [
    { "address": "string", "homeowner": "string or null", "category": "string", "account": "string or null" }
  ],
  "pending_hearing_cases": [
    { "address": "string", "homeowner": "string or null", "category": "string", "hearing_date": "YYYY-MM-DD or null", "account": "string or null" }
  ],
  "top_problem_properties": [
    { "address": "string", "homeowner": "string or null", "violation_count": <int>, "categories": ["string"] }
  ],
  "watchouts": [
    "one-line concerns the board should notice (e.g., 'Landscaping-Flowerbeds dominates Pending Hearing — 8 cases, 47% of pending')"
  ],
  "narrative": "Ed-voiced commentary, 100-160 words. Treasurer-grade prose. Lead with the headline (total violations in the period + closed-to-open ratio). Identify the top 2-3 categories and what they signal about the community. Call out the high-stakes pools specifically: certified §209 letters + fine-assessed + pending hearings. End with one sentence on what to watch. Flowing prose, no bullets. Don't invent numbers."
}

EXTRACTION RULES:
- The "SUMMARY" page lists every stage with a total count, then per-stage breakdowns by category. Capture both.
- The pie chart at the top shows TOP DISTRIBUTION BY TYPE — extract the top 10 percentages and labels.
- Each per-violation row format: "Hearing Date | Details | Address | Homeowner | Account/XN" then "Stage - DATE - processor name" on the next line.
- top_problem_properties: any property that appears 2+ times anywhere in the report. List the address once with the count and the distinct violation categories.
- certified_cases / fine_assessed_cases / pending_hearing_cases: every row in those stage sections (don't sample — the board wants the full list of high-stakes items, which is small enough to enumerate).

The "narrative" field is the headline product. Return ONLY the JSON.`,

  ar_aging: `You are reviewing a Vantaca AR Aging report for a homeowners
association board. The report lists every account with an outstanding balance,
broken down into buckets (0-30 / Over 30 / Over 60 / Over 90 days) and a
"Coll Status" line per account (e.g., "With Attorney", "Violation Collections
- With Attorney", "Board Review", "209 Notice", "Delinquent Balance Reminder",
"Late Notice", "Payment Plan").

Extract the data AND write a short Ed-voiced narrative the board can act on.
Output JSON with this exact shape:

{
  "as_of_date": "YYYY-MM-DD or null",
  "total_ar": <number — the grand total ($77,344.56 type number)>,
  "buckets": { "0_30": <number>, "31_60": <number — the "Over 30" column>, "61_90": <number — the "Over 60" column>, "over_90": <number — the "Over 90" column> },
  "homeowner_count": { "current": <int or null>, "delinquent": <int or null — distinct properties with a balance> },
  "status_summary": {
    "with_attorney": <int — count of accounts whose Coll Status is "With Attorney" or "Violation Collections - With Attorney">,
    "notice_209": <int — count of "209 Notice">,
    "board_review": <int — count of "Board Review">,
    "delinquent_reminder": <int — count of "Delinquent Balance Reminder">,
    "late_notice": <int — count of "Late Notice">,
    "payment_plan": <int — count on a payment plan, if surfaced>,
    "other": <int — any status not in the above buckets>
  },
  "at_legal_accounts": [
    {
      "address": "string — the property address part (e.g., '4819 Harbor Glen Lane')",
      "owner": "string — last name visible after the dash",
      "balance": <number — Balance column>,
      "status": "string — exact Coll Status text",
      "over_90": <number — the Over 90 column for this row>
    }
  ],
  "top_delinquent": [
    {
      "address": "string",
      "owner": "string or null",
      "balance": <number>,
      "over_90": <number>,
      "oldest_charge_days": <int or null>,
      "status": "string — exact Coll Status text"
    }
  ],
  "watchouts": [
    "one-line item for each material concern (e.g., '8 accounts now With Attorney — $25k+ in legal-handled balances', 'Late-fee revenue line is $X — outsized relative to base assessments, may signal collection-process gaps')"
  ],
  "narrative": "Ed-voiced commentary, 100-160 words. Treasurer-grade prose. Lead with the headline state of AR: total + what share is past 90 days. Call out the legal-handled portion specifically — how many accounts are With Attorney + total dollars in that pool. Identify any single account materially larger than the rest (e.g., $15k vs. $700-800 average). End with one sentence on recommended next action. Flowing prose, no bullets. Don't invent numbers."
}

EXTRACTION RULES:
- The top "Charge" section ("Annual Assessment (71) $47,290.26" etc.) is a count + total per charge type. The number in parentheses is HOW MANY accounts owe that charge type. Total at the bottom of that section ($77,344.56) is the grand total — use that for total_ar.
- The "SUMMARY" pie chart shows distribution: 0-30 / Over 30 / Over 60 / Over 90 percentages. Cross-check against your computed sums.
- Per-property rows have format "2012515 - 4819 Harbor Glen Lane - Berry" followed by "Coll Status: ...". Extract the property address (middle segment) and owner last name (after the second dash).
- at_legal_accounts: every account whose status starts with "With Attorney" OR "Violation Collections" — sort by balance desc.
- top_delinquent: top 15 by balance, EXCLUDING the at_legal accounts already in that list (board sees them separately above).
- A typical recurring-delinquent balance is one annual assessment ($719) plus small late fees ($17-50). Don't bother flagging these individually; they're the baseline. Material accounts are $1,000+.

The "narrative" field is the headline product. Return ONLY the JSON.`,

  arc_decisions: `Extract ARC (Architectural Review Committee) decisions from this PDF:
{
  "decisions": [
    { "address": "string", "request": "string", "status": "approved|denied|tabled|withdrawn", "date": "YYYY-MM-DD or null", "notes": "string or null" }
  ]
}
Return ONLY the JSON.`,

  appendix: `This is a supporting document for the board packet. Return a brief description:
{
  "title": "string (short title)",
  "summary": "1-2 sentence description of what this document contains",
  "doc_type": "string (e.g., 'insurance certificate', 'vendor proposal', 'legal notice')"
}
Return ONLY the JSON.`
};

async function extractSectionFromPdf(sectionKey, pdfBuffer) {
  const prompt = SECTION_EXTRACTION_PROMPTS[sectionKey];
  if (!prompt) throw new Error(`No extraction prompt defined for section: ${sectionKey}`);
  const pdfBase64 = pdfBuffer.toString('base64');
  const RETRY_DELAYS_MS = [30000, 60000, 90000];
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        // Fund-balance BS + 12-month IS extractions can produce 6-10k tokens
        // of structured JSON. Stay generous to avoid mid-string truncation.
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
      const text = completion.content?.[0]?.text || '';
      const stopReason = completion.stop_reason;
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        return { parsed: JSON.parse(cleaned), usage: completion.usage };
      } catch (parseErr) {
        const truncated = stopReason === 'max_tokens';
        const hint = truncated
          ? ` Model hit max_tokens (${completion.usage?.output_tokens}) — output truncated before close. Consider bumping max_tokens or tightening the prompt.`
          : ` Response text (${cleaned.length} chars) was not valid JSON.`;
        const err = new Error(`Extraction returned malformed JSON.${hint} Parse error: ${parseErr.message}`);
        err.rawText = cleaned.slice(0, 500);
        throw err;
      }
    } catch (err) {
      lastError = err;
      const isRetryable = err.status === 429 || err.status === 529 ||
                          /rate_limit|overloaded/i.test(err.message || '');
      if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[board_packets] the AI rate-limited, retrying in ${delay/1000}s (attempt ${attempt+1})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// Seed sections for a newly-created packet from the section templates.
// If includedSectionKeys is provided (array of section_key strings), only
// those sections get status='pending'; the rest get status='skipped'.
// If not provided, falls back to the template's required_default flag.
async function seedSectionsForPacket(packetId, includedSectionKeys = null) {
  const { data: templates } = await supabase
    .from('board_packet_section_templates')
    .select('*')
    .order('default_order');
  if (!templates || templates.length === 0) return;
  const rows = templates.map(t => {
    let status;
    if (Array.isArray(includedSectionKeys)) {
      status = includedSectionKeys.includes(t.section_key) ? 'pending' : 'skipped';
    } else {
      status = t.required_default ? 'pending' : 'skipped';
    }
    return {
      packet_id: packetId,
      section_key: t.section_key,
      section_order: t.default_order,
      input_mode: t.supports_ai_generated ? 'ai_generated' :
                  t.supports_manual ? 'manual' :
                  t.supports_upload ? 'upload' : 'manual',
      status
    };
  });
  await supabase.from('board_packet_sections').insert(rows);
}

// ----------------------------------------------------------------------------
// GET /api/board-packets/templates  — canonical section templates
// ----------------------------------------------------------------------------
router.get('/templates', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('board_packet_section_templates')
      .select('*')
      .order('default_order');
    if (error) throw error;
    res.json({ templates: data || [] });
  } catch (err) {
    console.error('[board_packets] templates fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets  — create a new draft packet
// Body: { community_id, period_label, meeting_date?, meeting_time?,
//         meeting_type?, meeting_format?, meeting_location? }
// ----------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { community_id, period_label, meeting_date, meeting_time,
            meeting_type, meeting_format, meeting_location, notes,
            included_sections } = req.body || {};
    if (!community_id || !period_label) {
      return res.status(400).json({ error: 'community_id and period_label required' });
    }
    // Check for duplicate (community, period_label)
    const { data: existing } = await supabase
      .from('board_packets')
      .select('id, status')
      .eq('community_id', community_id)
      .eq('period_label', period_label)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({
        error: `Packet already exists for this community + period (status: ${existing.status})`,
        existing_id: existing.id
      });
    }
    const packetId = crypto.randomUUID();
    const { data: packet, error } = await supabase
      .from('board_packets')
      .insert({
        id: packetId,
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id,
        period_label,
        meeting_date: meeting_date || null,
        meeting_time: meeting_time || null,
        meeting_type: meeting_type || 'regular',
        meeting_format: meeting_format || null,
        meeting_location: meeting_location || null,
        notes: notes || null,
        status: 'draft'
      })
      .select()
      .single();
    if (error) throw error;
    await seedSectionsForPacket(
      packetId,
      Array.isArray(included_sections) && included_sections.length > 0 ? included_sections : null
    );

    // Trade tape
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id,
      module: 'board_packets',
      endpoint: 'POST /api/board-packets',
      request_input: { community_id, period_label, meeting_date },
      response: { packet_id: packetId }
    });

    res.json({ ok: true, packet });
  } catch (err) {
    console.error('[board_packets] create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets  — list packets (filter by community, status)
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('v_board_packet_summary')
      .select('*')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('meeting_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q.limit(Number(req.query.limit) || 100);
    if (error) throw error;
    res.json({ packets: data || [] });
  } catch (err) {
    console.error('[board_packets] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id  — packet + ordered sections
// ----------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data: packet, error: pErr } = await supabase
      .from('board_packets')
      .select('*, community:communities(id, name, legal_name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!packet) return res.status(404).json({ error: 'Packet not found' });
    const { data: sections, error: sErr } = await supabase
      .from('board_packet_sections')
      .select('*, template:board_packet_section_templates(*)')
      .eq('packet_id', req.params.id)
      .order('section_order');
    if (sErr) throw sErr;
    res.json({ packet, sections: sections || [] });
  } catch (err) {
    console.error('[board_packets] detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/board-packets/:id  — update packet metadata
// ----------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['period_label', 'meeting_date', 'meeting_time', 'meeting_type',
                     'meeting_format', 'meeting_location', 'status', 'notes',
                     'ai_exec_summary', 'ai_watch_outs', 'ai_action_items'];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields' });
    const { data, error } = await supabase
      .from('board_packets')
      .update(update)
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({ packet: data });
  } catch (err) {
    console.error('[board_packets] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/board-packets/:id
// ----------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('board_packets')
      .delete()
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[board_packets] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PATCH /api/board-packets/:id/sections/:section_key
// Body: { input_data?, input_mode?, status?, notes? }
// ----------------------------------------------------------------------------
router.patch('/:id/sections/:section_key', async (req, res) => {
  try {
    const allowed = ['input_data', 'input_mode', 'status', 'notes', 'rendered_html'];
    const update = {};
    for (const k of allowed) if (k in (req.body || {})) update[k] = req.body[k];
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no updatable fields' });
    // If they're providing input_data and no explicit status, flip to 'ready'
    if (update.input_data && !update.status) update.status = 'ready';
    const { data, error } = await supabase
      .from('board_packet_sections')
      .update(update)
      .eq('packet_id', req.params.id)
      .eq('section_key', req.params.section_key)
      .select()
      .single();
    if (error) throw error;
    res.json({ section: data });
  } catch (err) {
    console.error('[board_packets] section patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/sections/:section_key/upload
// Upload a PDF for a section. the AI extracts structured data using the
// section-specific prompt.
// ----------------------------------------------------------------------------
router.post('/:id/sections/:section_key/upload', upload.single('pdf'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (expected field "pdf")' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
    }
    const sectionKey = req.params.section_key;
    if (!SECTION_EXTRACTION_PROMPTS[sectionKey]) {
      return res.status(400).json({ error: `Section "${sectionKey}" does not support upload extraction` });
    }
    // Run the AI
    const { parsed, usage } = await extractSectionFromPdf(sectionKey, req.file.buffer);
    // Save to the section row
    const { data: section, error } = await supabase
      .from('board_packet_sections')
      .update({
        input_mode: 'upload',
        input_data: parsed,
        status: 'ready',
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: 'medium',
        extraction_notes: `Uploaded ${req.file.originalname} (${req.file.size} bytes)`
      })
      .eq('packet_id', req.params.id)
      .eq('section_key', sectionKey)
      .select()
      .single();
    if (error) throw error;

    // Trade tape
    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      module: 'board_packets',
      endpoint: `POST /api/board-packets/${req.params.id}/sections/${sectionKey}/upload`,
      request_input: { filename: req.file.originalname, size: req.file.size, section: sectionKey },
      prompt: `SECTION_EXTRACTION_PROMPTS[${sectionKey}]`,
      model: 'claude-sonnet-4-5',
      response: { parsed },
      input_tokens: usage?.input_tokens || null,
      output_tokens: usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({ ok: true, section, extracted: parsed, duration_ms: Date.now() - t0 });
  } catch (err) {
    console.error('[board_packets] section upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/sections/:section_key/auto-fill
// STUB today. Once universal askEd / module integrations ship, this calls the
// appropriate trustEd module to pull live data (financials, vendors, etc.).
// ----------------------------------------------------------------------------
router.post('/:id/sections/:section_key/auto-fill', async (req, res) => {
  try {
    // Day 1 stub: return a friendly "not yet" message rather than failing.
    res.status(501).json({
      error: 'auto_fill_not_yet_available',
      message: 'Auto-fill from trustEd modules ships after the universal askEd build (next push). For now, use Manual or Upload mode.',
      section_key: req.params.section_key
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/sections/:section_key/ai-generate
// AI-generates content for sections like exec_summary, action_items.
// Reads all OTHER sections' input_data, gives the AI full context, asks for
// the section in Bedrock voice using askEd 4-part template structure.
// ----------------------------------------------------------------------------
router.post('/:id/sections/:section_key/ai-generate', async (req, res) => {
  const t0 = Date.now();
  try {
    const sectionKey = req.params.section_key;
    // Get the packet + all sections for context
    const { data: packet } = await supabase
      .from('board_packets')
      .select('*, community:communities(name)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!packet) return res.status(404).json({ error: 'Packet not found' });
    const { data: sections } = await supabase
      .from('board_packet_sections')
      .select('section_key, input_data, status')
      .eq('packet_id', req.params.id);

    // Build context from ready sections (excluding this one)
    const contextSections = (sections || [])
      .filter(s => s.section_key !== sectionKey && s.status === 'ready' && s.input_data)
      .map(s => `[${s.section_key}]\n${JSON.stringify(s.input_data, null, 2)}`)
      .join('\n\n');

    let prompt;
    if (sectionKey === 'exec_summary') {
      prompt = `You are writing the Executive Summary for the ${packet.community?.name} board meeting on ${packet.meeting_date || packet.period_label}.

Use Bedrock voice: confident, plain English, treasurer-grade clarity. NOT corporate jargon. The audience is volunteer board members who may not be financial experts. Write what they NEED to know, not what you CAN say.

Length: 3-4 short paragraphs.

The packet data assembled so far:
${contextSections || '(no sections completed yet)'}

Return JSON:
{
  "text": "the full executive summary, paragraph-broken with \\n\\n",
  "key_points": ["3-5 bullet points highlighting the most important items"]
}

Return ONLY the JSON, no preamble.`;
    } else if (sectionKey === 'action_items') {
      prompt = `You are consolidating Action Items & Watch Outs for the ${packet.community?.name} board meeting.

Look across all the packet data and identify:
- Items requiring board decision or approval
- Items that need follow-up from a prior meeting
- Issues that should be on the board's radar (variances >10%, expiring contracts, delinquencies trending up, etc.)

Use askEd voice for Watch Outs: each one should explain WHAT, WHY IT MATTERS, and WHAT TO DO.

Packet data:
${contextSections || '(no sections completed yet)'}

Return JSON:
{
  "items": [
    { "item": "string (concise action)", "owner": "Board|Manager|Treasurer|Ed|Other (string)", "due_date": "YYYY-MM-DD or null", "priority": "high|medium|low", "source": "which section this came from (string)" }
  ]
}

Return ONLY the JSON.`;
    } else if (sectionKey === 'cover') {
      // Cover is structured metadata, not AI-generated narrative. Just assemble.
      const coverData = {
        community: packet.community?.name,
        meeting_date: packet.meeting_date,
        meeting_time: packet.meeting_time,
        meeting_type: packet.meeting_type,
        meeting_format: packet.meeting_format,
        meeting_location: packet.meeting_location,
        period_label: packet.period_label
      };
      const { data: section, error } = await supabase
        .from('board_packet_sections')
        .update({
          input_mode: 'ai_generated',
          input_data: coverData,
          status: 'ready'
        })
        .eq('packet_id', req.params.id)
        .eq('section_key', sectionKey)
        .select()
        .single();
      if (error) throw error;
      return res.json({ ok: true, section, generated: coverData, duration_ms: Date.now() - t0 });
    } else {
      return res.status(400).json({ error: `Section "${sectionKey}" does not support AI generation` });
    }

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = completion.content?.[0]?.text || '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const { data: section, error } = await supabase
      .from('board_packet_sections')
      .update({
        input_mode: 'ai_generated',
        input_data: parsed,
        status: 'ready',
        extraction_model: 'claude-sonnet-4-5',
        extraction_confidence: 'medium'
      })
      .eq('packet_id', req.params.id)
      .eq('section_key', sectionKey)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('agent_runs').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: packet.community_id,
      module: 'board_packets',
      endpoint: `POST /api/board-packets/${req.params.id}/sections/${sectionKey}/ai-generate`,
      request_input: { section: sectionKey },
      prompt: 'AI section generation',
      model: 'claude-sonnet-4-5',
      response: parsed,
      input_tokens: completion.usage?.input_tokens || null,
      output_tokens: completion.usage?.output_tokens || null,
      duration_ms: Date.now() - t0
    });

    res.json({ ok: true, section, generated: parsed, duration_ms: Date.now() - t0 });
  } catch (err) {
    console.error('[board_packets] AI generate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/render
// Day 1 stub: returns the assembled HTML using the design language. Day 3
// will store the rendered HTML/PDF in Supabase Storage and update
// rendered_html_path / rendered_pdf_path.
// ----------------------------------------------------------------------------
router.post('/:id/render', async (req, res) => {
  try {
    // Day 1: thin stub — just mark rendered_at, return placeholder
    const { data: packet, error } = await supabase
      .from('board_packets')
      .update({ rendered_at: new Date().toISOString(), status: 'in_review' })
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .select()
      .single();
    if (error) throw error;
    res.json({
      ok: true,
      packet,
      message: 'Render scaffolded. Full HTML/PDF renderer ships Day 3 — sections are saved and ready for assembly.'
    });
  } catch (err) {
    console.error('[board_packets] render failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id/preview
// Renders the packet as Bedrock-branded HTML using the design language from
// /public/board_packet_preview.html — community hero (if available), branded
// cover, Table of Contents reflecting only non-skipped sections, plus a
// placeholder page per section showing the structured data.
//
// Day 3 will replace section placeholders with per-section renderers
// (financial tables, agenda formatting, exec-summary prose, etc.).
// ----------------------------------------------------------------------------
router.get('/:id/preview', async (req, res) => {
  try {
    // Main packet load — kept minimal so a missing column from a not-yet-run
    // migration can't take the whole Preview down. The logo enrichment is a
    // separate, gracefully-failing query below.
    const { data: packet } = await supabase
      .from('board_packets')
      .select('*, community:communities(id, name, legal_name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!packet) return res.status(404).send('<h1>Packet not found</h1>');

    // Logo enrichment — try to fetch logo_storage_path + sign a URL. If the
    // column doesn't exist yet (migration 066 not run), skip silently and
    // render without the custom logo.
    if (packet.community && packet.community.id) {
      try {
        const { data: logoRow } = await supabase
          .from('communities')
          .select('logo_storage_path')
          .eq('id', packet.community.id)
          .maybeSingle();
        if (logoRow && logoRow.logo_storage_path) {
          packet.community.logo_storage_path = logoRow.logo_storage_path;
          const { data: signed } = await supabase.storage
            .from('documents').createSignedUrl(logoRow.logo_storage_path, 60 * 60 * 24);
          if (signed) packet.community.logo_signed_url = signed.signedUrl;
        }
      } catch (e) {
        console.warn('[board_packets] logo enrichment skipped:', e.message);
      }
    }

    const { data: sections } = await supabase
      .from('board_packet_sections')
      .select('*, template:board_packet_section_templates(display_name, description)')
      .eq('packet_id', req.params.id)
      .order('section_order');

    // Volume number was removed — it didn't read like meaningful context
    // alongside the meeting date. Period label alone is cleaner.
    let volume = null;
    const html = renderPacketPreviewHtml({ packet, sections: sections || [], volume });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[board_packets] preview failed:', err.message);
    res.status(500).send(`<h1>Preview failed</h1><pre>${String(err.message).replace(/</g,'&lt;')}</pre>`);
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id/sections/:section_key/preview
// Renders ONE section as a standalone Bedrock-branded HTML page. Operator
// uses this to spot-check what the board will see before approving the
// final packet. Per-section preview is the right place to review the
// AI-voiced commentary on Financials / AR Aging / DRV before lock-in.
// ----------------------------------------------------------------------------
router.get('/:id/sections/:section_key/preview', async (req, res) => {
  try {
    const { data: packet } = await supabase
      .from('board_packets')
      .select('*, community:communities(id, name, legal_name)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!packet) return res.status(404).send('<h1>Packet not found</h1>');

    if (packet.community && packet.community.id) {
      try {
        const { data: logoRow } = await supabase
          .from('communities').select('logo_storage_path')
          .eq('id', packet.community.id).maybeSingle();
        if (logoRow && logoRow.logo_storage_path) {
          const { data: signed } = await supabase.storage
            .from('documents').createSignedUrl(logoRow.logo_storage_path, 60 * 60 * 24);
          if (signed) packet.community.logo_signed_url = signed.signedUrl;
        }
      } catch (_) {}
    }

    const { data: section } = await supabase
      .from('board_packet_sections')
      .select('*, template:board_packet_section_templates(display_name, description)')
      .eq('packet_id', req.params.id)
      .eq('section_key', req.params.section_key)
      .maybeSingle();
    if (!section) return res.status(404).send('<h1>Section not found</h1>');

    const embed = req.query.embed === '1' || req.query.embed === 'true';
    const html = renderSectionStandaloneHtml({ packet, section, embed });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[board_packets] preview failed:', err.message);
    res.status(500).send(`<h1>Preview failed</h1><pre>${String(err.message).replace(/</g,'&lt;')}</pre>`);
  }
});

// ----------------------------------------------------------------------------
// POST /api/board-packets/:id/distribute
// Body: { recipients: [...], method: 'email'|'download'|'print'|'share_link', notes? }
// ----------------------------------------------------------------------------
router.post('/:id/distribute', async (req, res) => {
  try {
    const { recipients, method, notes } = req.body || {};
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients array required' });
    }
    if (!method) return res.status(400).json({ error: 'method required' });
    const rows = recipients.map(r => ({
      packet_id: req.params.id,
      distributed_to: typeof r === 'string' ? r : (r.email || r.name || 'unknown'),
      distribution_method: method,
      notes: notes || null
    }));
    const { error } = await supabase.from('board_packet_distribution_log').insert(rows);
    if (error) throw error;
    // Optionally bump packet status to distributed
    if (method === 'email' || method === 'share_link') {
      await supabase
        .from('board_packets')
        .update({ status: 'distributed' })
        .eq('id', req.params.id);
    }
    res.json({ ok: true, distributed: rows.length });
  } catch (err) {
    console.error('[board_packets] distribute failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-packets/:id/distribution
// ----------------------------------------------------------------------------
router.get('/:id/distribution', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('board_packet_distribution_log')
      .select('*')
      .eq('packet_id', req.params.id)
      .order('distributed_at', { ascending: false });
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[board_packets] distribution log failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
