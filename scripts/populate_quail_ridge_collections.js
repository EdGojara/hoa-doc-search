// ============================================================================
// scripts/populate_quail_ridge_collections.js
// ----------------------------------------------------------------------------
// Seed ar_account_collections for Quail Ridge from the "Coll Status: <status>"
// markers in the Vantaca AR Aging account headers (AR Aging.xls, Ed
// 2026-06-20). Matched by Vantaca account id. Idempotent (upsert on
// community_id, property_id). Bankruptcy petition date is NOT in the export —
// it's left null for Ed to enter via the UI; the pre/post-petition split
// activates the moment it's set.
//
// Requires migration 232 applied first.
//   node scripts/populate_quail_ridge_collections.js [--apply]
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILE = 'C:/Users/edget/Downloads/AR Aging.xls';

const STATUS_MAP = {
  'with attorney': 'with_attorney',
  'bankruptcy': 'bankruptcy',
  'board review': 'board_review',
  'late notice': 'late_notice',
  'delinquent balance reminder': 'delinquent_reminder',
  'certified demand': 'certified_demand',
  'payment plan': 'payment_plan',
};

(async () => {
  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['AR Aging'], { header: 1, defval: null, raw: false });
  const found = [];
  for (const r of aoa) {
    const c0 = String((r && r[0]) || '').trim();
    const m = c0.match(/^(\d{8})\s*-\s*(.+)/);
    if (!m) continue;
    const cm = m[2].match(/Coll Status:\s*(.+?)\s*$/i);
    if (!cm) continue;
    const raw = cm[1].trim();
    const status = STATUS_MAP[raw.toLowerCase()];
    if (!status) { console.warn('UNMAPPED status:', raw); continue; }
    found.push({ acct: m[1], raw, status });
  }
  console.log(`Found ${found.length} accounts with a collection status.`);

  // resolve to property_id via vantaca_account_id
  const props = [];
  let pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address, vantaca_account_id').eq('community_id', CID).range(pf, pf + 999); props.push(...data); if (data.length < 1000) break; pf += 1000; }
  const byAcct = new Map(props.filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p]));

  const rows = [];
  for (const f of found) {
    const p = byAcct.get(f.acct);
    if (!p) { console.warn('  no property for acct', f.acct); continue; }
    rows.push({ community_id: CID, property_id: p.id, collection_status: f.status });
    console.log(`  ${f.acct}  ${p.street_address.padEnd(28).slice(0, 28)}  ${f.raw}  ->  ${f.status}`);
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to upsert (requires migration 232).'); return; }
  const { error } = await s.from('ar_account_collections').upsert(rows, { onConflict: 'community_id,property_id' });
  if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  console.log(`\nUpserted ${rows.length} collection records. Bankruptcy petition date(s) pending Ed's entry in the UI.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
