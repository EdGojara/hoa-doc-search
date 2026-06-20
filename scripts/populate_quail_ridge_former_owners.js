// ============================================================================
// scripts/populate_quail_ridge_former_owners.js
// ----------------------------------------------------------------------------
// Load Quail Ridge's former-owner credit balances (the "***" accounts in
// PrepaidHomeowners.xls — owners who left money behind, sitting in GL 2400).
// Stored as negative balances (HOA owes them a refund). Surfaces in the AR
// aging so the exposure is visible. Requires migration 234.
// --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILE = 'C:/Users/edget/Downloads/PrepaidHomeowners.xls';
const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '-' || t === '') return 0; const neg = /^-/.test(t) || /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };

(async () => {
  // current-property account ids (to exclude — those are current owners, booked elsewhere)
  const props = [];
  let pf = 0;
  while (true) { const { data } = await s.from('properties').select('vantaca_account_id').eq('community_id', CID).range(pf, pf + 999); props.push(...data); if (data.length < 1000) break; pf += 1000; }
  const currentAccts = new Set(props.filter((p) => p.vantaca_account_id).map((p) => String(p.vantaca_account_id)));

  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['PrepaidHomeowners'], { header: 1, defval: null, raw: false });
  const rows = [];
  for (const r of aoa) {
    const acctRaw = String((r && r[0]) || '').trim();
    const m = acctRaw.match(/^\**\s*(\d{8})/);
    if (!m) continue;
    const acct = m[1], prior = acctRaw.includes('***');
    const amt = D(num(r[4]));
    if (amt === 0) continue;
    // former owner = flagged "***" OR not a current property in our roster
    if (!prior && currentAccts.has(acct)) continue;
    rows.push({
      community_id: CID, vantaca_account_id: acct,
      owner_name: String(r[3] || '').trim().replace(/^-\s*/, ''),
      property_address: String(r[1] || '').trim(),
      balance_cents: -amt, // HOA owes them -> negative
      kind: 'refund_owed', status: 'open', gl_account_number: '2400',
      notes: 'Credit left by former owner — refund/escheatment pending',
    });
  }
  const total = rows.reduce((a, r) => a + r.balance_cents, 0);
  console.log(`Former-owner credit accounts: ${rows.length}, total ${'$' + (total / 100).toFixed(2)} (HOA owes)`);
  rows.forEach((r) => console.log(`  ${r.vantaca_account_id}  ${(r.owner_name || '').padEnd(26).slice(0, 26)} ${('$' + (r.balance_cents / 100).toFixed(2)).padStart(10)}  ${r.property_address}`));

  if (!APPLY) { console.log('\nDRY RUN — pass --apply (requires migration 234).'); return; }
  const { error } = await s.from('former_owner_balances').upsert(rows, { onConflict: 'community_id,vantaca_account_id' });
  if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  console.log(`\nLoaded ${rows.length} former-owner balances. They now appear in the AR aging.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
