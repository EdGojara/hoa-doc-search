// ============================================================================
// lib/accounting/financial_statements.js — BS / IS / Equity / BvA reports
// ----------------------------------------------------------------------------
// Pure queries against the GL (journal_entries + journal_entry_lines).
// Period-bounded sums; partitioned by fund + account_type for HOA fund
// accounting (Operating + Reserve maintain separate financial statements).
//
// All money values are cents (BIGINT). Caller formats for display.
//
// THE FOUR REPORTS:
//
//   balanceSheet({community_id, as_of_date, fund_id?})
//     → assets / liabilities / equity, organized per-fund + consolidated.
//
//   incomeStatement({community_id, period_start, period_end, fund_id?})
//     → revenue / expenses / net income for the period. YTD figures included.
//
//   equityStatement({community_id, period_start, period_end})
//     → beginning fund balance + period net income + transfers = ending FB.
//
//   budgetVsActual({community_id, period_end, fund_id?})
//     → for each budgeted account: budget / actual / variance, MTD + YTD.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fetch all journal_entry_lines for community within (optional) date bounds.
// Uses paginated fetch — safe at scale per CLAUDE.md scar "Supabase 1000-row
// silent truncation."
async function fetchLinesForCommunity({ community_id, from_date, to_date }) {
  const all = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from('journal_entry_lines')
      .select(`
        id, account_id, debit_cents, credit_cents, property_id, vendor_id, bank_account_id,
        journal_entries!inner ( id, community_id, posting_date, status )
      `)
      .eq('journal_entries.community_id', community_id)
      .eq('journal_entries.status', 'posted')
      .range(from, from + pageSize - 1);
    if (from_date) q = q.gte('journal_entries.posting_date', from_date);
    if (to_date) q = q.lte('journal_entries.posting_date', to_date);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
    if (all.length > 200000) break; // hard safety cap
  }
  return all;
}

async function fetchCoA(community_id) {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select(`
      id, account_number, account_name, account_type, account_subtype,
      normal_balance, parent_account_id, is_summary, is_active, fund_id,
      account_funds ( fund_code, fund_name, fund_type )
    `)
    .eq('community_id', community_id)
    .eq('is_active', true)
    .order('account_number')
    .limit(2000);
  if (error) throw error;
  return data || [];
}

// Compute account balance (debits - credits) from a set of lines.
function sumLinesPerAccount(lines) {
  const byAccount = new Map();
  for (const ln of lines) {
    const acc = byAccount.get(ln.account_id) || { debit: 0, credit: 0 };
    acc.debit += Number(ln.debit_cents) || 0;
    acc.credit += Number(ln.credit_cents) || 0;
    byAccount.set(ln.account_id, acc);
  }
  return byAccount;
}

// Sign the balance so it displays in the natural direction:
// - debit-normal accounts (assets, expenses): positive when debit > credit
// - credit-normal accounts (liabilities, equity, revenue): positive when credit > debit
function naturalBalance(account, debit, credit) {
  if (account.normal_balance === 'debit') return debit - credit;
  return credit - debit;
}

// Sign a balance for its BALANCE-SHEET SECTION, not its own normal_balance.
// Assets present debit-positive; Liabilities/Equity present credit-positive.
// This is what makes a contra account net correctly: a contra-asset like
// "Allowance for Doubtful Accounts" (an asset that carries a credit balance)
// comes out NEGATIVE here and reduces total assets, instead of inflating them.
// Using the account's own normal_balance here was the bug that put the balance
// sheet out by 2× the allowance.
function sectionBalance(accountType, debit, credit) {
  return accountType === 'asset' ? debit - credit : credit - debit;
}

// ---------------------------------------------------------------------------
// BALANCE SHEET
// ---------------------------------------------------------------------------
async function balanceSheet({ community_id, as_of_date, fund_id }) {
  if (!community_id || !as_of_date) {
    throw Object.assign(new Error('community_id_and_as_of_date_required'), { code: 'invalid_input' });
  }

  const [coa, lines] = await Promise.all([
    fetchCoA(community_id),
    fetchLinesForCommunity({ community_id, to_date: as_of_date }),
  ]);
  const accountById = new Map(coa.map((a) => [a.id, a]));
  const balances = sumLinesPerAccount(lines);

  // Compute current-year net income to roll into equity
  // (revenue - expense between Jan 1 of as_of_date's year and as_of_date)
  const year = Number(as_of_date.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const ytdLines = await fetchLinesForCommunity({
    community_id, from_date: yearStart, to_date: as_of_date,
  });
  const ytdByAccount = sumLinesPerAccount(ytdLines);
  let currentYearNetIncome = 0;
  for (const [acctId, sums] of ytdByAccount.entries()) {
    const a = accountById.get(acctId);
    if (!a) continue;
    if (a.account_type === 'revenue') currentYearNetIncome += sums.credit - sums.debit;
    if (a.account_type === 'expense') currentYearNetIncome -= sums.debit - sums.credit;
  }

  // Build the report — partition by fund + account_type
  const sections = {
    assets: [],
    liabilities: [],
    equity: [],
  };
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;

  for (const a of coa) {
    if (a.is_summary) continue;
    if (fund_id && a.fund_id !== fund_id) continue;
    if (!['asset', 'liability', 'equity'].includes(a.account_type)) continue;
    const sums = balances.get(a.id) || { debit: 0, credit: 0 };
    const bal = sectionBalance(a.account_type, sums.debit, sums.credit);
    if (bal === 0) continue;
    const row = {
      account_id: a.id,
      account_number: a.account_number,
      account_name: a.account_name,
      account_subtype: a.account_subtype,
      fund_id: a.fund_id,
      fund_code: a.account_funds?.fund_code || null,
      fund_name: a.account_funds?.fund_name || null,
      balance_cents: bal,
    };
    if (a.account_type === 'asset') { sections.assets.push(row); totalAssets += bal; }
    if (a.account_type === 'liability') { sections.liabilities.push(row); totalLiabilities += bal; }
    if (a.account_type === 'equity') { sections.equity.push(row); totalEquity += bal; }
  }

  // Current-year net income, SPLIT BY FUND (each fund's revenue − expense), so
  // the multi-column view shows each fund's net income in its own column.
  const niByFund = {};
  for (const [acctId, sums] of ytdByAccount.entries()) {
    const a = accountById.get(acctId);
    if (!a || !a.fund_id) continue;
    const fc = a.account_funds?.fund_code || a.fund_id;
    if (a.account_type === 'revenue') niByFund[fc] = (niByFund[fc] || 0) + (sums.credit - sums.debit);
    if (a.account_type === 'expense') niByFund[fc] = (niByFund[fc] || 0) - (sums.debit - sums.credit);
  }

  // Add the current-year net income to equity ("Current Year Income (unclosed)")
  totalEquity += currentYearNetIncome;
  sections.equity.push({
    account_id: null,
    account_number: 'Net Income',
    account_name: 'Current Year Net Income (unclosed)',
    account_subtype: 'closing',
    fund_id: null,
    fund_code: null,
    fund_name: null,
    balance_cents: currentYearNetIncome,
    by_fund: niByFund,   // per-fund split for the column view
    is_computed: true,
  });

  // ---- Fund columns (multi-column presentation, like the Vantaca report) ----
  // Columns = the community's funds that have accounts. Each account row already
  // carries fund_code; here we add the column list + per-fund subtotals so the
  // UI can render Operating | Reserve | Savings | Total. Net income is folded
  // into each fund's equity column.
  const fundMap = new Map();
  for (const a of coa) {
    if (!a.fund_id || fundMap.has(a.fund_id)) continue;
    fundMap.set(a.fund_id, {
      fund_id: a.fund_id,
      fund_code: a.account_funds?.fund_code || a.fund_id,
      fund_name: a.account_funds?.fund_name || null,
    });
  }
  const funds = [...fundMap.values()].sort((x, y) => String(x.fund_code).localeCompare(String(y.fund_code)));
  const fund_totals = {};
  for (const f of funds) fund_totals[f.fund_code] = { assets_cents: 0, liabilities_cents: 0, equity_cents: 0, net_income_cents: niByFund[f.fund_code] || 0 };
  for (const r of sections.assets)      if (r.fund_code && fund_totals[r.fund_code]) fund_totals[r.fund_code].assets_cents += r.balance_cents;
  for (const r of sections.liabilities) if (r.fund_code && fund_totals[r.fund_code]) fund_totals[r.fund_code].liabilities_cents += r.balance_cents;
  for (const r of sections.equity)      if (r.fund_code && fund_totals[r.fund_code] && !r.is_computed) fund_totals[r.fund_code].equity_cents += r.balance_cents;
  for (const f of funds) fund_totals[f.fund_code].equity_cents += fund_totals[f.fund_code].net_income_cents; // net income → equity column

  return {
    as_of_date,
    sections,
    funds,
    fund_totals,
    totals: {
      assets_cents: totalAssets,
      liabilities_cents: totalLiabilities,
      equity_cents: totalEquity,
      total_liabilities_and_equity_cents: totalLiabilities + totalEquity,
      balanced: totalAssets === (totalLiabilities + totalEquity),
      difference_cents: totalAssets - (totalLiabilities + totalEquity),
    },
  };
}

// ---------------------------------------------------------------------------
// INCOME STATEMENT
// ---------------------------------------------------------------------------
async function incomeStatement({ community_id, period_start, period_end, fund_id }) {
  if (!community_id || !period_start || !period_end) {
    throw Object.assign(new Error('community_id_period_start_period_end_required'), { code: 'invalid_input' });
  }

  const year = Number(period_end.slice(0, 4));
  const yearStart = `${year}-01-01`;

  const [coa, periodLines, ytdLines] = await Promise.all([
    fetchCoA(community_id),
    fetchLinesForCommunity({ community_id, from_date: period_start, to_date: period_end }),
    fetchLinesForCommunity({ community_id, from_date: yearStart, to_date: period_end }),
  ]);
  const accountById = new Map(coa.map((a) => [a.id, a]));
  const periodBalances = sumLinesPerAccount(periodLines);
  const ytdBalances = sumLinesPerAccount(ytdLines);

  const revenue = [];
  const expenses = [];
  let totalRevPeriod = 0, totalExpPeriod = 0;
  let totalRevYtd = 0, totalExpYtd = 0;

  for (const a of coa) {
    if (a.is_summary) continue;
    if (fund_id && a.fund_id !== fund_id) continue;
    if (!['revenue', 'expense'].includes(a.account_type)) continue;
    const pSums = periodBalances.get(a.id) || { debit: 0, credit: 0 };
    const ytdSums = ytdBalances.get(a.id) || { debit: 0, credit: 0 };
    const pBal = naturalBalance(a, pSums.debit, pSums.credit);
    const ytdBal = naturalBalance(a, ytdSums.debit, ytdSums.credit);
    if (pBal === 0 && ytdBal === 0) continue;
    const row = {
      account_id: a.id,
      account_number: a.account_number,
      account_name: a.account_name,
      account_subtype: a.account_subtype,
      fund_id: a.fund_id,
      fund_code: a.account_funds?.fund_code || null,
      period_amount_cents: pBal,
      ytd_amount_cents: ytdBal,
    };
    if (a.account_type === 'revenue') {
      revenue.push(row);
      totalRevPeriod += pBal;
      totalRevYtd += ytdBal;
    } else {
      expenses.push(row);
      totalExpPeriod += pBal;
      totalExpYtd += ytdBal;
    }
  }

  // ---- Fund columns (multi-column presentation) ----
  const fundMap = new Map();
  for (const a of coa) {
    if (!a.fund_id || fundMap.has(a.fund_id)) continue;
    fundMap.set(a.fund_id, { fund_id: a.fund_id, fund_code: a.account_funds?.fund_code || a.fund_id, fund_name: a.account_funds?.fund_name || null });
  }
  const funds = [...fundMap.values()].sort((x, y) => String(x.fund_code).localeCompare(String(y.fund_code)));
  const fund_totals = {};
  for (const f of funds) fund_totals[f.fund_code] = { period: { revenue_cents: 0, expenses_cents: 0, net_income_cents: 0 }, ytd: { revenue_cents: 0, expenses_cents: 0, net_income_cents: 0 } };
  for (const r of revenue)  if (r.fund_code && fund_totals[r.fund_code]) { fund_totals[r.fund_code].period.revenue_cents += r.period_amount_cents; fund_totals[r.fund_code].ytd.revenue_cents += r.ytd_amount_cents; }
  for (const r of expenses) if (r.fund_code && fund_totals[r.fund_code]) { fund_totals[r.fund_code].period.expenses_cents += r.period_amount_cents; fund_totals[r.fund_code].ytd.expenses_cents += r.ytd_amount_cents; }
  for (const f of funds) {
    const t = fund_totals[f.fund_code];
    t.period.net_income_cents = t.period.revenue_cents - t.period.expenses_cents;
    t.ytd.net_income_cents = t.ytd.revenue_cents - t.ytd.expenses_cents;
  }

  return {
    period_start, period_end,
    sections: { revenue, expenses },
    funds,
    fund_totals,
    totals: {
      period: {
        revenue_cents: totalRevPeriod,
        expenses_cents: totalExpPeriod,
        net_income_cents: totalRevPeriod - totalExpPeriod,
      },
      ytd: {
        revenue_cents: totalRevYtd,
        expenses_cents: totalExpYtd,
        net_income_cents: totalRevYtd - totalExpYtd,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// STATEMENT OF EQUITY / FUND BALANCE
// ---------------------------------------------------------------------------
async function equityStatement({ community_id, period_start, period_end }) {
  if (!community_id || !period_start || !period_end) {
    throw Object.assign(new Error('community_id_period_start_period_end_required'), { code: 'invalid_input' });
  }

  const dayBefore = new Date(period_start + 'T12:00:00Z');
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const asOfBeginning = dayBefore.toISOString().slice(0, 10);

  // Balance sheets at beginning + end give us equity at each point.
  const [bsBegin, bsEnd, periodIS] = await Promise.all([
    balanceSheet({ community_id, as_of_date: asOfBeginning }),
    balanceSheet({ community_id, as_of_date: period_end }),
    incomeStatement({ community_id, period_start, period_end }),
  ]);

  // Equity per fund
  const collectByFund = (equitySection) => {
    const byFund = {};
    for (const row of equitySection) {
      const key = row.fund_code || 'consolidated';
      if (!byFund[key]) byFund[key] = { fund_code: row.fund_code, fund_name: row.fund_name, total: 0, rows: [] };
      byFund[key].total += row.balance_cents;
      byFund[key].rows.push(row);
    }
    return byFund;
  };

  return {
    period_start, period_end,
    beginning: {
      as_of_date: asOfBeginning,
      total_equity_cents: bsBegin.totals.equity_cents,
      by_fund: collectByFund(bsBegin.sections.equity),
    },
    period_net_income_cents: periodIS.totals.period.net_income_cents,
    ending: {
      as_of_date: period_end,
      total_equity_cents: bsEnd.totals.equity_cents,
      by_fund: collectByFund(bsEnd.sections.equity),
    },
  };
}

// ---------------------------------------------------------------------------
// BUDGET vs ACTUAL
// ---------------------------------------------------------------------------
async function budgetVsActual({ community_id, period_end, fund_id }) {
  if (!community_id || !period_end) {
    throw Object.assign(new Error('community_id_and_period_end_required'), { code: 'invalid_input' });
  }
  const year = Number(period_end.slice(0, 4));
  const month = Number(period_end.slice(5, 7));  // 1-12
  const yearStart = `${year}-01-01`;

  // Fetch budget
  const { data: budget } = await supabase
    .from('community_budgets')
    .select('id, fiscal_year, status')
    .eq('community_id', community_id)
    .eq('fiscal_year', year)
    .in('status', ['approved', 'active'])
    .maybeSingle();

  let budgetByAccount = new Map();
  if (budget) {
    const { data: lines } = await supabase
      .from('budget_line_items')
      .select('account_id, annual_amount_cents, monthly_amounts_cents')
      .eq('budget_id', budget.id);
    for (const l of lines || []) {
      budgetByAccount.set(l.account_id, l);
    }
  }

  // Period-end IS gives us actual MTD + YTD
  // We need MTD specifically — period_start = first day of the period_end's month
  const periodStartMonth = `${period_end.slice(0, 7)}-01`;
  const [coa, mtdLines, ytdLines] = await Promise.all([
    fetchCoA(community_id),
    fetchLinesForCommunity({ community_id, from_date: periodStartMonth, to_date: period_end }),
    fetchLinesForCommunity({ community_id, from_date: yearStart, to_date: period_end }),
  ]);
  const accountById = new Map(coa.map((a) => [a.id, a]));
  const mtdBalances = sumLinesPerAccount(mtdLines);
  const ytdBalances = sumLinesPerAccount(ytdLines);

  const rows = [];
  for (const a of coa) {
    if (a.is_summary) continue;
    if (fund_id && a.fund_id !== fund_id) continue;
    if (!['revenue', 'expense'].includes(a.account_type)) continue;
    const bdg = budgetByAccount.get(a.id);
    const monthlyBudget = bdg ? Number(bdg.monthly_amounts_cents?.[month - 1] || 0) : 0;
    const annualBudget = bdg ? Number(bdg.annual_amount_cents || 0) : 0;
    const ytdBudget = bdg ? (bdg.monthly_amounts_cents || []).slice(0, month).reduce((s, n) => s + Number(n || 0), 0) : 0;

    const mtdSums = mtdBalances.get(a.id) || { debit: 0, credit: 0 };
    const ytdSums = ytdBalances.get(a.id) || { debit: 0, credit: 0 };
    const mtdActual = naturalBalance(a, mtdSums.debit, mtdSums.credit);
    const ytdActual = naturalBalance(a, ytdSums.debit, ytdSums.credit);

    if (mtdActual === 0 && ytdActual === 0 && annualBudget === 0) continue;

    rows.push({
      account_id: a.id,
      account_number: a.account_number,
      account_name: a.account_name,
      account_type: a.account_type,
      fund_id: a.fund_id,
      fund_code: a.account_funds?.fund_code || null,
      annual_budget_cents: annualBudget,
      mtd_budget_cents: monthlyBudget,
      mtd_actual_cents: mtdActual,
      mtd_variance_cents: monthlyBudget - mtdActual,
      ytd_budget_cents: ytdBudget,
      ytd_actual_cents: ytdActual,
      ytd_variance_cents: ytdBudget - ytdActual,
    });
  }

  // Sort: revenue first, then expenses, then by account number
  rows.sort((a, b) => {
    if (a.account_type !== b.account_type) return a.account_type === 'revenue' ? -1 : 1;
    return a.account_number.localeCompare(b.account_number);
  });

  return {
    period_end,
    fiscal_year: year,
    has_budget: !!budget,
    rows,
  };
}

module.exports = { balanceSheet, incomeStatement, equityStatement, budgetVsActual };
