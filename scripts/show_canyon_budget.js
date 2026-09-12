// READ-ONLY: Canyon Gate at Cinco Ranch FY2026 budget, grouped with totals,
// plus how each expense line is tracking vs actuals this year.
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { budgetVsActual } = require('../lib/accounting/financial_statements');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const CG = 'a0000000-0000-4000-8000-000000000003';
const $ = (c) => '$' + Math.round(Number(c || 0) / 100).toLocaleString('en-US');

(async () => {
  const { data: comm } = await sb.from('communities').select('name').eq('id', CG).maybeSingle();
  const { data: b, error: be } = await sb.from('community_budgets').select('id, fiscal_year, status, source_filename').eq('community_id', CG).eq('fiscal_year', 2026).maybeSingle();
  if (be) { console.error(be.message); process.exit(1); }
  console.log('COMMUNITY:', comm && comm.name, '| FY', b.fiscal_year, '|', b.status, '| src:', b.source_filename);

  const { data: lines, error: le } = await sb.from('budget_line_items')
    .select('annual_amount_cents, chart_of_accounts:account_id(account_number, account_name, account_type)')
    .eq('budget_id', b.id);
  if (le) { console.error(le.message); process.exit(1); }

  const rev = lines.filter((l) => l.chart_of_accounts.account_type === 'revenue').sort((a, b) => a.chart_of_accounts.account_number.localeCompare(b.chart_of_accounts.account_number));
  const exp = lines.filter((l) => l.chart_of_accounts.account_type === 'expense').sort((a, b) => a.chart_of_accounts.account_number.localeCompare(b.chart_of_accounts.account_number));
  const sum = (arr) => arr.reduce((s, l) => s + Number(l.annual_amount_cents), 0);

  console.log('\n===== REVENUE =====');
  for (const l of rev) console.log('  ', l.chart_of_accounts.account_number, (l.chart_of_accounts.account_name || '').slice(0, 44).padEnd(45), $(l.annual_amount_cents));
  console.log('   TOTAL REVENUE'.padEnd(52), $(sum(rev)));
  console.log('\n===== EXPENSES =====');
  for (const l of exp) console.log('  ', l.chart_of_accounts.account_number, (l.chart_of_accounts.account_name || '').slice(0, 44).padEnd(45), $(l.annual_amount_cents));
  console.log('   TOTAL EXPENSE'.padEnd(52), $(sum(exp)));
  console.log('\n   NET (revenue - expense):', $(sum(rev) - sum(exp)), '| lines:', lines.length);

  // run-rate
  try {
    const bva = await budgetVsActual({ community_id: CG, period_end: new Date().toISOString().slice(0, 10) });
    const flags = (bva.rows || []).filter((r) => r.account_type === 'expense' && Math.abs(Number(r.ytd_budget_cents || 0)) > 0 && Math.abs((Number(r.ytd_actual_cents) - Number(r.ytd_budget_cents)) / Number(r.ytd_budget_cents)) >= 0.15);
    console.log('\n===== EXPENSE LINES TRACKING OFF (>=15% YTD) =====');
    for (const r of flags.sort((a, b) => Math.abs((b.ytd_actual_cents - b.ytd_budget_cents) / b.ytd_budget_cents) - Math.abs((a.ytd_actual_cents - a.ytd_budget_cents) / a.ytd_budget_cents))) {
      const dev = Math.round((Number(r.ytd_actual_cents) - Number(r.ytd_budget_cents)) / Number(r.ytd_budget_cents) * 100);
      console.log('  ', r.account_number, (r.account_name || '').slice(0, 40).padEnd(41), (dev > 0 ? '+' : '') + dev + '% YTD', '| actual', $(r.ytd_actual_cents), 'vs budget', $(r.ytd_budget_cents));
    }
  } catch (e) { console.log('run-rate unavailable:', e.message); }
})();
