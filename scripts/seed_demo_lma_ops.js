#!/usr/bin/env node
/**
 * seed_demo_lma_ops.js — Demo LMA operations layer (Sterling Ridge): vendors,
 * GL fund + accounts, 8 asset-linked projects, project events, a board motion,
 * and project-attributed AP invoices. Requires migrations 443 (vendor_projects
 * .asset_id), 444 (ap_invoice_lines.project_id), 446 (assets geojson RPC) and
 * the geography seed (seed_demo_lma.js). Idempotent (stable UUIDs).
 *
 *   node scripts/seed_demo_lma_ops.js --dry-run
 *   node scripts/seed_demo_lma_ops.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { DEMO_MGMT_CO_ID } = require('../lib/company');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EXECUTE = process.argv.includes('--execute');
const LMA = 'e0100000-0000-4000-a000-000000000000';
const asset = (n) => `e011${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`; // geography seed order
const V = (n) => `e019${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`;
const P = (n) => `e017${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`;
const AC = (n) => `e01b${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`;
const INV = (n) => `e01a${String(n).padStart(4, '0')}-0000-4000-a000-000000000000`;
const FUND = 'e01f0001-0000-4000-a000-000000000000';
const MOTION = 'e01c0001-0000-4000-a000-000000000000';
const day = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

const VENDORS = [
  [V(1), 'GreenScape Partners', 'landscaping', 'ops@greenscape.example', '(281) 555-0201'],
  [V(2), 'AquaFlow Irrigation', 'irrigation', 'service@aquaflow.example', '(281) 555-0202'],
  [V(3), 'Lumina Electric', 'electrical', 'dispatch@lumina.example', '(281) 555-0203'],
  [V(4), 'StoneWorks Masonry', 'general', 'office@stoneworks.example', '(281) 555-0204'],
  [V(5), 'TerraFirma Civil', 'concrete', 'projects@terrafirma.example', '(281) 555-0205'],
];
// [id, number, name, account_type]
const ACCOUNTS = [
  [AC(1), '6100', 'Landscape Maintenance', 'expense'],
  [AC(2), '6110', 'Irrigation Repairs', 'expense'],
  [AC(3), '6120', 'Lighting & Electrical', 'expense'],
  [AC(4), '6130', 'Monument & Signage', 'expense'],
  [AC(5), '6140', 'Drainage & Detention', 'expense'],
];
// [id, title, category, assetIdx, vendorNo, stage, approved_cents, est_cents, percent, started(dOffset|null), completed(dOffset|null), target(dOffset|null), funding, priority]
const PROJECTS = [
  [P(1), 'Median 7 Irrigation Controller Replacement', 'irrigation', 8, 2, 'work_started', 1250000, 1250000, 65, -45, null, 15, 'operating', 'high'],
  [P(2), 'Median 7 Irrigation Line Repair (2025)', 'irrigation', 8, 2, 'closed', 340000, 340000, 100, -400, -380, null, 'operating', 'normal'],
  [P(3), 'West Entrance Monument Refurbishment', 'signage', 4, 4, 'work_complete', 680000, 680000, 100, -110, -90, null, 'reserve', 'normal'],
  [P(4), 'Median 3 Landscape Renovation', 'landscaping', 1, 1, 'work_started', 920000, 920000, 40, -20, null, 25, 'operating', 'normal'],
  [P(5), 'East Entrance Seasonal Color Program', 'landscaping', 7, 1, 'board_deciding', 0, 450000, 0, null, null, 40, 'operating', 'low'],
  [P(6), 'Detention Basin Erosion Repair', 'concrete', 16, 5, 'board_deciding', 0, 1800000, 0, null, null, null, 'reserve', 'high'],
  [P(7), 'Parkway Lighting LED Conversion', 'electrical', 14, 3, 'closed', 2200000, 2200000, 100, -920, -900, null, 'reserve', 'normal'],
  [P(8), 'Median 5 Irrigation Efficiency Audit', 'irrigation', 12, 2, 'approved', 180000, 180000, 0, null, null, 60, 'operating', 'normal'],
];
// [invId, number, vendorNo, status, paid_cents, invoiceDateOffset(days), [ [desc, amount_cents, accountNo, projectId|null], ... ] ]
// Dates are deliberately spread so the map's spend windows (YTD / prior year /
// 3yr) and spend-age lens are meaningful, while every dollar still reconciles to
// its project -> asset. Coherent stories: Median 7 = recurring irrigation (recent
// + prior-year); West Monument = completed UNDER budget; Median 3 = active project
// approaching its approved amount; Parkway Lighting = high 3-year spend but nothing
// recent (~2.5 years ago).
const INVOICES = [
  [INV(1), 'AQ-4471', 2, 'approved', 0,       -45,  [['Median 7 irrigation controller + install (progress billing)', 820000, 2, P(1)]]],
  [INV(2), 'AQ-3980', 2, 'paid',     340000,  -400, [['Median 7 mainline break repair (prior year)', 340000, 2, P(2)]]],
  [INV(3), 'SW-1123', 4, 'paid',     620000,  -90,  [['West entrance monument refurbishment (final, came in under budget)', 620000, 4, P(3)]]],
  [INV(4), 'GS-8890', 1, 'approved', 0,       -30,  [['Median 3 renovation - progress', 368000, 1, P(4)], ['West entrance bed routine maintenance', 132000, 1, null]]],
  [INV(6), 'GS-9100', 1, 'approved', 0,       -12,  [['Median 3 renovation - progress 2', 460000, 1, P(4)]]],
  [INV(5), 'LM-2205', 3, 'paid',     2200000, -900, [['Parkway lighting LED conversion (full)', 2200000, 3, P(7)]]],
];

async function guard() {
  const a = await sb.from('vendor_projects').select('asset_id').limit(1);
  const b = await sb.from('ap_invoice_lines').select('project_id').limit(1);
  if (a.error || b.error) {
    console.error('BLOCKED: apply migrations 443 (vendor_projects.asset_id) + 444 (ap_invoice_lines.project_id) first.');
    console.error('  vendor_projects.asset_id:', a.error ? a.error.message : 'ok', '| ap_invoice_lines.project_id:', b.error ? b.error.message : 'ok');
    process.exit(1);
  }
}

async function main() {
  console.log(`\nDemo LMA operations seed — Sterling Ridge — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  await guard();
  console.log(`vendors ${VENDORS.length} · accounts ${ACCOUNTS.length} · projects ${PROJECTS.length} · invoices ${INVOICES.length}\n`);
  PROJECTS.forEach((p) => console.log(`  ${p[1].padEnd(46)} ${p[5].padEnd(14)} appr $${(p[6] / 100).toLocaleString()} ${p[8]}% -> asset ${asset(p[3]).slice(0, 8)}`));
  if (!EXECUTE) { console.log('\nDRY RUN — no writes.'); return; }

  // vendors
  for (const [id, name, cat, email, phone] of VENDORS) {
    const { error } = await sb.from('vendors').upsert({ id, management_company_id: DEMO_MGMT_CO_ID, name, category: cat, service_categories: [cat], contact_email: email, contact_phone: phone, status: 'active', is_active: true }, { onConflict: 'id' });
    if (error) throw new Error('vendor ' + name + ': ' + error.message);
  }
  // fund + accounts
  const { error: fErr } = await sb.from('account_funds').upsert({ id: FUND, community_id: LMA, fund_code: 'OPR', fund_name: 'Operating Fund', fund_type: 'operating', display_order: 1, is_active: true }, { onConflict: 'id' });
  if (fErr) throw new Error('fund: ' + fErr.message);
  for (const [id, number, name, type] of ACCOUNTS) {
    const { error } = await sb.from('chart_of_accounts').upsert({ id, community_id: LMA, fund_id: FUND, account_number: number, account_name: name, account_type: type, normal_balance: 'debit', is_active: true }, { onConflict: 'id' });
    if (error) throw new Error('account ' + number + ': ' + error.message);
  }
  // projects
  for (const [id, title, category, assetIdx, vNo, stage, approved, est, pct, st, comp, tgt, funding, priority] of PROJECTS) {
    const row = {
      id, management_company_id: DEMO_MGMT_CO_ID, community_id: LMA, title, category,
      asset_id: asset(assetIdx), asset: title, vendor_id: V(vNo), vendor_name: VENDORS[vNo - 1][1],
      stage, estimated_cost_cents: est, approved_cost_cents: approved, percent_complete: pct,
      funding_source: funding, priority,
      started_at: st != null ? day(st) : null, completed_at: comp != null ? day(comp) : null,
      target_date: tgt != null ? day(tgt) : null, source: 'manual',
    };
    const { error } = await sb.from('vendor_projects').upsert(row, { onConflict: 'id' });
    if (error) throw new Error('project ' + title + ': ' + error.message);
  }
  // a few events on the recurring-problem project (history)
  const events = [
    ['ev1', P(1), 'created', null, 'requested', 'Reported: Median 7 zone not holding pressure; third controller fault this year.', -50],
    ['ev2', P(1), 'stage_change', 'board_deciding', 'approved', 'Board approved controller replacement.', -46],
    ['ev3', P(1), 'stage_change', 'approved', 'work_started', 'AquaFlow began replacement.', -45],
    ['ev4', P(2), 'completed', 'work_started', 'closed', 'Prior-year mainline repair completed.', -380],
  ];
  for (const [k, pid, et, fr, to, note, d] of events) {
    const eid = `e01e000${k.slice(-1)}-0000-4000-a000-000000000000`;
    const { error } = await sb.from('vendor_project_events').upsert({ id: eid, project_id: pid, community_id: LMA, event_type: et, from_stage: fr, to_stage: to, note, created_at: new Date(Date.now() + d * 86400000).toISOString() }, { onConflict: 'id' });
    if (error) throw new Error('event ' + k + ': ' + error.message);
  }
  // board motion approving the Median 7 controller project
  const { error: mErr } = await sb.from('board_motions').upsert({ id: MOTION, management_company_id: DEMO_MGMT_CO_ID, community_id: LMA, motion_type: 'project', related_project_id: P(1), title: 'Approve Median 7 irrigation controller replacement ($12,500)', description: 'Recurring irrigation failures at Median 7. Motion to approve AquaFlow proposal for full controller replacement, funded from operating.', threshold: 'simple_majority', status: 'passed' }, { onConflict: 'id' });
  if (mErr) throw new Error('motion: ' + mErr.message);
  // invoices + lines (project-attributed)
  for (const [invId, number, vNo, status, paid, dateOff, lines] of INVOICES) {
    const total = lines.reduce((s, l) => s + l[1], 0);
    const { error: iErr } = await sb.from('ap_invoices').upsert({ id: invId, community_id: LMA, vendor_id: V(vNo), vendor_invoice_number: number, invoice_date: day(dateOff), subtotal_cents: total, total_cents: total, amount_paid_cents: paid, status }, { onConflict: 'id' });
    if (iErr) throw new Error('invoice ' + number + ': ' + iErr.message);
    // replace lines idempotently
    await sb.from('ap_invoice_lines').delete().eq('invoice_id', invId);
    let ln = 0;
    for (const [desc, amt, acctNo, projectId] of lines) {
      ln++;
      const { error: lErr } = await sb.from('ap_invoice_lines').insert({ invoice_id: invId, line_number: ln, description: desc, amount_cents: amt, gl_account_id: AC(acctNo), project_id: projectId });
      if (lErr) throw new Error('invoice line ' + number + '#' + ln + ': ' + lErr.message);
    }
  }
  console.log('EXECUTE complete: vendors, fund+accounts, projects (asset-linked), events, board motion, project-attributed invoices.');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
