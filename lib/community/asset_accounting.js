// ============================================================================
// lib/community/asset_accounting.js  (2026-09-21)
// ----------------------------------------------------------------------------
// Project/asset accounting layered on the ordinary GL, exposed spatially by the
// operating map. PURE functions (no DB, no network) so the map API and the tests
// share exactly one implementation of every number the board sees.
//
// SOURCE OF TRUTH (no redundant fields):
//   ap_invoice_lines.amount_cents  --project_id-->  vendor_projects.asset_id
//   ap_invoice_lines.invoice_id    --> ap_invoices.invoice_date  (the spend date)
// A physical asset's spend is therefore DERIVED through its projects. We never
// store a second asset_id on the invoice line that could disagree.
//
// PARENT/CHILD ROLLUP (no double counting): every invoice line belongs to exactly
// ONE asset (its project's asset_id). An asset's OWN spend sums its own lines; a
// LOCATION rollup adds each descendant's OWN spend. Because a line lives in one
// asset bucket, a rollup can never count it twice. (Proven in the tests.)
//
// The pipeline this file implements, stopping BEFORE any live model:
//   STRUCTURED EVIDENCE (rows) -> DETERMINISTIC METRICS -> ASSET INTELLIGENCE
//   CONTEXT -> (deterministic) NARRATIVE.  A model can later consume the same
//   context object for richer analysis without changing anything here.
// ============================================================================

const money = (c) => (c == null ? '$0' : '$' + Math.round(Number(c) / 100).toLocaleString('en-US'));

// Map a project stage to the four board-facing project states.
const STAGE_TO_PROJSTATUS = {
  requested: 'planned', bid_requested: 'planned', bid_received: 'planned', on_hold: 'planned',
  board_deciding: 'awaiting_approval',
  approved: 'active', contract_signed: 'active', work_started: 'active',
  work_complete: 'completed', closed: 'completed',
};
const OPEN_STAGES = new Set(['requested', 'bid_requested', 'bid_received', 'board_deciding', 'approved', 'contract_signed', 'work_started', 'on_hold']);
const ACTIVE_STAGES = new Set(['approved', 'contract_signed', 'work_started']);

function pickPrimaryProject(list) {
  if (!list || !list.length) return null;
  const open = list.filter((p) => OPEN_STAGES.has(p.stage));
  if (open.length) return open.slice().sort((a, b) => (ACTIVE_STAGES.has(b.stage) ? 1 : 0) - (ACTIVE_STAGES.has(a.stage) ? 1 : 0))[0];
  return list.slice().sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')))[0];
}

// ---- date windows ----------------------------------------------------------
function ymd(d) { return (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10); }
function windowBounds(asOf) {
  const t = (asOf instanceof Date) ? asOf : new Date(asOf || Date.now());
  const y = t.getUTCFullYear();
  const jan1 = (yr) => yr + '-01-01';
  const dec31 = (yr) => yr + '-12-31';
  const three = new Date(Date.UTC(y - 3, t.getUTCMonth(), t.getUTCDate()));
  return {
    ytd: [jan1(y), ymd(t)],
    prior_year: [jan1(y - 1), dec31(y - 1)],
    three_year: [ymd(three), ymd(t)],
    all_time: ['0000-01-01', '9999-12-31'],
  };
}
function inWindow(dateStr, bounds) { const d = ymd(dateStr); return d >= bounds[0] && d <= bounds[1]; }

// Age bucket for "when did we last invest here?" (relative to asOf).
function ageBucket(lastDateStr, asOf) {
  if (!lastDateStr) return 'none';
  const last = new Date(ymd(lastDateStr) + 'T00:00:00Z').getTime();
  const now = ((asOf instanceof Date) ? asOf : new Date(asOf || Date.now())).getTime();
  const yrs = (now - last) / (365.25 * 86400000);
  if (yrs < 1) return 'lt_1y';
  if (yrs < 2) return '1_2y';
  if (yrs < 4) return '2_4y';
  return '4y_plus';
}

function budgetStatus(approvedCents, actualCents, allCompleted) {
  const A = Number(approvedCents) || 0, X = Number(actualCents) || 0;
  if (!A && !X) return 'none';
  if (!A) return 'none';            // spend without an approved amount: no variance to state
  if (X > A) return 'over';
  const ratio = X / A;
  if (allCompleted) return ratio < 0.95 ? 'under' : 'on_track';
  if (ratio >= 0.9) return 'watch';
  return 'on_track';
}

// ============================================================================
// computeAssetMetrics — the single deterministic pass.
//   assets: [{id, parent_asset_id, name, asset_type, condition}]
//   projects: [{id, asset_id, title, stage, approved_cost_cents, percent_complete, completed_at, vendor_name}]
//   lines: [{id?, project_id, amount_cents, invoice_id, gl_account_id}]
//   invoices: [{id, invoice_date}]
//   asOf: Date | ISO string (defaults to now)
// Returns { byAsset: { [assetId]: metrics }, windows }.
// ============================================================================
function computeAssetMetrics({ assets = [], projects = [], lines = [], invoices = [], asOf } = {}) {
  const now = (asOf instanceof Date) ? asOf : new Date(asOf || Date.now());
  const bounds = windowBounds(now);

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const invoiceDate = new Map(invoices.map((i) => [i.id, ymd(i.invoice_date)]));

  // children index
  const childrenOf = new Map();
  for (const a of assets) if (a.parent_asset_id) {
    if (!childrenOf.has(a.parent_asset_id)) childrenOf.set(a.parent_asset_id, []);
    childrenOf.get(a.parent_asset_id).push(a.id);
  }
  function descendants(id, seen = new Set()) {
    for (const c of (childrenOf.get(id) || [])) if (!seen.has(c)) { seen.add(c); descendants(c, seen); }
    return seen;
  }

  // Attribute every line to exactly one asset (via its project). Keep the date.
  // ownLines[assetId] = [{amount, date, project_id, gl_account_id}]
  const ownLines = new Map();
  for (const ln of lines) {
    const p = projectById.get(ln.project_id);
    if (!p || !p.asset_id) continue;               // unattributed line: not asset spend
    const date = invoiceDate.get(ln.invoice_id) || null;
    if (!ownLines.has(p.asset_id)) ownLines.set(p.asset_id, []);
    ownLines.get(p.asset_id).push({ amount: Number(ln.amount_cents) || 0, date, project_id: ln.project_id, gl_account_id: ln.gl_account_id });
  }

  // projects grouped by asset (own)
  const ownProjects = new Map();
  for (const p of projects) if (p.asset_id) {
    if (!ownProjects.has(p.asset_id)) ownProjects.set(p.asset_id, []);
    ownProjects.get(p.asset_id).push(p);
  }

  const sumWindow = (rows, key) => (rows || []).reduce((s, r) => s + (r.date && inWindow(r.date, bounds[key]) ? r.amount : 0), 0);
  const spendOwn = (aid) => {
    const rows = ownLines.get(aid) || [];
    return { ytd: sumWindow(rows, 'ytd'), prior_year: sumWindow(rows, 'prior_year'), three_year: sumWindow(rows, 'three_year'), all_time: sumWindow(rows, 'all_time') };
  };
  const lastDateOwn = (aid) => (ownLines.get(aid) || []).reduce((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null);

  const byAsset = {};
  for (const a of assets) {
    const set = new Set([a.id, ...descendants(a.id)]);
    // OWN + LOCATION (rolled) spend by window — each line counted once because it
    // lives in exactly one asset's ownLines bucket.
    const own = spendOwn(a.id);
    const location = { ytd: 0, prior_year: 0, three_year: 0, all_time: 0 };
    let locationLast = null; let ownLast = lastDateOwn(a.id);
    for (const id of set) {
      const s = spendOwn(id);
      location.ytd += s.ytd; location.prior_year += s.prior_year; location.three_year += s.three_year; location.all_time += s.all_time;
      const ld = lastDateOwn(id); if (ld && (!locationLast || ld > locationLast)) locationLast = ld;
    }
    // Budget: aggregate approved vs actual across this asset + descendants' projects.
    let approved = 0, actual = 0, projCount = 0, allCompleted = true;
    for (const id of set) for (const p of (ownProjects.get(id) || [])) {
      projCount++;
      approved += Number(p.approved_cost_cents) || 0;
      actual += (ownLines.get(id) || []).filter((r) => r.project_id === p.id).reduce((s, r) => s + r.amount, 0);
      if (!['work_complete', 'closed'].includes(p.stage)) allCompleted = false;
    }
    const status = budgetStatus(approved, actual, projCount > 0 && allCompleted);
    // Project status from the primary project across the location.
    const locProjects = [...set].flatMap((id) => ownProjects.get(id) || []);
    const primary = pickPrimaryProject(locProjects);
    const project_status = primary ? (STAGE_TO_PROJSTATUS[primary.stage] || 'planned') : 'none';

    byAsset[a.id] = {
      condition: a.condition || 'unknown',
      spend: { own, location },
      last_spend: { own_date: ownLast, location_date: locationLast },
      age_bucket: ageBucket(locationLast, now),
      budget: { approved_cents: approved, actual_cents: actual, remaining_cents: approved - actual, status, project_count: projCount },
      project_status,
      has_children: set.size > 1,
      primary_project_id: primary ? primary.id : null,
    };
  }
  return { byAsset, windows: bounds };
}

// ============================================================================
// Asset Intelligence — deterministic, grounded, lens-aware narrative.
// Consumes ONLY the metrics + the same structured detail the panel shows. Never
// invents a fact and never claims causation. 2-4 short sentences per lens.
//   detail: { asset, children, projects:[{title,stage,approved_cents,actual_cents,
//             remaining_cents,percent_complete,vendor_name,completed_at}],
//             board_motions, project_events }
//   metrics: the byAsset[id] object above.
// Returns { context, narratives: {condition,spending,budget,projects,spend_age} }.
// ============================================================================
function assetIntelligence(detail, metrics, asOf) {
  const now = (asOf instanceof Date) ? asOf : new Date(asOf || Date.now());
  const a = detail.asset || {};
  const projects = detail.projects || [];
  const events = detail.project_events || [];
  const motions = detail.board_motions || [];
  const m = metrics || {};
  const loc = (m.spend && m.spend.location) || { three_year: 0, ytd: 0, prior_year: 0, all_time: 0 };
  const primary = projects.find((p) => p.id === m.primary_project_id) || pickPrimaryProject(projects);
  const active = projects.filter((p) => ACTIVE_STAGES.has(p.stage));
  const completed = projects.filter((p) => ['work_complete', 'closed'].includes(p.stage));
  const cond = (a.condition || 'unknown');
  const condLabel = { excellent: 'excellent', good: 'good', fair: 'fair', poor: 'poor', failing: 'failing', unknown: 'not yet rated' }[cond] || cond;

  // structured context (what a model would later receive verbatim)
  const context = {
    asset: { id: a.id, name: a.name, type: a.asset_type, condition: cond, location: a.location_description || null },
    condition: cond,
    spend: m.spend || null,
    last_spend_date: (m.last_spend && m.last_spend.location_date) || null,
    age_bucket: m.age_bucket || 'none',
    budget: m.budget || null,
    project_status: m.project_status || 'none',
    projects: projects.map((p) => ({ title: p.title, stage: p.stage, approved_cents: p.approved_cents, actual_cents: p.actual_cents, remaining_cents: p.remaining_cents, percent_complete: p.percent_complete, vendor_name: p.vendor_name })),
    board_motions: motions.map((x) => ({ title: x.title, status: x.status })),
    events: events.map((e) => ({ date: (e.created_at || '').slice(0, 10), note: e.note || e.event_type })),
  };

  const nm = a.name || 'This asset';
  const S = (arr) => arr.filter(Boolean).join(' ');

  // CONDITION
  const conditionLines = [`${nm} is currently rated ${condLabel}.`];
  if (['poor', 'failing'].includes(cond) && primary && ACTIVE_STAGES.has(primary.stage)) conditionLines.push(`A ${primary.title.toLowerCase()} is underway.`);
  if (['poor', 'failing'].includes(cond) && loc.three_year > 0) conditionLines.push(`It has drawn ${money(loc.three_year)} of work over the last three years and remains ${condLabel}.`);
  else if (cond === 'fair' && (m.age_bucket === '4y_plus' || m.age_bucket === 'none')) conditionLines.push(`There is no recorded investment here in ${m.age_bucket === 'none' ? 'the records available' : 'more than four years'}.`);

  // SPENDING
  const spendingLines = [];
  if (loc.three_year > 0) spendingLines.push(`${nm} has received ${money(loc.three_year)} of recorded investment over the last three years${loc.ytd ? ` (${money(loc.ytd)} year to date)` : ''}.`);
  else spendingLines.push(`${nm} has no recorded investment in the last three years.`);
  // largest child-system share (grounded, from the panel's own projects)
  if (primary && (primary.actual_cents || 0) > 0) spendingLines.push(`The largest single item is ${primary.title.toLowerCase()} (${money(primary.actual_cents)}${primary.vendor_name ? `, ${primary.vendor_name}` : ''}).`);

  // BUDGET
  const budgetLines = [];
  const bp = projects.find((p) => (p.approved_cents || 0) > 0 && OPEN_STAGES.has(p.stage)) || projects.find((p) => (p.approved_cents || 0) > 0);
  if (bp) {
    budgetLines.push(`${bp.title} was approved at ${money(bp.approved_cents)}. ${money(bp.actual_cents)} has been invoiced to date, leaving ${money(bp.remaining_cents)}${bp.percent_complete != null ? `; work is ${bp.percent_complete}% complete` : ''}.`);
    if ((bp.actual_cents || 0) > (bp.approved_cents || 0)) budgetLines.push(`Actual has exceeded the approved amount.`);
  } else {
    budgetLines.push(`${nm} has no project with a board-approved amount on record.`);
  }

  // PROJECTS
  const projectLines = [];
  if (active.length) projectLines.push(`${nm} has ${active.length} active ${active.length === 1 ? 'project' : 'projects'}. ${primary ? `${primary.title} — ${primary.vendor_name || 'vendor TBD'}${primary.percent_complete != null ? `, ${primary.percent_complete}% complete` : ''}.` : ''}`);
  else if (projects.some((p) => p.stage === 'board_deciding')) projectLines.push(`${nm} has a project awaiting the board's decision.`);
  else if (completed.length) projectLines.push(`${nm} has no active work; its most recent project (${completed[0].title}) is complete.`);
  else projectLines.push(`${nm} has no projects on record.`);
  if (motions.length) projectLines.push(`Board record: "${motions[0].title}" (${motions[0].status}).`);

  // SPEND AGE
  const ageLines = [];
  const lastDate = (m.last_spend && m.last_spend.location_date) || null;
  if (lastDate) {
    const days = Math.round((now.getTime() - new Date(lastDate + 'T00:00:00Z').getTime()) / 86400000);
    const ageTxt = days < 60 ? `${days} days ago` : days < 730 ? `about ${Math.round(days / 30)} months ago` : `about ${(days / 365).toFixed(1)} years ago`;
    ageLines.push(`The most recent recorded expenditure here was ${ageTxt} (${lastDate}).`);
    if (primary && primary.title) ageLines.push(`It was for ${primary.title.toLowerCase()}.`);
  } else {
    ageLines.push(`There is no recorded expenditure attributed to ${nm}.`);
  }

  return {
    context,
    narratives: {
      condition: S(conditionLines),
      spending: S(spendingLines),
      budget: S(budgetLines),
      projects: S(projectLines),
      spend_age: S(ageLines),
    },
  };
}

module.exports = {
  computeAssetMetrics, assetIntelligence, pickPrimaryProject,
  windowBounds, inWindow, ageBucket, budgetStatus, STAGE_TO_PROJSTATUS, money,
};
