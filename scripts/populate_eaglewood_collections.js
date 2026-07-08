// ============================================================================
// scripts/populate_eaglewood_collections.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Seed ar_account_collections for Eaglewood from the Winstead PC "Matter Detail
// Portrait" collections status report (as of 2026-07-01, 20 active matters,
// emailed by Winstead 2026-07-07). Matched to properties by street address.
//
// Status is mapped from each matter's LATEST action + note (where the account
// is *today*), not the furthest point it ever reached — an account that reached
// a lien and has since paid down to a balance-due state is 'lien_filed', not
// 'foreclosure'. The full matter detail (firm file #, balance, attorney fee,
// latest action, latest note, as-of date) is preserved verbatim in `notes` so
// nothing from the source is lost. Idempotent (upsert on community_id,property_id).
//
// Requires migration 232 applied.
//   node scripts/populate_eaglewood_collections.js [--apply]
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000004';
const AS_OF = '2026-07-01';

const norm = (a) => String(a || '').toLowerCase()
  .replace(/\bdrive\b/g, 'dr').replace(/\bcourt\b/g, 'ct').replace(/\blane\b/g, 'ln')
  .replace(/\bshadows\b/g, 'shadow').replace(/[^a-z0-9]+/g, ' ').trim();

// [ firmFile, address, debtors, balance, attyFee, collectionCost, status, status_since, latestAction, note ]
const M = [
  ['71335-11', '9210 Floral Crest Drive', 'Adebayo Ojo and Olusola Akintola', 681.57, 0, 30, 'lien_filed', '2026-01-13', 'Balance Due Notice (6/30/2026)', 'Homeowner submitting payments; recorded lien on file.'],
  ['71335-12', '16102 Williwaw Drive', 'Akondaye Savonda Turner-Fountain', 2407.30, 250, 0, 'lien_filed', '2026-06-30', 'Lien Notice Letter w/ Recorded Lien (6/30/2026)', 'Recorded lien mailed 6/30/2026. Prior payment plan (6/6/2025) not maintained.'],
  ['71335-13', '9411 Taloncrest Court', 'Andre S. Perry and Lagatha M. Polk', 642.06, 0, 0, 'lien_filed', '2025-08-22', 'Balance Due Notice (1/8/2026)', 'Winstead to CLOSE account and remove from collections (per 6/30/2026 note) — confirm disposition/payoff.'],
  ['71335-14', '9331 Floral Crest Drive', 'Calandrian Perry and Henry Perry, Jr.', 4292.52, 175, 0, 'foreclosure', '2026-06-30', 'Lien Enforcement Notice w/ Draft Petition (6/30/2026)', 'FORECLOSURE track: 45-day payment demand mailed 6/30/2026. Winstead recommends filing foreclosure suit if no response — BOARD AUTHORIZATION requested.'],
  ['71335-15', '16403 Split Willow Drive', 'Cesar Rebolledo', 6491.55, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-17', '9610 Wildgrass Court', 'Dennis Platt and Ida N. Platt', 6145.61, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-18', '16519 Eaglewood Shadows Drive', 'Donald Ray Sanford', 5708.72, 0, 0, 'foreclosure', '2026-01-12', 'Request for Escrowed Funds (5/28/2026)', 'FORECLOSURE track but ON HOLD pending outcome of a transaction (likely sale/refi) — Winstead holding for escrow payoff.'],
  ['71335-28', '9303 Millcrest Lane', 'Gwendolyn Franklin', 5910.62, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-25', '16111 Dawn Marie Lane', 'John M. Horrell and Jacqueline M. Horrell', 4113.51, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-21', '16310 Lynn Crest Court', 'Jose Raul Mejia', 3907.11, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-23', '9607 Eagle Eye Lane', 'Julian Gomez', 2743.79, 0, 30, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-19', '9235 Hodges Bend Drive', 'Maramba Eliazar and Jeanne Nyangabire', 3505.74, 175, 0, 'foreclosure', '2026-06-30', 'Lien Enforcement Notice w/ Draft Petition (6/30/2026)', 'FORECLOSURE track: 45-day payment demand mailed 6/30/2026. Winstead recommends filing foreclosure suit if no response — BOARD AUTHORIZATION requested.'],
  ['71335-33', '9502 Abigail Drive', 'Michael Tousant and Angenette Tousant', 1906.81, 145, 30, 'bankruptcy', null, 'Initial Demand Letter (1/20/2026)', 'BANKRUPTCY pending as of 7/1/2026 — automatic stay (11 U.S.C. 362). Winstead holding for case outcome. DO NOT send collection communications. Petition date / chapter / case # TBD — enter in UI to activate pre/post-petition split.'],
  ['71335-31', '16103 Williwaw Drive', 'Miguel A. Gonzalez and Dora I. Zepeda', 1183.48, 0, 0, 'lien_filed', '2025-08-28', 'Balance Due Notice (6/30/2026)', 'Reached draft-petition stage; has since paid down. Balance due notice mailed 6/30/2026.'],
  ['71335-9', '9315 Hodges Bend Drive', 'Millard Joseph Smith, III and Melkeisha Mackey Smith', 4744.72, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested. Owner emailed balance/payoff 6/16/2026 (ksmith.processor@gmail.com).'],
  ['71335-10', '16415 Lynn Crest Court', 'Mirna Berrios Reyes', 452.42, 0, 0, 'lien_filed', '2025-08-22', 'Balance Due Notice (6/30/2026)', 'Reached draft-petition stage; has since paid down to $452.42. Balance due notice mailed 6/30/2026.'],
  ['71335-20', '9338 Floral Crest Drive', 'Olue Anjorin', 2790.84, 0, 0, 'payment_plan', '2025-05-12', 'Balance Due Notice (6/30/2026)', 'On payment plan (5/12/2025), making payments; recorded lien on file. Balance due notice mailed 6/30/2026 re remaining balance.'],
  ['71335-7', '9322 Millcrest Lane', 'Queen Lowe', 3230.37, 0, 0, 'payment_plan', '2026-02-12', 'Payment Plan Agreement (2/12/2026)', 'Homeowner making payments per the payment plan.'],
  ['71335-6', '9631 Ravens Nest Court', 'Shabani Mvuyekure and Musa Nimbona', 4926.32, 0, 0, 'foreclosure', '2026-01-12', 'Lien Enforcement Notice w/ Draft Petition (1/12/2026)', 'FORECLOSURE track: Winstead recommends filing foreclosure suit — BOARD AUTHORIZATION requested.'],
  ['71335-5', '16319 Dryberry Court', 'Shelton Samuel and Alma Hernandez', 3655.55, 175, 0, 'foreclosure', '2026-06-30', 'Lien Enforcement Notice w/ Draft Petition (6/30/2026)', 'FORECLOSURE track: 45-day payment demand mailed 6/30/2026. Winstead recommends filing foreclosure suit if no response — BOARD AUTHORIZATION requested.'],
];

(async () => {
  let props = [], pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address').eq('community_id', CID).range(pf, pf + 999); props.push(...(data || [])); if (!data || data.length < 1000) break; pf += 1000; }
  const byNorm = new Map(props.map((p) => [norm(p.street_address), p]));

  const rows = []; let miss = 0;
  const byStatus = {};
  for (const [firm, addr, debtors, bal, atty, coll, status, since, action, note] of M) {
    const p = byNorm.get(norm(addr));
    if (!p) { console.warn('  MISS (no property):', addr); miss++; continue; }
    const feeStr = atty ? ` (incl atty fee $${atty.toFixed(2)}${coll ? `, coll cost $${coll.toFixed(2)}` : ''})` : (coll ? ` (incl coll cost $${coll.toFixed(2)})` : '');
    const notes = `Winstead #${firm} · ${debtors} · Bal $${bal.toFixed(2)}${feeStr} · ${note} · Latest: ${action} · Winstead status report as of ${AS_OF}.`;
    const row = { community_id: CID, property_id: p.id, collection_status: status, status_since: since, notes };
    if (status === 'bankruptcy') { row.bankruptcy_petition_date = null; }
    rows.push(row);
    byStatus[status] = (byStatus[status] || 0) + 1;
    console.log(`  ${firm.padEnd(9)} ${p.street_address.padEnd(30).slice(0,30)} $${bal.toFixed(2).padStart(9)}  ->  ${status}`);
  }
  console.log(`\nMatched ${rows.length}/${M.length} (missed ${miss}).  By status:`, JSON.stringify(byStatus));
  const totalBal = M.reduce((a, m) => a + m[3], 0);
  console.log(`Total AR in collections: $${totalBal.toFixed(2)}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to upsert (requires migration 232).'); return; }
  const { error } = await s.from('ar_account_collections').upsert(rows, { onConflict: 'community_id,property_id' });
  if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  console.log(`\n✓ Upserted ${rows.length} Eaglewood collection records.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
