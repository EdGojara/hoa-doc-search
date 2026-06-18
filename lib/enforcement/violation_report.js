// ============================================================================
// lib/enforcement/violation_report.js
// ----------------------------------------------------------------------------
// Point-in-time violations report. Standard month-end deliverable for boards:
// every violation active at end of the chosen date, grouped by street and
// sorted by house number, with the stage they were in AS OF that date (not
// today). The stage-as-of-date math reads from violation_letters (each letter
// records stage_at_send) — the latest letter sent on or before the report
// date is the stage they were in at month-end. If no letter has gone out yet,
// the violation is still in its opening stage (courtesy_1).
//
// Single helper so the API endpoint and any future scheduled-email job share
// the same math and the same rendered HTML — never two diverging surfaces
// against the same data (CLAUDE.md: parallel retrieval silos).
//
// Why a printable HTML page (not a PDF generator): boards skim. The print
// CSS gives a clean letter-size layout when they "Print to PDF" or hit Cmd-P.
// Faster, no Chromium dep, and the operator can paste the table into board-
// packet notes without parsing a PDF.
// ============================================================================

// Direct assignment is the canonical brand-import pattern (board_packets.js,
// invoice_template.js, builder_letter.js, decision_letter.js, etc.). The
// destructured form { BRAND } returns undefined because lib/brand.js exports
// the frozen BRAND object as module.exports directly, not a wrapper.
const BRAND = require('../brand');

const STAGE_LABELS = {
  courtesy_1:    'Courtesy 1',
  courtesy_2:    'Courtesy 2',
  certified_209: 'Certified §209',
  fine_assessed: 'Fine assessed',
  hearing_notice:'Hearing notice',
  legal_referral:'Legal referral',
  lien_filed:    'Lien filed',
  other:         'Other',
  cured:         'Cured',
  closed:        'Closed',
  voided:        'Voided',
};
const STAGE_ORDER = [
  'courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed',
  'hearing_notice', 'legal_referral', 'lien_filed', 'other',
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseStreetSortKey(streetAddress) {
  // Sort by street name first, then numeric house number. "1422 Oak" sorts
  // BEFORE "201 Pine" because Oak < Pine alphabetically -- that's what
  // operators expect on a walk-the-street report.
  if (!streetAddress) return { street: 'zzz', number: 999999, raw: '' };
  const trimmed = String(streetAddress).trim();
  const m = trimmed.match(/^(\d+)\s+(.+)$/);
  if (m) {
    return { street: m[2].toUpperCase(), number: parseInt(m[1], 10), raw: trimmed };
  }
  return { street: trimmed.toUpperCase(), number: 999999, raw: trimmed };
}

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  const ms = new Date(later).getTime() - new Date(earlier).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Build the dataset for the report. Returns rows + totals; HTML is rendered
// by renderReportHtml() so callers that just want JSON skip the string build.
async function buildReportData({ supabase, communityId, asOfDate }) {
  if (!communityId) throw new Error('communityId required');
  if (!asOfDate) throw new Error('asOfDate required (YYYY-MM-DD)');

  // Normalize the asOf -- end of day in Central. Violations resolved on the
  // same day as the report should still appear (the report covers that day).
  const asOfEndOfDay = new Date(`${asOfDate}T23:59:59.999-06:00`).toISOString();
  const asOfStartOfDay = new Date(`${asOfDate}T00:00:00-06:00`).toISOString();

  const { data: community, error: cErr } = await supabase
    .from('communities')
    .select('id, name, slug')
    .eq('id', communityId)
    .maybeSingle();
  if (cErr) {
    // Surface the real cause -- the previous catch-all "community_not_found"
    // hid a column-missing error and made debugging slower than it should be.
    throw new Error('community lookup failed: ' + cErr.message);
  }
  if (!community) {
    throw new Error('community_not_found (no row in communities for id ' + communityId + ')');
  }

  // Pull active-at-date violations: opened on/before asOf, not yet resolved
  // (or resolved AFTER asOf). Paginated to dodge the 1000-row PostgREST cap.
  const violations = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('violations')
      .select(`
        id, property_id, current_stage, current_stage_started_at,
        opened_at, resolved_at, resolved_via, primary_category_id,
        property:properties(id, street_address, unit),
        category:enforcement_categories(id, slug, label)
      `)
      .eq('community_id', communityId)
      .lte('opened_at', asOfEndOfDay)
      .or(`resolved_at.is.null,resolved_at.gt.${asOfEndOfDay}`)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.warn('[violation_report] page failed at offset', offset, ':', error.message);
      break;
    }
    const page = data || [];
    violations.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
    if (violations.length > 50000) break; // safety cap
  }

  if (!violations.length) {
    return { community, asOfDate, rows: [], totals: emptyTotals(), generatedAt: new Date().toISOString() };
  }

  // Pull all letters for those violations sent on/before asOf -- determines
  // historical stage. Same paginated pattern.
  const vIds = violations.map((v) => v.id);
  const letters = [];
  for (let i = 0; i < vIds.length; i += 500) {
    const chunk = vIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('violation_letters')
      .select('id, violation_id, stage_at_send, sent_at')
      .in('violation_id', chunk)
      .lte('sent_at', asOfDate)
      .order('sent_at', { ascending: true });
    if (error) {
      console.warn('[violation_report] letter chunk failed at offset', i, ':', error.message);
      continue;
    }
    letters.push(...(data || []));
  }

  // For each violation, find the LATEST letter on/before asOf. If none, the
  // violation is still in its opening (courtesy_1) state.
  const latestLetterByV = new Map();
  for (const L of letters) {
    const prev = latestLetterByV.get(L.violation_id);
    if (!prev || new Date(L.sent_at) > new Date(prev.sent_at)) {
      latestLetterByV.set(L.violation_id, L);
    }
  }

  // Build the row shape used by both the HTML renderer and the JSON response.
  const rows = violations.map((v) => {
    const letter = latestLetterByV.get(v.id);
    // Historical stage as of the report date:
    //   1. A trustEd letter sent on/before asOf is the most precise signal.
    //   2. No such letter is the COMMON case for Vantaca-imported history —
    //      those letters were sent in Vantaca, not trustEd — so fall back to
    //      the violation's OWN current stage, as long as it entered that stage
    //      on/before the report date.
    //   3. Only when neither signal places a stage on/before asOf do we assume
    //      the opening courtesy_1.
    // Bug (Ed 2026-06-18): the old code defaulted EVERY letter-less violation
    // to courtesy_1, which flattened all imported certified / 2nd-notice cases
    // into first notices on the month-end report even though the DB held the
    // right stage.
    let stageAsOf, stageEnteredAt;
    if (letter) {
      stageAsOf = letter.stage_at_send;
      stageEnteredAt = letter.sent_at;
    } else if (v.current_stage && v.current_stage_started_at &&
               String(v.current_stage_started_at).slice(0, 10) <= asOfDate) {
      stageAsOf = v.current_stage;
      stageEnteredAt = v.current_stage_started_at;
    } else {
      stageAsOf = 'courtesy_1';
      stageEnteredAt = v.opened_at;
    }
    const daysInStage = daysBetween(asOfDate, stageEnteredAt);
    const daysOpen = daysBetween(asOfDate, v.opened_at);
    const sortKey = parseStreetSortKey(v.property && v.property.street_address);
    return {
      violation_id: v.id,
      property_id: v.property_id,
      street_address: (v.property && v.property.street_address) || '(no address)',
      unit: (v.property && v.property.unit) || null,
      category_label: (v.category && v.category.label) || '(uncategorized)',
      category_slug: (v.category && v.category.slug) || null,
      stage_as_of: stageAsOf,
      stage_label: STAGE_LABELS[stageAsOf] || stageAsOf,
      stage_started_at: stageEnteredAt,
      days_in_stage: daysInStage,
      opened_at: v.opened_at,
      days_open: daysOpen,
      sort_street: sortKey.street,
      sort_number: sortKey.number,
    };
  });

  // Sort: street name (A-Z), then house number (ascending). Operators read
  // these like driving the route.
  rows.sort((a, b) => {
    if (a.sort_street < b.sort_street) return -1;
    if (a.sort_street > b.sort_street) return 1;
    if (a.sort_number !== b.sort_number) return a.sort_number - b.sort_number;
    return 0;
  });

  // Totals -- the at-a-glance dashboard that should match the table count.
  // CLAUDE.md cross-check rule: every total displayed agrees with the row
  // array that produced it. Same array, same length, no upstream divergence.
  const totals = emptyTotals();
  totals.total_open = rows.length;
  for (const r of rows) {
    totals.by_stage[r.stage_as_of] = (totals.by_stage[r.stage_as_of] || 0) + 1;
  }

  return { community, asOfDate, rows, totals, generatedAt: new Date().toISOString() };
}

function emptyTotals() {
  return {
    total_open: 0,
    by_stage: Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])),
  };
}

function fmtDateUS(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

function fmtDateLong(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

function stageBadge(slug, label) {
  const tone = {
    courtesy_1:    '#1F3A5F', courtesy_2:    '#315A87',
    certified_209: '#92400e', fine_assessed: '#b91c1c',
    hearing_notice:'#7f1d1d', legal_referral:'#581c87',
    lien_filed:    '#27272a', other:         '#475569',
  }[slug] || '#475569';
  return `<span class="vr-stage" style="background:${tone};">${esc(label)}</span>`;
}

function renderReportHtml({ community, asOfDate, rows, totals, generatedAt }) {
  // Group rows by street name for visual scanning. Operators reading a paper
  // copy expect "all the Oak Street ones together."
  const byStreet = new Map();
  for (const r of rows) {
    (byStreet.get(r.sort_street) || byStreet.set(r.sort_street, []).get(r.sort_street)).push(r);
  }

  const totalsByStageHtml = STAGE_ORDER
    .filter((s) => totals.by_stage[s] > 0)
    .map((s) => `
      <div class="vr-stat">
        <div class="vr-stat-n">${totals.by_stage[s]}</div>
        <div class="vr-stat-l">${esc(STAGE_LABELS[s])}</div>
      </div>`)
    .join('');

  const streetSections = Array.from(byStreet.entries()).map(([street, list]) => `
    <section class="vr-street">
      <h3 class="vr-street-name">${esc(street)} <span class="vr-street-count">(${list.length})</span></h3>
      <table class="vr-tbl">
        <thead>
          <tr>
            <th class="vr-col-addr">Address</th>
            <th class="vr-col-cat">Violation</th>
            <th class="vr-col-stage">Stage as of ${esc(fmtDateUS(asOfDate))}</th>
            <th class="vr-col-days">Days in stage</th>
            <th class="vr-col-opened">Opened</th>
            <th class="vr-col-days">Days open</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((r) => `
            <tr>
              <td class="vr-col-addr"><strong>${esc(r.street_address)}</strong>${r.unit ? ` <span class="vr-unit">${esc(r.unit)}</span>` : ''}</td>
              <td>${esc(r.category_label)}</td>
              <td>${stageBadge(r.stage_as_of, r.stage_label)}</td>
              <td class="vr-num">${r.days_in_stage == null ? '—' : r.days_in_stage}</td>
              <td>${esc(fmtDateUS(r.opened_at))}</td>
              <td class="vr-num">${r.days_open == null ? '—' : r.days_open}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(community.name)} — Violations as of ${esc(fmtDateUS(asOfDate))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --navy: #1F3A5F;
    --navy-deep: #0B1D34;
    --gold: #D4AF37;
    --ink: #1a1a1a;
    --ink-faint: #475569;
    --rule: #d4d4d8;
    --tint: #EAF0F7;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    color: var(--ink);
    margin: 0;
    background: #f4f4f5;
    font-size: 13px;
    line-height: 1.5;
  }
  .vr-page {
    max-width: 8.5in;
    margin: 24px auto;
    background: white;
    padding: 0.65in 0.55in;
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  .vr-head {
    border-bottom: 2px solid var(--navy);
    padding-bottom: 16px;
    margin-bottom: 22px;
  }
  .vr-brand-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 6px;
  }
  .vr-brand {
    font-family: 'Playfair Display', serif;
    font-weight: 600;
    font-size: 22px;
    color: var(--navy-deep);
    letter-spacing: 0.5px;
  }
  .vr-brand-tag {
    font-size: 10.5px;
    color: var(--ink-faint);
    text-transform: uppercase;
    letter-spacing: 1.2px;
  }
  .vr-title {
    font-family: 'Playfair Display', serif;
    font-size: 26px;
    color: var(--navy-deep);
    margin: 0 0 4px 0;
    font-weight: 600;
  }
  .vr-sub {
    color: var(--ink-faint);
    font-size: 13px;
  }
  .vr-meta {
    color: var(--ink-faint);
    font-size: 11px;
    margin-top: 8px;
  }
  .vr-summary {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin: 0 0 26px 0;
    padding: 14px;
    background: var(--tint);
    border-radius: 6px;
  }
  .vr-stat-headline {
    border-right: 2px solid var(--navy);
    padding-right: 18px;
  }
  .vr-stat-headline .vr-stat-n { font-size: 32px; color: var(--navy-deep); }
  .vr-stat-headline .vr-stat-l { font-size: 12px; }
  .vr-stat {
    text-align: center;
    min-width: 70px;
  }
  .vr-stat-n { font-size: 18px; font-weight: 700; color: var(--navy-deep); }
  .vr-stat-l { font-size: 10.5px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.7px; margin-top: 2px; }
  .vr-street {
    margin: 0 0 18px 0;
    page-break-inside: avoid;
  }
  .vr-street-name {
    font-family: 'Playfair Display', serif;
    font-size: 16px;
    font-weight: 600;
    color: var(--navy-deep);
    margin: 12px 0 6px 0;
    text-transform: capitalize;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 4px;
  }
  .vr-street-count {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    color: var(--ink-faint);
    font-weight: 400;
  }
  .vr-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .vr-tbl th {
    text-align: left;
    color: var(--ink-faint);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-size: 10px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--rule);
  }
  .vr-tbl td {
    padding: 7px 8px;
    border-bottom: 1px solid #f1f5f9;
    vertical-align: top;
  }
  .vr-tbl tr:last-child td { border-bottom: none; }
  .vr-col-days, .vr-num { text-align: right; font-variant-numeric: tabular-nums; }
  .vr-col-stage { white-space: nowrap; }
  .vr-unit { color: var(--ink-faint); font-weight: 400; font-size: 11px; }
  .vr-stage {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    color: white;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }
  .vr-empty {
    text-align: center;
    padding: 60px 20px;
    color: var(--ink-faint);
  }
  .vr-foot {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
    font-size: 10.5px;
    color: var(--ink-faint);
    display: flex;
    justify-content: space-between;
  }
  .vr-foot-brand { color: var(--navy-deep); font-weight: 600; }
  .vr-print {
    text-align: center;
    padding: 10px;
    background: #fef3c7;
    border-bottom: 1px solid #fcd34d;
    font-size: 12px;
  }
  .vr-print button {
    margin-left: 10px;
    padding: 4px 12px;
    background: var(--navy-deep);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
  }
  @media print {
    body { background: white; }
    .vr-print { display: none; }
    .vr-page { box-shadow: none; margin: 0; padding: 0.5in 0.5in; max-width: none; }
    .vr-street { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="vr-print">
  Tip: hit <strong>Cmd-P</strong> (or Ctrl-P) and "Save as PDF" for the board packet.
  <button onclick="window.print()">Print this report</button>
</div>
<div class="vr-page">
  <header class="vr-head">
    <div class="vr-brand-row">
      <div class="vr-brand">${esc(BRAND.service.name)}</div>
      <div class="vr-brand-tag">${esc(BRAND.service.taglineUpper)}</div>
    </div>
    <h1 class="vr-title">${esc(community.name)} — Open Violations</h1>
    <div class="vr-sub">Status as of <strong>${esc(fmtDateLong(asOfDate))}</strong></div>
    <div class="vr-meta">Generated ${esc(fmtDateUS(generatedAt))} · ${esc(BRAND.service.legal)} on behalf of the ${esc(community.name)} Board of Directors</div>
  </header>

  ${rows.length === 0 ? `
    <div class="vr-empty">
      <h2 style="font-family:'Playfair Display',serif; color:var(--navy-deep); margin:0 0 8px 0;">No open violations as of this date</h2>
      <p>No violation was open in this community on ${esc(fmtDateLong(asOfDate))}.</p>
    </div>
  ` : `
    <section class="vr-summary">
      <div class="vr-stat vr-stat-headline">
        <div class="vr-stat-n">${totals.total_open}</div>
        <div class="vr-stat-l">Open violations</div>
      </div>
      ${totalsByStageHtml}
    </section>

    ${streetSections}
  `}

  <footer class="vr-foot">
    <span class="vr-foot-brand">${esc(BRAND.service.name)}</span>
    <span>${esc(community.name)} · ${esc(rows.length)} ${rows.length === 1 ? 'entry' : 'entries'} · as of ${esc(fmtDateUS(asOfDate))}</span>
  </footer>
</div>
</body>
</html>`;
}

async function buildReport({ supabase, communityId, asOfDate }) {
  const data = await buildReportData({ supabase, communityId, asOfDate });
  const html = renderReportHtml(data);
  return { ...data, html };
}

module.exports = {
  buildReport,
  buildReportData,
  renderReportHtml,
  STAGE_LABELS,
  STAGE_ORDER,
};
