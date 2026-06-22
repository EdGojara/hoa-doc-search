// Load the Quail Ridge FY2026 proposed budget into community_budgets +
// budget_line_items. Monthly = 1/12 of annual (December absorbs the rounding
// remainder so the 12 months sum to the annual exactly). Idempotent: replaces
// any existing QR 2026 budget; creates missing expense accounts.
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const QR = 'a0000000-0000-4000-8000-000000000005';
const OPERATING_FUND = '94409725-c817-4cde-8a8e-63cff2ab1706';
const YEAR = 2026;

function monthlyArray(annual) {
  const m = Math.floor(annual / 12);
  const arr = Array(12).fill(m);
  arr[11] = annual - m * 11;
  return arr;
}

(async () => {
  const budget = JSON.parse(fs.readFileSync('_qr_budget_raw.json', 'utf8'));

  // 1) Ensure every budget account exists in the chart.
  const { data: coa } = await sb.from('chart_of_accounts')
    .select('id, account_number, account_type').eq('community_id', QR);
  const byNum = new Map((coa || []).map((a) => [a.account_number, a]));
  const created = [];
  for (const ln of budget.lines) {
    if (!ln.account_number || byNum.has(ln.account_number)) continue;
    const isRev = ln.section === 'revenue';
    const row = {
      community_id: QR, fund_id: OPERATING_FUND,
      account_number: ln.account_number, account_name: ln.label,
      account_type: isRev ? 'revenue' : 'expense',
      account_subtype: isRev ? 'operating_revenue' : 'operating_expense',
      normal_balance: isRev ? 'credit' : 'debit',
      vantaca_account_number: ln.account_number, is_active: true,
    };
    const { data: ins, error } = await sb.from('chart_of_accounts').insert(row).select('id, account_number').single();
    if (error) { console.error('account insert failed', ln.account_number, error.message); process.exit(1); }
    byNum.set(ins.account_number, { id: ins.id, account_number: ins.account_number });
    created.push(ln.account_number + ' ' + ln.label);
  }
  console.log('Accounts created:', created.length ? created.join('; ') : 'none (all existed)');

  // 2) Replace any existing QR 2026 budget.
  const { data: existing } = await sb.from('community_budgets').select('id').eq('community_id', QR).eq('fiscal_year', YEAR);
  for (const b of (existing || [])) { await sb.from('community_budgets').delete().eq('id', b.id); }

  const { data: bud, error: budErr } = await sb.from('community_budgets').insert({
    community_id: QR, fiscal_year: YEAR, status: 'active',
    source_filename: 'ProposedBudgetQR.2026.pdf',
    notes: 'Loaded from proposed budget PDF; monthly = 1/12 of annual.',
  }).select('id').single();
  if (budErr) { console.error('budget insert failed:', budErr.message); process.exit(1); }

  // 3) Insert line items.
  let rev = 0, exp = 0, n = 0;
  for (const ln of budget.lines) {
    const acct = byNum.get(ln.account_number);
    if (!acct) { console.warn('skip line, no account:', ln.label); continue; }
    const annual = Number(ln.annual_cents || 0);
    const { error } = await sb.from('budget_line_items').insert({
      budget_id: bud.id, account_id: acct.id, fund_id: OPERATING_FUND,
      annual_amount_cents: annual, monthly_amounts_cents: monthlyArray(annual),
    });
    if (error) { console.error('line insert failed', ln.label, error.message); process.exit(1); }
    if (ln.section === 'revenue') rev += annual; else exp += annual;
    n++;
  }
  console.log(`Budget loaded: ${n} lines | revenue $${(rev/100).toFixed(2)} | expense $${(exp/100).toFixed(2)} | net $${((rev-exp)/100).toFixed(2)}`);
  console.log('budget_id:', bud.id, '| status: active');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
