// ============================================================================
// tests/test_lma_asset_accounting.js
// ----------------------------------------------------------------------------
// Locks the deterministic project/asset accounting the CLMA operating map shows:
// date-window spend, parent/child rollup WITHOUT double counting, approved-vs-
// actual budget status, last-spend age, project status, and drill-down
// reconciliation. Pure fixtures (no DB) so the math is pinned independently of
// the seed. Run: node tests/test_lma_asset_accounting.js
// ============================================================================
const A = require('../lib/community/asset_accounting');
let fails = 0; const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };
const eq = (a, b, m) => ok(a === b, `${m}  (got ${a}, want ${b})`);

const asOf = new Date('2026-09-21T00:00:00Z');

// --- fixtures: a median (parent) + its irrigation child, two monuments, lighting
const assets = [
  { id: 'med7', parent_asset_id: null, name: 'Median 7', asset_type: 'median', condition: 'poor' },
  { id: 'm7irr', parent_asset_id: 'med7', name: 'Median 7 Irrigation', asset_type: 'irrigation_zone', condition: 'poor' },
  { id: 'monW', parent_asset_id: null, name: 'West Monument', asset_type: 'monument', condition: 'good' },
  { id: 'monE', parent_asset_id: null, name: 'East Monument', asset_type: 'monument', condition: 'fair' },
  { id: 'light', parent_asset_id: null, name: 'Parkway Lighting', asset_type: 'lighting_run', condition: 'good' },
];
const projects = [
  { id: 'P1', asset_id: 'm7irr', title: 'Controller Replacement', stage: 'work_started', approved_cost_cents: 1250000, percent_complete: 65, completed_at: null },
  { id: 'P2', asset_id: 'm7irr', title: 'Line Repair 2025', stage: 'closed', approved_cost_cents: 340000, percent_complete: 100, completed_at: '2025-05-10' },
  { id: 'P3', asset_id: 'monW', title: 'Monument Refurb', stage: 'work_complete', approved_cost_cents: 680000, percent_complete: 100, completed_at: '2026-02-20' },
  { id: 'P7', asset_id: 'light', title: 'LED Conversion', stage: 'closed', approved_cost_cents: 2200000, percent_complete: 100, completed_at: '2023-06-15' },
];
const invoices = [
  { id: 'i1', invoice_date: '2026-08-01' }, // ytd + 3yr
  { id: 'i2', invoice_date: '2025-05-01' }, // prior_year + 3yr
  { id: 'i3', invoice_date: '2026-03-01' }, // ytd + 3yr
  { id: 'i5', invoice_date: '2023-06-01' }, // BEFORE 3yr cutoff (2023-09-21) -> all_time only
];
const lines = [
  { id: 'l1', project_id: 'P1', invoice_id: 'i1', amount_cents: 820000, gl_account_id: 'gl6110' },
  { id: 'l2', project_id: 'P2', invoice_id: 'i2', amount_cents: 340000, gl_account_id: 'gl6110' },
  { id: 'l3', project_id: 'P3', invoice_id: 'i3', amount_cents: 680000, gl_account_id: 'gl6130' },
  { id: 'l5', project_id: 'P7', invoice_id: 'i5', amount_cents: 2200000, gl_account_id: 'gl6120' },
];

const { byAsset } = A.computeAssetMetrics({ assets, projects, lines, invoices, asOf });
const m7 = byAsset.med7, irr = byAsset.m7irr, mw = byAsset.monW, me = byAsset.monE, li = byAsset.light;

// 1) date-window aggregation (child m7irr: 820k this yr + 340k prior yr)
eq(irr.spend.own.ytd, 820000, '1a. m7irr YTD own spend');
eq(irr.spend.own.prior_year, 340000, '1b. m7irr prior-year own spend');
eq(irr.spend.own.three_year, 1160000, '1c. m7irr 3yr own spend');
eq(irr.spend.own.all_time, 1160000, '1d. m7irr all-time own spend');

// 2) parent/child rollup WITHOUT double counting: Median 7 (own $0) == child rollup
eq(m7.spend.location.three_year, 1160000, '2a. Median 7 LOCATION 3yr = child rollup (no double count)');
eq(m7.spend.own.three_year, 0, '2b. Median 7 OWN spend is 0 (parent has no lines of its own)');
eq(m7.spend.location.ytd, 820000, '2c. Median 7 LOCATION ytd = child ytd');

// 3) window boundary: lighting $22k dated 2023-06 is OUTSIDE the 3yr window
eq(li.spend.location.three_year, 0, '3a. Lighting 3yr excludes the pre-cutoff invoice');
eq(li.spend.location.all_time, 2200000, '3b. Lighting all-time includes it');
eq(li.age_bucket, '2_4y', '3c. Lighting last-spend age bucket = 2-4 years');

// 4) approved vs actual + status
eq(irr.budget.approved_cents, 1590000, '4a. m7irr approved = P1+P2');
eq(irr.budget.actual_cents, 1160000, '4b. m7irr actual = invoiced lines');
eq(irr.budget.status, 'on_track', '4c. m7irr budget status on_track (<90% of approved, active)');
eq(mw.budget.status, 'on_track', '4d. monW completed at 100% of approved = on_track');
eq(me.budget.status, 'none', '4e. monE has no approved project = none');

// 5) last-spend / age
eq(m7.last_spend.location_date, '2026-08-01', '5a. Median 7 last spend = most recent child invoice');
eq(m7.age_bucket, 'lt_1y', '5b. Median 7 age bucket < 1 year');
eq(me.last_spend.location_date, null, '5c. monE has no recorded spend');
eq(me.age_bucket, 'none', '5d. monE age bucket none');

// 6) project status classification
eq(m7.project_status, 'active', '6a. Median 7 primary project active (work_started)');
eq(mw.project_status, 'completed', '6b. monW project completed');
eq(me.project_status, 'none', '6c. monE no projects');

// 7) drill-down reconciliation: an asset's window spend == sum of ITS attributed
//    invoice lines in that window (the number the panel drills into).
function reconcile(assetId, key) {
  const bounds = A.windowBounds(asOf)[key];
  let sum = 0;
  for (const ln of lines) {
    const p = projects.find((x) => x.id === ln.project_id);
    if (!p || p.asset_id !== assetId) continue;
    const inv = invoices.find((i) => i.id === ln.invoice_id);
    if (inv && A.inWindow(inv.invoice_date, bounds)) sum += ln.amount_cents;
  }
  return sum;
}
eq(irr.spend.own.three_year, reconcile('m7irr', 'three_year'), '7a. m7irr 3yr reconciles to its invoice lines');
eq(irr.spend.own.ytd, reconcile('m7irr', 'ytd'), '7b. m7irr ytd reconciles');
// location reconciliation: parent == sum of each descendant's reconciled lines
eq(m7.spend.location.all_time, reconcile('m7irr', 'all_time') + reconcile('med7', 'all_time'), '7c. Median 7 location all-time = sum of descendants (each line once)');

// 8) deterministic narrative is grounded (mentions the real numbers, no NaN/undefined)
const detail = {
  asset: assets[0],
  projects: [
    { id: 'P1', title: 'Controller Replacement', stage: 'work_started', approved_cents: 1250000, actual_cents: 820000, remaining_cents: 430000, percent_complete: 65, vendor_name: 'AquaFlow' },
    { id: 'P2', title: 'Line Repair 2025', stage: 'closed', approved_cents: 340000, actual_cents: 340000, remaining_cents: 0, percent_complete: 100, vendor_name: 'AquaFlow' },
  ],
  board_motions: [{ title: 'Approve controller replacement ($12,500)', status: 'passed' }],
  project_events: [{ created_at: '2026-08-01', note: 'AquaFlow began replacement' }],
};
const intel = A.assetIntelligence(detail, byAsset.med7, asOf);
ok(/\$12,500/.test(intel.narratives.budget), '8a. budget narrative cites the approved $12,500');
ok(/\$8,200/.test(intel.narratives.budget), '8b. budget narrative cites the $8,200 invoiced');
ok(/three years/.test(intel.narratives.spending) && !/undefined|NaN/.test(JSON.stringify(intel.narratives)), '8c. spending narrative grounded, no undefined/NaN');
ok(intel.context && intel.context.budget && intel.context.spend, '8d. intelligence returns a structured context (for later model use)');

console.log(fails ? `\n✗ lma-asset-accounting: ${fails} failure(s)` : '\n✓ lma-asset-accounting: metrics, rollup, budget, age, reconciliation all hold');
process.exit(fails ? 1 : 0);
