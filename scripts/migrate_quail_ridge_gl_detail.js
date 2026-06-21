// ============================================================================
// scripts/migrate_quail_ridge_gl_detail.js
// ----------------------------------------------------------------------------
// Upgrade Quail Ridge's 2026 GL from monthly SUMMARY entries to line-level
// DETAIL, so trustEd is the true book of record from the 6/1/2026 cutover —
// every account balance traces to individual transactions, not a monthly lump.
//
// Source: Vantaca GL Trial Balance detail (GLTrialBalance.xls), 1,024 lines,
// Jan 1 – May 31 2026. Vantaca stamps a Ledger ID on only ~30% of lines, so we
// group by DAY: every day's lines balance on their own (verified), so one
// balanced journal entry per active day preserves all line detail.
//
// Replaces the monthly 'vantaca_import' activity entries (JE-2026-MM-ACT) with
// daily ones; leaves the opening entry (JE-2026-OPEN) untouched. Verifies the
// trial balance still ties to Vantaca's ending column to the penny.
// --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const FILE = fileArg ? fileArg.split('=').slice(1).join('=') : 'C:/Users/edget/Downloads/GLTrialBalance.xls';
const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '-' || t === '') return 0; const neg = /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };

(async () => {
  // 1) Parse detail lines, grouped by ISO day.
  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets['GLTrialBalance'], { header: 1, defval: null, raw: false });
  let acct = null;
  const byDay = {}; // iso -> [{acctNum, debit, credit, desc, type}]
  for (const r of aoa) {
    const c0 = String((r && r[0]) || '').trim();
    const m = c0.match(/^(\d{4})\s*-\s*(.+)/);
    if (m) { acct = m[1]; continue; }
    const dm = String((r && r[1]) || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!acct || !dm) continue;
    const iso = `${dm[3]}-${dm[1]}-${dm[2]}`;
    const debit = D(num(r[8])), credit = D(num(r[10]));
    if (debit === 0 && credit === 0) continue;
    const desc = String(r[3] || '').trim();
    // "Credit Distribution" is a SUBLEDGER credit reallocation (redistributing a
    // homeowner's credit balance across charges), NOT a cash transaction —
    // Vantaca routes it through the cash account as net-zero Dr/Cr pairs. Skip
    // those cash legs so the cash ledger stays a clean record of actual money;
    // the real AR/prepaid legs are preserved. (cleanup: clean_qr_credit_distribution_cash.js)
    if (acct === '1000' && /credit distribution/i.test(desc)) continue;
    (byDay[iso] = byDay[iso] || []).push({ acctNum: acct, debit, credit, desc, type: String(r[12] || '').trim() });
  }
  const days = Object.keys(byDay).sort();
  let lineCount = 0;
  for (const d of days) {
    const dr = byDay[d].reduce((a, l) => a + l.debit, 0), cr = byDay[d].reduce((a, l) => a + l.credit, 0);
    if (dr !== cr) { console.error(`Refusing: ${d} does not balance (${dr} vs ${cr}).`); process.exit(1); }
    lineCount += byDay[d].length;
  }
  console.log(`${days.length} active days, ${lineCount} lines, ${days[0]} → ${days[days.length - 1]} — all balance ✓`);

  // 2) Resolve accounts + periods.
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const { data: periods } = await s.from('accounting_periods').select('id, period_number').eq('community_id', CID).eq('fiscal_year', 2026);
  const periodId = Object.fromEntries(periods.map((p) => [p.period_number, p.id]));
  const missing = [...new Set(days.flatMap((d) => byDay[d].map((l) => l.acctNum)))].filter((n) => !acctId[n]);
  if (missing.length) { console.error('Refusing: unknown accounts', missing.join(', ')); process.exit(1); }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to replace monthly summaries with daily detail.'); return; }

  // 3) Idempotent: clear prior vantaca_import entries ONLY within this file's
  // date range, so re-running one month (or adding a new month) leaves the
  // other months' detail untouched. Opening entry (opening_entry) is never hit.
  const { data: prior } = await s.from('journal_entries').select('id')
    .eq('community_id', CID).eq('source_module', 'vantaca_import')
    .gte('posting_date', days[0]).lte('posting_date', days[days.length - 1]);
  if (prior && prior.length) {
    await s.from('journal_entry_lines').delete().in('journal_entry_id', prior.map((j) => j.id));
    await s.from('journal_entries').delete().in('id', prior.map((j) => j.id));
    console.log(`Cleared ${prior.length} prior entries in ${days[0]}..${days[days.length - 1]}.`);
  }

  // 4) Post one balanced JE per day, with every line preserved.
  let posted = 0, postedLines = 0;
  for (const d of days) {
    const lines = byDay[d];
    const dr = lines.reduce((a, l) => a + l.debit, 0), cr = lines.reduce((a, l) => a + l.credit, 0);
    const mm = Number(d.slice(5, 7));
    const { data: je, error: jeErr } = await s.from('journal_entries').insert({
      community_id: CID, period_id: periodId[mm], posting_date: d,
      reference: `JE-2026-D-${d.replace(/-/g, '')}`,
      description: `Daily activity ${d} (migrated from Vantaca GL detail)`,
      source_module: 'vantaca_import', total_debits_cents: dr, total_credits_cents: cr, status: 'posted',
    }).select('id').single();
    if (jeErr) { console.error(`${d} JE failed:`, jeErr.message); process.exit(1); }
    const rows = lines.map((l, i) => ({
      journal_entry_id: je.id, line_number: i + 1, account_id: acctId[l.acctNum],
      debit_cents: l.debit, credit_cents: l.credit,
      memo: (l.type ? l.type + ': ' : '') + (l.desc || '').slice(0, 180),
    }));
    for (let i = 0; i < rows.length; i += 200) { const { error } = await s.from('journal_entry_lines').insert(rows.slice(i, i + 200)); if (error) { console.error(`${d} lines failed:`, error.message); process.exit(1); } }
    posted++; postedLines += rows.length;
  }
  console.log(`Posted ${posted} daily entries, ${postedLines} lines.`);

  // 5) Verify trial balance still ties to Vantaca endings.
  const van = {};
  for (const r of aoa) { const m = String((r && r[0]) || '').trim().match(/^(\d{4})\s*-\s*(.+)/); if (m) van[m[1]] = D(num(r[11])); }
  const { data: tb } = await s.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', CID);
  let bad = 0, tdr = 0, tcr = 0;
  for (const a of tb) {
    const signed = Number(a.total_debits_cents) - Number(a.total_credits_cents);
    tdr += Number(a.total_debits_cents); tcr += Number(a.total_credits_cents);
    if (van[a.account_number] != null && Math.abs(signed - van[a.account_number]) >= 1) { bad++; console.log(`  MISMATCH ${a.account_number}: trustEd ${signed} vs Vantaca ${van[a.account_number]}`); }
  }
  console.log(`Trial balance: ${(tdr / 100).toLocaleString()} DR = ${(tcr / 100).toLocaleString()} CR ${tdr === tcr ? '✓' : '✗'} | ${bad === 0 ? 'ALL ACCOUNTS TIE TO VANTACA ✓' : bad + ' mismatches'}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
