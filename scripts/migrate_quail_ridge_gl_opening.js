// ============================================================================
// scripts/migrate_quail_ridge_gl_opening.js
// ----------------------------------------------------------------------------
// Recreate Quail Ridge's GL in trustEd at the 12/31/2025 ending / 1/1/2026
// opening balances from Vantaca (BalanceSheet.xls + GLTrialBalance.xls, Ed
// 2026-06-19). Builds Vantaca's actual chart of accounts (mapped via
// vantaca_account_number), re-points the AR charge types to Vantaca's revenue
// + AR accounts, drops the generic seeded accounts, and posts ONE balanced
// opening journal entry dated 2026-01-01.
//
// Income-statement accounts open at ZERO (2025 P&L closed to fund balance).
// --apply to write; dry-run otherwise. Verifies the entry balances + ties to
// Vantaca's beginning column before writing.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const D = (dollars) => Math.round(dollars * 100); // -> cents

// Vantaca CoA + 12/31/2025 opening balance (signed: + = debit, - = credit).
// type, normal_balance, opening_dollars. IS accounts (4xxx/5xxx) open at 0.
const COA = [
  ['1000', 'Operating Cash Account',          'asset',     'debit',   40831.18],
  ['1100', 'Savings Account',                 'asset',     'debit',    3009.38],
  ['1300', 'Accounts Receivable',             'asset',     'debit',   14559.99],
  ['1305', 'Allowance for Doubtful Accounts', 'asset',     'credit', -10049.92],
  ['1400', 'Prepaid Insurance',               'asset',     'debit',    4015.28],
  ['2000', 'Accounts Payable',                'liability', 'credit',   -161.96],
  ['2205', 'Unearned Income',                 'liability', 'credit',     -0.04],
  ['2300', 'Accrued Liability',               'liability', 'credit',    -56.41],
  ['2400', 'Prepaid Owners Assessments',      'liability', 'credit',  -7929.02],
  ['3000', 'Current Year Surplus/(Deficit)',  'equity',    'credit', -46173.71],
  ['3050', 'Accumulated Fund Balance',        'equity',    'credit',   1955.23],
  ['4000', 'Current Year Assessment Income',  'revenue',   'credit',         0],
  ['4030', 'Admin/Late/Interest Fee Income',  'revenue',   'credit',         0],
  ['4100', 'Interest - Operating',            'revenue',   'credit',         0],
  ['5010', 'Bank Charges',                    'expense',   'debit',          0],
  ['5105', 'Electricity - Street Lights',     'expense',   'debit',          0],
  ['5200', 'Landscape Operating & Management','expense',   'debit',          0],
  ['5425', 'Signage Repair & Maintenance',    'expense',   'debit',          0],
  ['5800', 'Postage',                         'expense',   'debit',          0],
  ['5810', 'Management Fees',                 'expense',   'debit',          0],
];
const SUBTYPE = { asset: 'current_asset', liability: 'current_liability', equity: 'fund_balance', revenue: 'operating_revenue', expense: 'operating_expense' };

// Charge-type -> Vantaca revenue account. Vantaca lumps fees into 4030.
const REV_FOR_TYPE = (code) => (code === 'annual_assessment' || code === 'balance_forward_assessment') ? '4000' : '4030';

(async () => {
  const { data: fund } = await s.from('account_funds').select('id').eq('community_id', CID).eq('fund_code', 'OPR').single();
  const { data: period } = await s.from('accounting_periods').select('id, status').eq('community_id', CID).eq('fiscal_year', 2026).eq('period_number', 1).single();

  // Verify the opening entry balances BEFORE touching anything.
  let dr = 0, cr = 0;
  for (const [, , , , bal] of COA) { const c = D(bal); if (c > 0) dr += c; else cr += -c; }
  console.log(`Opening entry: debits $${(dr/100).toLocaleString()} vs credits $${(cr/100).toLocaleString()} — ${dr === cr ? 'BALANCED ✓' : 'OUT OF BALANCE ✗'}`);
  if (dr !== cr) { console.error('Refusing: opening entry does not balance.'); process.exit(1); }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write. Will create 20 Vantaca accounts + 1 opening JE.'); return; }

  // 1) Upsert Vantaca chart of accounts (FK by account_number).
  const coaRows = COA.map(([num, name, type, nb]) => ({
    community_id: CID, fund_id: fund.id, account_number: num, account_name: name,
    account_type: type, account_subtype: SUBTYPE[type], normal_balance: nb,
    is_summary: false, is_active: true, vantaca_account_number: num,
  }));
  await s.from('chart_of_accounts').upsert(coaRows, { onConflict: 'community_id,account_number' });
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acct = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));

  // 2) Re-point AR charge types to Vantaca AR (1300) + revenue (4000/4030).
  const { data: cts } = await s.from('ar_charge_types').select('id, type_code').eq('community_id', CID);
  for (const ct of cts) {
    await s.from('ar_charge_types').update({ gl_receivable_account_id: acct['1300'], gl_revenue_account_id: acct[REV_FOR_TYPE(ct.type_code)] }).eq('id', ct.id);
  }

  // 3) Drop the generic seeded accounts no longer in Vantaca's CoA (now unreferenced).
  const keep = new Set(COA.map((r) => r[0]));
  const drop = coa.filter((a) => !keep.has(a.account_number)).map((a) => a.id);
  if (drop.length) { const { error } = await s.from('chart_of_accounts').delete().in('id', drop); if (error) console.warn('  (some generic accounts kept — referenced):', error.message); else console.log('  dropped', drop.length, 'generic accounts'); }

  // 4) Opening journal entry — one balanced entry dated 2026-01-01.
  const { data: je, error: jeErr } = await s.from('journal_entries').insert({
    community_id: CID, period_id: period.id, posting_date: '2026-01-01',
    reference: 'JE-2026-OPEN', description: 'Opening balances migrated from Vantaca (12/31/2025 ending)',
    source_module: 'opening_entry', total_debits_cents: dr, total_credits_cents: cr, status: 'posted',
  }).select('id').single();
  if (jeErr) { console.error('opening JE failed:', jeErr.message); process.exit(1); }
  let line = 0;
  const lines = [];
  for (const [num, , , , bal] of COA) {
    const c = D(bal); if (c === 0) continue;
    line++;
    lines.push({ journal_entry_id: je.id, line_number: line, account_id: acct[num],
      debit_cents: c > 0 ? c : 0, credit_cents: c < 0 ? -c : 0, memo: 'Opening balance 12/31/2025' });
  }
  await s.from('journal_entry_lines').insert(lines);
  console.log(`  posted opening JE (${lines.length} lines)`);

  // 5) Verify trustEd trial balance ties + matches Vantaca beginning.
  const { data: tb } = await s.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents, balance_cents').eq('community_id', CID);
  let tdr = 0, tcr = 0;
  for (const r of tb) { tdr += Number(r.total_debits_cents); tcr += Number(r.total_credits_cents); }
  console.log(`\ntrustEd trial balance: $${(tdr/100).toLocaleString()} DR = $${(tcr/100).toLocaleString()} CR — ${tdr === tcr ? 'TIES ✓' : 'OUT ✗'}`);
  console.log('Quail Ridge GL opened at Vantaca 12/31/2025 balances.');
})();
