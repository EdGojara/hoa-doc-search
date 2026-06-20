// ============================================================================
// scripts/adjust_quail_ridge_opening_corrected.js
// ----------------------------------------------------------------------------
// Rebuild Quail Ridge's opening entry (JE-2026-OPEN) to match Ed's CORRECTED
// 12/31/2025 balance sheet (BalanceSheet (1).xls), after he booked the 2025
// insurance amortization + unearned-income cleanup in Vantaca. Changes vs the
// original opening:
//   - 1400 Prepaid Insurance  $4,015.28 -> $1,673.01 (2025 amortization taken)
//   - 2205 Unearned Income    -$0.04    -> removed (4-cent cleanup)
//   - Equity consolidated into 3000 = $41,876.25 (down $2,342.23 net; 3050 -> 0)
//
// Data-driven: parses the corrected balance sheet and rebuilds the opening lines
// to match it exactly (no transcription). Verifies the entry balances first.
// This is the trustEd-side mirror of the 2025 fix Ed made in Vantaca.
// --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILE = 'C:/Users/edget/Downloads/BalanceSheet (1).xls';
const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '-' || t === '') return 0; const neg = /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };

(async () => {
  // Parse corrected balance sheet -> signed debit-positive per account.
  // Layout (null-padded): section header in col 1, "#### - Name" in col 2, value in col 8.
  const wb = XLSX.readFile(FILE);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });
  const bs = {};
  let section = null;
  for (const r of aoa) {
    const s1 = String((r && r[1]) || '').trim();
    if (/^Assets/i.test(s1)) { section = 'asset'; continue; }
    if (/^Liabilities/i.test(s1)) { section = 'liab'; continue; }
    if (/^Equity/i.test(s1)) { section = 'equity'; continue; }
    if (/^Total/i.test(s1) || /^Total/i.test(String((r && r[3]) || ''))) continue;
    const m = String((r && r[2]) || '').trim().match(/^(\d{4})\s*-\s*(.+)/);
    if (!m || !section) continue;
    bs[m[1]] = { signed: D(section === 'asset' ? num(r[8]) : -num(r[8])), name: m[2].trim() };
  }
  const dr = Object.values(bs).filter((v) => v.signed > 0).reduce((a, v) => a + v.signed, 0);
  const cr = Object.values(bs).filter((v) => v.signed < 0).reduce((a, v) => a - v.signed, 0);
  console.log('Corrected 12/31/2025 balance sheet:');
  Object.entries(bs).forEach(([n, v]) => console.log(`  ${n}  ${v.name.padEnd(34).slice(0, 34)} ${('$' + (v.signed / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })).padStart(14)}`));
  console.log(`  Opening: $${(dr / 100).toLocaleString()} DR = $${(cr / 100).toLocaleString()} CR — ${dr === cr ? 'BALANCED ✓' : 'OUT ✗'}`);
  if (dr !== cr) { console.error('Refusing: opening does not balance.'); process.exit(1); }

  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const { data: je } = await s.from('journal_entries').select('id').eq('community_id', CID).eq('reference', 'JE-2026-OPEN').single();

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to rebuild JE-2026-OPEN.'); return; }

  await s.from('journal_entry_lines').delete().eq('journal_entry_id', je.id);
  const lines = [];
  let i = 0;
  for (const [n, v] of Object.entries(bs)) {
    if (v.signed === 0) continue;
    i++;
    lines.push({ journal_entry_id: je.id, line_number: i, account_id: acctId[n], debit_cents: v.signed > 0 ? v.signed : 0, credit_cents: v.signed < 0 ? -v.signed : 0, memo: 'Opening 12/31/2025 (corrected: 2025 insurance amortization + unearned cleanup, booked in Vantaca)' });
  }
  await s.from('journal_entry_lines').insert(lines);
  await s.from('journal_entries').update({ total_debits_cents: dr, total_credits_cents: cr, description: 'Opening balances 12/31/2025 (corrected for 2025 insurance amortization + unearned cleanup)' }).eq('id', je.id);
  console.log(`\nRebuilt JE-2026-OPEN with ${lines.length} lines to match the corrected balance sheet.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
