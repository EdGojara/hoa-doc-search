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
  const heroStyle = assets.hero
    ? `background: linear-gradient(180deg, rgba(31,58,95,0.25) 0%, rgba(31,58,95,0.45) 55%, rgba(31,58,95,0.85) 100%), url('${assets.hero}') center/cover;`
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
    <div class="cover-period">${esc(packet.period_label || '')} ${volume ? `· Volume ${volume}` : ''}</div>
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

<!-- SECTION PLACEHOLDER PAGES (Day 3 will replace with real renders) -->
${tocItems.map(it => `
${(() => {
  const sec = sections.find(s => s.section_key === it.sectionKey) || {};
  const data = sec.input_data;
  const isAgendaText = sec.section_key === 'agenda' && data?.format === 'text' && data?.text;
  const isExecSummaryText = sec.section_key === 'exec_summary' && (data?.text || typeof data === 'string');
  return `<div class="page interior">
  ${pageHeader}
  <div class="section-eyebrow">${esc(it.num)} of ${tocItems.length}</div>
  <h1 class="section-title">${esc(it.title)}</h1>
  ${it.description ? `<p class="section-lede">${esc(it.description)}</p>` : ''}
  ${isAgendaText
    ? `<div style="white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: var(--ink);">${esc(data.text)}</div>`
    : isExecSummaryText
    ? `<div style="font-size: 14px; line-height: 1.65; color: var(--ink); white-space: pre-wrap;">${esc(data.text || data)}</div>`
    : `<div class="section-placeholder">
        <h4>
          Section data ${it.hasData ? '<span class="badge badge-ready">ready</span>' : '<span class="badge badge-pending">pending</span>'}
          <span class="badge badge-mode">${esc(it.inputMode)}</span>
        </h4>
        <p>Day 3 ships per-section Bedrock-branded renderers (charts, tables, formatted narrative). Below: structured data as currently stored.</p>
        ${it.hasData
          ? `<pre>${esc(JSON.stringify(data, null, 2))}</pre>`
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

  financials: `You are reviewing an HOA financial statement (P&L, Balance Sheet, or
both). Extract the data AND write a short Ed-voiced narrative the board can
act on. Output JSON with this exact shape:

{
  "period_start": "YYYY-MM-DD or null",
  "period_end": "YYYY-MM-DD or null",
  "total_revenue": <number or null>,
  "total_expense": <number or null>,
  "net_income": <number or null>,
  "cash_operating": <number or null>,
  "cash_reserves": <number or null>,
  "line_items": [{ "account": "string", "amount": <number>, "budget": <number or null>, "type": "revenue|expense|asset|liability|equity" }],
  "narrative": "Ed-voiced commentary, 100-180 words. Treasurer-grade prose. Lead with the headline (net income vs. budget, cash position vs. typical month). Call out 2-3 line items with material variance and what's driving them if visible. Note reserves position relative to operating. End with one sentence on what to watch. Flowing prose, no bullets. Reference the Association by name if visible. Don't invent numbers."
}

Money values are NUMBERS not strings. Use null for missing. Return ONLY the JSON.`,

  drv: `You are reviewing a Vantaca / Doctivity budget-to-actual variance report
for an HOA. Extract the data AND write a short Ed-voiced narrative the board
can act on. Output JSON with this exact shape:

{
  "period": "string (e.g. 'YTD April 2026' or 'May 2026') or null",
  "variances": [
    { "category": "string", "budget": <number>, "actual": <number>, "variance": <number>, "variance_pct": <number>, "commentary": "one-line note about WHY this varied if you can tell from the doc, else null" }
  ],
  "watchouts": [
    "one-line item for each variance >10% or >$2,500 that the board should notice"
  ],
  "narrative": "Ed-voiced commentary, 80-150 words. Tone: direct, treasurer-grade, pragmatic. Lead with the headline ('Operating expenses are running 4% under budget YTD'); identify 2-3 specific categories with material variance and what's driving them if visible; end with one sentence on what to watch or recommend. No bullet points in the narrative — flowing prose. Reference the Association by name if you can read it off the document. Do NOT invent numbers; only commentary on what's actually in the report."
}

The "narrative" field is the headline product — it's what a board member skims first. The structured data is the audit trail underneath. Return ONLY the JSON.`,

  ar_aging: `You are reviewing an Accounts Receivable / delinquencies aging report
from a Vantaca-style HOA accounting export. Extract the data AND write a short
Ed-voiced narrative the board can act on. Output JSON with this exact shape:

{
  "as_of_date": "YYYY-MM-DD or null",
  "total_ar": <number>,
  "buckets": { "0_30": <number>, "31_60": <number>, "61_90": <number>, "over_90": <number> },
  "homeowner_count": { "current": <int or null>, "delinquent": <int or null> },
  "top_delinquent": [
    { "unit": "string", "owner": "string or null", "balance": <number>, "oldest_charge_days": <int or null>, "status": "string or null" }
  ],
  "watchouts": [
    "one-line item for each material concern (e.g., 'Unit 12 is $4,200 over 90 days — recommend collections referral')"
  ],
  "narrative": "Ed-voiced commentary, 80-150 words. Tone: direct, treasurer-grade, pragmatic. Lead with the headline state of AR ('Receivables are in excellent shape — $0 outstanding across all buckets' OR 'Total AR sits at $X with $Y past 90 days'). Identify 1-3 specific accounts or buckets that need attention. End with one sentence on the recommended next action (offer payment plans, refer to attorney, etc.) OR confirm no action needed if the book is clean. No bullet points in the narrative — flowing prose. Do NOT invent numbers; commentary on what's actually in the report only."
}

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
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      });
      const text = completion.content?.[0]?.text || '';
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return { parsed: JSON.parse(cleaned), usage: completion.usage };
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
    const { data: packet } = await supabase
      .from('board_packets')
      .select('*, community:communities(id, name, legal_name, logo_storage_path, logo_mime_type)')
      .eq('id', req.params.id)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (!packet) return res.status(404).send('<h1>Packet not found</h1>');

    // Generate a signed URL for the community logo so the HTML <img> can
    // load it. 24h expiry so the preview survives a printer round-trip.
    if (packet.community && packet.community.logo_storage_path) {
      try {
        const { data: signed } = await supabase.storage
          .from('documents').createSignedUrl(packet.community.logo_storage_path, 60 * 60 * 24);
        if (signed) packet.community.logo_signed_url = signed.signedUrl;
      } catch (_) {}
    }

    const { data: sections } = await supabase
      .from('board_packet_sections')
      .select('*, template:board_packet_section_templates(display_name, description)')
      .eq('packet_id', req.params.id)
      .order('section_order');

    // Volume number = how many packets exist for this community up to and
    // including this one's meeting date. Adds a nice Bedrock touch ("Volume 4").
    let volume = 1;
    if (packet.community_id) {
      const { count } = await supabase
        .from('board_packets')
        .select('id', { count: 'exact', head: true })
        .eq('community_id', packet.community_id)
        .lte('meeting_date', packet.meeting_date || '9999-12-31');
      volume = Math.max(1, count || 1);
    }

    const html = renderPacketPreviewHtml({ packet, sections: sections || [], volume });
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
