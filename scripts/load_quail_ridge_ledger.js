// ============================================================================
// scripts/load_quail_ridge_ledger.js
// ----------------------------------------------------------------------------
// Load Quail Ridge's per-homeowner transaction ledger from Vantaca's Transaction
// History export (TransactionHistoryAssoc (1).xls) — the clean, statement-ready
// source (prior balance -> charges -> payments -> running balance), matched to
// property by Vantaca account id. Powers the homeowner account view + statements.
// Requires migration 236. --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILE = 'C:/Users/edget/Downloads/TransactionHistoryAssoc (1).xls';
const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '' || t === '-') return 0; const neg = /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };
const iso = (mdy) => { const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

(async () => {
  const props = [];
  let pf = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address, vantaca_account_id').eq('community_id', CID).range(pf, pf + 999); props.push(...data); if (data.length < 1000) break; pf += 1000; }
  const byAcct = new Map(props.filter((p) => p.vantaca_account_id).map((p) => [String(p.vantaca_account_id), p]));

  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets[XLSX.readFile(FILE).SheetNames[0]], { header: 1, defval: null, raw: false });
  const rows = [];
  let cur = null, seq = 0, lastDate = null;
  const unmatched = new Set();
  for (const r of aoa) {
    const c0 = String((r && r[0]) || '').trim();
    const m = c0.match(/^(\d{8})\s*-\s*(.+)/);
    if (m) { cur = byAcct.get(m[1]); if (!cur) unmatched.add(m[1] + ' / ' + m[2]); seq = 0; lastDate = null; continue; }
    if (!cur) continue;
    const date = iso(r[1]);
    if (!date) continue;
    const desc = String((r && r[2]) || '').trim();
    const charge = D(num(r[3])), payment = Math.abs(D(num(r[4]))), balance = D(num(r[5]));
    seq = (date === lastDate) ? seq + 1 : 0; lastDate = date;
    let type = 'charge';
    if (/prior balance/i.test(desc)) type = 'prior_balance';
    else if (/void/i.test(desc)) type = 'void';
    else if (payment > 0 && charge === 0) type = 'payment';
    rows.push({ community_id: CID, property_id: cur.id, entry_date: date, description: desc, charge_cents: charge, payment_cents: payment, running_balance_cents: balance, entry_type: type, source: 'vantaca_history', sort_seq: seq });
  }
  console.log(`Parsed ${rows.length} ledger entries across ${new Set(rows.map((r) => r.property_id)).size} properties.`);
  if (unmatched.size) { console.log('Unmatched accounts:', unmatched.size); [...unmatched].slice(0, 5).forEach((u) => console.log('  ' + u)); }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply (requires migration 236).'); return; }
  await s.from('homeowner_ledger_entries').delete().eq('community_id', CID).eq('source', 'vantaca_history');
  for (let i = 0; i < rows.length; i += 500) { const { error } = await s.from('homeowner_ledger_entries').insert(rows.slice(i, i + 500)); if (error) { console.error('insert failed:', error.message); process.exit(1); } }
  console.log(`\nLoaded ${rows.length} ledger entries. Homeowner accounts now have transaction history + statements.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
