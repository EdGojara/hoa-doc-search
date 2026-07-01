// ============================================================================
// lib/insurance_rfp.js  (Ed 2026-07-01)
// ----------------------------------------------------------------------------
// The RENDER stage of the Bedrock Insurance RFP capability. Turns a validated
// `insurance_program` object (produced by scripts/extract_insurance_program.js
// from the current policies) into a polished, Bedrock-branded Request for
// Proposal a broker can quote from — the IMPORTANT aspects of the current
// program only, NOT the raw policy forms.
//
// Why this exists: on a renewal a broker asks for "the current package." Ed
// does NOT want to hand competitors the full policy — he wants a clean, uniform
// spec sheet so multiple brokers quote apples-to-apples without exposing the
// policy. Standardized RFP = comparable bids + protected IP.
//
// Two-stage discipline (CLAUDE.md): extract (script) → render (here). This file
// never touches a raw PDF; it only renders validated structured input.
//
// Record ownership: an RFP sent to a broker on behalf of the association is an
// `association_record` (correspondence on behalf of the HOA). The underlying
// extracted JSON is a `workpaper`.
//
//   renderInsuranceRfpHTML(program, opts) -> HTML string  (feed to puppeteer)
// ============================================================================

const path = require('path');
const fs = require('fs');
const BRAND = require('./brand');

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');
const LOGO_ALIASES = {
  'Lakes of Pine Forest': 'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch': 'canyon_gate_logo.png',
  'Canyon Gate': 'canyon_gate_logo.png',
  'Waterview Estates': 'waterview_logo.jpg',
  'Waterview': 'waterview_logo.jpg',
  'August Meadows': 'august_meadows_logo.png',
  'Still Creek Ranch': 'still_creek_ranch_logo.png',
};

function loadLogoDataUri(filename) {
  try {
    const p = path.join(LOGOS_DIR, filename);
    const buf = fs.readFileSync(p);
    const ext = filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
    return `data:image/${ext};base64,${buf.toString('base64')}`;
  } catch (_) { return null; }
}
function getCommunityLogoDataUri(community) {
  const file = LOGO_ALIASES[community];
  return file ? loadLogoDataUri(file) : null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const dash = (v) => (v == null || v === '' ? '—' : escapeHtml(v));

// A coverage line renders as a labeled card. Limits/deductibles are lists so
// GL (occurrence + aggregate) and Crime (several insuring agreements) render
// their full structure — the granularity a broker needs to match.
function renderCoverageCard(c, opts) {
  const limits = (c.limits || []).filter((l) => l && (l.label || l.amount));
  const deducts = (c.deductibles || []).filter((d) => d && (d.label || d.amount));
  const terms = (c.key_terms || []).filter(Boolean);
  const rows = [];
  if (opts.includeCarrier) rows.push(['Current carrier', dash(c.carrier)]);
  rows.push(['Policy period', `${dash(c.effective_date)} &nbsp;→&nbsp; ${dash(c.expiration_date)}`]);
  if (limits.length) rows.push(['Limits', `<ul class="tight">${limits.map((l) => `<li><b>${dash(l.amount)}</b>${l.label ? ' — ' + escapeHtml(l.label) : ''}</li>`).join('')}</ul>`]);
  else rows.push(['Limits', '—']);
  rows.push(['Deductible / retention', deducts.length ? `<ul class="tight">${deducts.map((d) => `<li><b>${dash(d.amount)}</b>${d.label ? ' — ' + escapeHtml(d.label) : ''}</li>`).join('')}</ul>` : '—']);
  if (terms.length) rows.push(['Key terms to match', `<ul class="tight">${terms.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`]);
  if (opts.includePremium) rows.push(['Expiring annual premium', dash(c.annual_premium)]);
  return `
  <div class="cov">
    <div class="cov-head">${dash(c.line)}</div>
    <table class="cov-tbl">
      ${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join('')}
    </table>
  </div>`;
}

function renderInsuranceRfpHTML(program, opts = {}) {
  const o = {
    includeCarrier: opts.includeCarrier !== false,   // default show incumbent (broker needs it to pull loss runs)
    includePremium: opts.includePremium === true,    // default WITHHOLD expiring premium (Ed 2026-07-01): don't
                                                     // let brokers anchor to what you pay — force honest market pricing

    community: opts.community || program?.entity?.named_insured || '',
    renewalDate: opts.renewalDate || null,           // e.g. 'September 1, 2026'
    submissionDeadline: opts.submissionDeadline || null,
    rfpDate: opts.rfpDate || null,                   // rendered date string (caller supplies — no Date.now here)
    contactName: opts.contactName || 'Laurie Vrvilo',
    contactEmail: opts.contactEmail || 'laurie@bedrocktx.com',
    contactPhone: opts.contactPhone || BRAND.service.phone,
    managerName: opts.managerName || 'Martha Bravo',
  };
  const ent = program.entity || {};
  const coverages = (program.coverages || []).filter((c) => c && c.line);
  const sov = (program.statement_of_values || []).filter((s) => s && (s.description || s.value));
  const notes = (program.notes || []).filter(Boolean);
  const logoDataUri = getCommunityLogoDataUri(o.community);

  const linesRequested = coverages.map((c) => c.line).filter((v, i, a) => a.indexOf(v) === i);

  const entRows = [
    ['Named insured', dash(ent.named_insured)],
    ['Property location', dash(ent.property_location || ent.mailing_address)],
    ['Association type', dash(ent.association_type)],
    ['Units / lots', dash(ent.units_or_lots)],
    ['Year established / built', dash(ent.year_built_or_established)],
    ['Managing agent', `${escapeHtml(BRAND.service.name)} — ${escapeHtml(BRAND.service.addressInline)}`],
  ];

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0.6in 0.7in; }
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Cambria, Georgia, serif; color: #10151f; font-size: 11.5pt; line-height: 1.42; margin: 0; }
  .logo-wrap { text-align: center; margin-bottom: 6px; }
  .logo-wrap img { max-height: 96px; max-width: 210px; }
  .mgr { text-align: center; color: ${BRAND.colors.stone}; font-size: 9.5pt; letter-spacing: .02em; margin-bottom: 14px; }
  .rfp-title { text-align: center; font-weight: 700; font-size: 15pt; color: ${BRAND.colors.navy}; letter-spacing: .02em; margin: 4px 0 2px; }
  .rfp-sub { text-align: center; color: ${BRAND.colors.stone}; font-size: 10.5pt; margin-bottom: 4px; }
  .rule { height: 3px; background: ${BRAND.colors.gold}; width: 78px; margin: 8px auto 16px; border-radius: 2px; }
  h2 { font-size: 12pt; color: ${BRAND.colors.navy}; border-bottom: 1px solid #d8dee8; padding-bottom: 3px; margin: 20px 0 9px; letter-spacing: .01em; }
  p { margin: 7px 0; }
  table { border-collapse: collapse; width: 100%; }
  .meta td { padding: 3px 8px 3px 0; vertical-align: top; font-size: 11pt; }
  .meta td.k { color: ${BRAND.colors.stone}; white-space: nowrap; width: 32%; }
  .cov { border: 1px solid #dce2ec; border-left: 3px solid ${BRAND.colors.gold}; border-radius: 4px; margin: 10px 0; break-inside: avoid; }
  .cov-head { background: ${BRAND.colors.navy}; color: #fff; font-weight: 700; font-size: 11pt; padding: 6px 11px; border-radius: 2px 2px 0 0; letter-spacing: .02em; }
  .cov-tbl { width: 100%; }
  .cov-tbl td { padding: 5px 11px; border-top: 1px solid #eef1f6; vertical-align: top; }
  .cov-tbl td.k { color: ${BRAND.colors.stone}; width: 32%; font-size: 10.5pt; }
  .cov-tbl td.v { font-size: 11pt; }
  ul.tight { margin: 0; padding-left: 16px; } ul.tight li { margin: 1px 0; }
  .sov td, .sov th { border: 1px solid #dce2ec; padding: 5px 8px; font-size: 10.5pt; text-align: left; }
  .sov th { background: ${BRAND.colors.lightGray}; color: ${BRAND.colors.navy}; }
  .callout { border: 1px solid ${BRAND.colors.navy}; border-left: 4px solid ${BRAND.colors.gold}; background: #FAFAF6; padding: 10px 13px; margin: 10px 0; border-radius: 3px; }
  .foot { margin-top: 22px; border-top: 1px solid #d8dee8; padding-top: 8px; color: ${BRAND.colors.stone}; font-size: 8.7pt; line-height: 1.35; }
  ol.subm { margin: 6px 0 0; padding-left: 18px; } ol.subm li { margin: 3px 0; }
  </style></head><body>

  <div class="logo-wrap">
    ${logoDataUri ? `<img src="${logoDataUri}" alt="${escapeHtml(o.community)}">` : `<div style="font-family:Georgia,serif;font-size:20pt;font-weight:700;color:${BRAND.colors.navy}">${escapeHtml(o.community)}</div>`}
  </div>
  <div class="mgr">Managed by ${escapeHtml(BRAND.service.name)}</div>

  <div class="rfp-title">REQUEST FOR PROPOSAL</div>
  <div class="rfp-sub">Property &amp; Casualty Insurance — Renewal${o.renewalDate ? ` &middot; Effective ${escapeHtml(o.renewalDate)}` : ''}</div>
  <div class="rule"></div>

  <p>${escapeHtml(BRAND.service.name)}, managing agent for <b>${dash(ent.named_insured)}</b>, invites your agency to submit a proposal for the association's insurance program on the terms summarized below. This summary reflects the association's current coverage; please quote each line to meet or improve upon it. Kindly note any material differences from the specifications shown.</p>

  <h2>Association Profile</h2>
  <table class="meta">${entRows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</table>

  <h2>Coverage Requested${o.includePremium ? '' : ''}</h2>
  <p style="margin-top:2px;color:${BRAND.colors.stone};font-size:10pt">Lines to quote: ${linesRequested.map((l) => escapeHtml(l)).join(' &middot; ') || '—'}</p>
  ${coverages.map((c) => renderCoverageCard(c, o)).join('')}

  ${sov.length ? `<h2>Statement of Values — Common-Area Property</h2>
  <table class="sov"><tr><th>Description</th><th>Insured value</th><th>Construction</th><th>Year</th><th>Sq ft</th></tr>
  ${sov.map((s) => `<tr><td>${dash(s.description)}</td><td>${dash(s.value)}</td><td>${dash(s.construction)}</td><td>${dash(s.year_built)}</td><td>${dash(s.square_feet)}</td></tr>`).join('')}
  </table>` : ''}

  ${notes.length ? `<h2>Underwriting Notes</h2><ul class="tight">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}

  <h2>Submission Instructions</h2>
  <div class="callout">
  <ol class="subm">
    <li>Quote <b>each</b> coverage line above; itemize limits, deductibles, and premium by line.</li>
    <li>Identify the proposed carrier and A.M. Best rating for each line.</li>
    <li>Note <b>any</b> coverage, exclusion, or condition that differs from the current program.</li>
    <li>Loss runs (currently valued, prior 3–5 years) are available on request — contact us to receive them.</li>
    ${o.submissionDeadline ? `<li>Please submit your proposal no later than <b>${escapeHtml(o.submissionDeadline)}</b>.</li>` : ''}
  </ol>
  <div style="margin-top:9px">Direct questions and proposals to <b>${escapeHtml(o.contactName)}</b> — ${escapeHtml(o.contactEmail)}${o.contactPhone ? ` &middot; ${escapeHtml(o.contactPhone)}` : ''}${o.managerName ? `, with a copy to community manager ${escapeHtml(o.managerName)}` : ''}.</div>
  </div>

  <div class="foot">
    ${escapeHtml(BRAND.service.name)} &nbsp;|&nbsp; ${escapeHtml(BRAND.service.addressInline)} &nbsp;|&nbsp; ${escapeHtml(BRAND.service.phone)}<br>
    This Request for Proposal and its contents are provided in confidence for the sole purpose of preparing an insurance quotation for ${dash(ent.named_insured)}. It summarizes coverage specifications only and is not a policy, a binder, or an offer to insure.${o.rfpDate ? ` Issued ${escapeHtml(o.rfpDate)}.` : ''}
  </div>
  </body></html>`;
}

// ----------------------------------------------------------------------------
// normalizeInsuranceProgram — the VALIDATE/clean stage between extract and render.
// The extractor runs once per source PDF, so a program summary + the individual
// policy PDFs yield DUPLICATE coverage lines (e.g. GL from the summary AND from
// the GL policy). Collapse each line to one record, preferring the richest
// source (the actual policy — it carries premium, dates, policy #, terms), and
// backfill any nulls from the other copies. Also orders lines for a clean RFP
// and curates the notes so nothing internal (incumbent AGENT, portal/marketing
// noise) reaches a competing broker.
// ----------------------------------------------------------------------------
const LINE_ORDER = ['Property', 'General Liability', 'Directors & Officers', 'Umbrella/Excess Liability', 'Crime/Fidelity', 'Hired/Non-Owned Auto'];

// Notes that must NOT go to a competing broker, or are pure noise for an RFP.
const NOTE_DROP = [
  /\bagent\b/i, /wholesaler/i, /broker fee/i, /business resource center|BRC\b/i, /eriskhub/i,
  /privacy policy/i, /claim reporting|1-888|usli\.com/i, /policy issued/i, /territory code/i,
  /renewal (number|certificate)|renewing expiring/i, /proposal dated/i, /subject to audit/i,
  /policy form/i, /combined group/i, /preston rd|dallas, tx/i, /total.*premium/i,
];

// Per-coverage key_terms: keep the material features a broker must MATCH; drop
// the incumbent's rating build-up ("X units at $Y/unit = $Z"), fees, minimums,
// and the exhaustive exclusion paragraphs (a broker gets the actual forms if
// they win — an RFP spec sheet doesn't dump 300-word exclusion lists).
const TERM_DROP = [
  /per unit|per pool|per acre|per sq ft|per playground/i, /=\s*\$/, /minimum premium/i,
  /wholesaler|broker fee|flat \$/i, /^additional insured/i,
];
function curateTerms(terms) {
  return (terms || []).filter((t) => t && t.length <= 180 && !TERM_DROP.some((rx) => rx.test(t))).slice(0, 6);
}

function _score(c) {
  return (c.effective_date ? 4 : 0) + (c.annual_premium ? 2 : 0) + (c.policy_number ? 1 : 0) + (c.limits || []).length * 0.1;
}
function normalizeInsuranceProgram(program) {
  const groups = new Map();
  for (const c of program.coverages || []) {
    if (!c || !c.line) continue;
    const key = String(c.line).trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const merged = [];
  for (const [line, arr] of groups) {
    arr.sort((a, b) => _score(b) - _score(a));
    const best = { ...arr[0], line };
    for (const other of arr.slice(1)) {
      for (const f of ['carrier', 'policy_number', 'effective_date', 'expiration_date', 'annual_premium']) {
        if ((best[f] == null || best[f] === '') && other[f]) best[f] = other[f];
      }
      for (const f of ['limits', 'deductibles', 'key_terms']) {
        if ((!best[f] || !best[f].length) && other[f] && other[f].length) best[f] = other[f];
      }
    }
    best.key_terms = curateTerms(best.key_terms);
    delete best._source;
    merged.push(best);
  }
  merged.sort((a, b) => {
    const ia = LINE_ORDER.indexOf(a.line), ib = LINE_ORDER.indexOf(b.line);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const seen = new Set();
  const notes = (program.notes || []).filter((n) => {
    if (!n) return false;
    if (NOTE_DROP.some((rx) => rx.test(n))) return false;
    const k = n.toLowerCase().slice(0, 40);
    if (seen.has(k)) return false; seen.add(k);
    return true;
  }).slice(0, 12);

  return { entity: program.entity || {}, coverages: merged, statement_of_values: program.statement_of_values || [], notes };
}

module.exports = { renderInsuranceRfpHTML, normalizeInsuranceProgram, getCommunityLogoDataUri, escapeHtml };
