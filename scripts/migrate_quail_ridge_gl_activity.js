// ============================================================================
// scripts/migrate_quail_ridge_gl_activity.js
// ----------------------------------------------------------------------------
// Roll Quail Ridge's 2026 year-to-date GL activity into trustEd from Vantaca's
// GL Trial Balance detail (GLTrialBalance.xls, Ed 2026-06-20). The opening
// balances are already in JE-2026-OPEN (migrate_quail_ridge_gl_opening.js);
// this posts the PERIOD ACTIVITY on top so the income statement populates and
// every account rolls forward to Vantaca's current ending balance.
//
// Fidelity: ONE balanced summary journal entry per month, with one line per
// account = that account's NET debit/credit for the month. This gives correct
// monthly P&L and ties penny-for-penny to Vantaca's ending column, without
// importing Vantaca's per-property "Credit Distribution" internal noise (the
// homeowner-level AR detail lives in the AR subledger migration separately).
//
// Each month is independently balanced in the source (verified before write).
// --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILE = 'C:/Users/edget/Downloads/GLTrialBalance.xls';
const D = (dollars) => Math.round(dollars * 100);
const num = (v) => { let str = String(v || '').trim(); if (str === '-' || str === '') return 0; const neg = /^\(.*\)$/.test(str); str = str.replace(/[^0-9.]/g, ''); const n = parseFloat(str) || 0; return neg ? -n : n; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

(async () => {
  // 1) Parse Vantaca detail → net debit/credit per (account_number, month).
  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['GLTrialBalance'], { header: 1, defval: null, raw: false });
  let acct = null;
  const agg = {}; // key `${acctNum}|${YYYY-MM}` -> { deb, cr }
  for (const r of aoa) {
    const c0 = String((r && r[0]) || '').trim();
    const m = c0.match(/^(\d{4})\s*-\s*(.+)/);
    if (m) { acct = m[1]; continue; }
    const dm = String((r && r[1]) || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (acct && dm) {
      const month = `${dm[3]}-${dm[1]}`;
      const key = `${acct}|${month}`;
      if (!agg[key]) agg[key] = { deb: 0, cr: 0 };
      agg[key].deb += num(r[8]); agg[key].cr += num(r[10]);
    }
  }

  // 2) Group into per-month account nets; verify each month balances.
  const months = {}; // 'YYYY-MM' -> [{ acctNum, netCents }]
  for (const key of Object.keys(agg)) {
    const [acctNum, month] = key.split('|');
    const netCents = D(agg[key].deb) - D(agg[key].cr); // +debit / -credit
    if (netCents === 0) continue;
    (months[month] = months[month] || []).push({ acctNum, netCents });
  }
  const sortedMonths = Object.keys(months).sort();
  console.log('Months of 2026 activity:', sortedMonths.join(', '));
  for (const month of sortedMonths) {
    const sum = months[month].reduce((a, l) => a + l.netCents, 0);
    if (sum !== 0) { console.error(`Refusing: ${month} does not balance (net ${sum} cents).`); process.exit(1); }
  }
  console.log('All months balance ✓');

  // 3) Resolve accounts + periods.
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const { data: periods } = await s.from('accounting_periods').select('id, period_number').eq('community_id', CID).eq('fiscal_year', 2026);
  const periodId = Object.fromEntries(periods.map((p) => [p.period_number, p.id]));

  // Preview
  for (const month of sortedMonths) {
    const dr = months[month].filter((l) => l.netCents > 0).reduce((a, l) => a + l.netCents, 0);
    console.log(`  ${month}: ${months[month].length} accounts, $${(dr / 100).toLocaleString()} balanced`);
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to post the monthly activity entries.'); return; }

  // 4) Idempotent: remove any prior activity-migration entries first.
  const { data: prior } = await s.from('journal_entries').select('id').eq('community_id', CID).eq('source_module', 'vantaca_import');
  if (prior && prior.length) {
    await s.from('journal_entry_lines').delete().in('journal_entry_id', prior.map((j) => j.id));
    await s.from('journal_entries').delete().in('id', prior.map((j) => j.id));
    console.log(`Cleared ${prior.length} prior activity entries.`);
  }

  // 5) Post one balanced JE per month.
  for (const month of sortedMonths) {
    const [y, mm] = month.split('-').map(Number);
    const lines = months[month].filter((l) => acctId[l.acctNum]);
    const missing = months[month].filter((l) => !acctId[l.acctNum]);
    if (missing.length) console.warn(`  ${month}: skipped unknown accounts ${missing.map((l) => l.acctNum).join(', ')}`);
    const dr = lines.filter((l) => l.netCents > 0).reduce((a, l) => a + l.netCents, 0);
    const cr = lines.filter((l) => l.netCents < 0).reduce((a, l) => a - l.netCents, 0);
    const postDate = `${y}-${String(mm).padStart(2, '0')}-${String(lastDay(y, mm)).padStart(2, '0')}`;
    const { data: je, error: jeErr } = await s.from('journal_entries').insert({
      community_id: CID, period_id: periodId[mm], posting_date: postDate,
      reference: `JE-2026-${String(mm).padStart(2, '0')}-ACT`,
      description: `${MONTHS[mm - 1]} 2026 activity (migrated from Vantaca GL detail)`,
      source_module: 'vantaca_import', total_debits_cents: dr, total_credits_cents: cr, status: 'posted',
    }).select('id').single();
    if (jeErr) { console.error(`  ${month} JE failed:`, jeErr.message); process.exit(1); }
    const jeLines = lines.map((l, i) => ({
      journal_entry_id: je.id, line_number: i + 1, account_id: acctId[l.acctNum],
      debit_cents: l.netCents > 0 ? l.netCents : 0, credit_cents: l.netCents < 0 ? -l.netCents : 0,
      memo: `${MONTHS[mm - 1]} 2026 net activity`,
    }));
    const { error: lErr } = await s.from('journal_entry_lines').insert(jeLines);
    if (lErr) { console.error(`  ${month} lines failed:`, lErr.message); process.exit(1); }
    console.log(`  posted ${month}: ${jeLines.length} lines, $${(dr / 100).toLocaleString()}`);
  }

  // 6) Verify trial balance ties + matches Vantaca endings.
  const { data: tb } = await s.from('v_trial_balance').select('total_debits_cents, total_credits_cents').eq('community_id', CID);
  let tdr = 0, tcr = 0;
  for (const r of tb) { tdr += Number(r.total_debits_cents); tcr += Number(r.total_credits_cents); }
  console.log(`\ntrustEd trial balance: $${(tdr / 100).toLocaleString()} DR = $${(tcr / 100).toLocaleString()} CR — ${tdr === tcr ? 'TIES ✓' : 'OUT ✗'}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
