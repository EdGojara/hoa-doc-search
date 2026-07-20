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
        id, account_id, fund_id, debit_cents, credit_cents, property_id, vendor_id, bank_account_id,
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

// Fund-as-dimension grouping: lines by (account, FUND), where the fund is the
// line's fund_id, falling back to the account's fund when the line lacks one.
// For single-fund accounts this produces exactly one group per account (=
// identical to sumLinesPerAccount); a multi-fund account (one 3050 segmented by
// fund) splits into a group per fund. accountFundById: account_id -> fund_id.
function sumLinesPerAccountFund(lines, accountFundById) {
  const byAcct = new Map(); // account_id -> Map(fundId -> {debit, credit})
  for (const ln of lines) {
    const fundId = ln.fund_id || (accountFundById && accountFundById.get(ln.account_id)) || '__nofund__';
    let m = byAcct.get(ln.account_id);
    if (!m) { m = new Map(); byAcct.set(ln.account_id, m); }
    const acc = m.get(fundId) || { debit: 0, credit: 0 };
    acc.debit += Number(ln.debit_cents) || 0;
    acc.credit += Number(ln.credit_cents) || 0;
    m.set(fundId, acc);
  }
  return byAcct;
}

// All active funds for the community → Map(fund_id -> {fund_code, fund_name}).
// The report columns. Used to label line-fund groups (a multi-fund account's
// non-home-fund lines can't get their code from the account itself).
async function fetchFunds(community_id) {
  const { data } = await supabase
    .from('account_funds').select('id, fund_code, fund_name')
    .eq('community_id', community_id).eq('is_active', true);
  const m = new Map();
  (data || []).forEach((f) => m.set(f.id, { fund_code: f.fund_code, fund_name: f.fund_name }));
  return m;
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

  const [coa, lines, fundsMeta] = await Promise.all([
    fetchCoA(community_id),
    fetchLinesForCommunity({ community_id, to_date: as_of_date }),
    fetchFunds(community_id),
  ]);
  const accountById = new Map(coa.map((a) => [a.id, a]));
  const accountFundById = new Map(coa.map((a) => [a.id, a.fund_id]));
  // Resolve a line-fund id to its code/name (the report column it belongs to),
  // falling back to the account's own fund label if the fund isn't in the map.
  const fundMetaOf = (fundId, acct) => fundsMeta.get(fundId)
    || { fund_code: acct?.account_funds?.fund_code || null, fund_name: acct?.account_funds?.fund_name || null };

  const balances = sumLinesPerAccountFund(lines, accountFundById); // account_id -> Map(fundId -> {debit,credit})

  // Current-year net income to roll into equity (revenue − expense Jan 1 → as_of),
  // computed per (account, FUND) so each fund's net income lands in its column.
  const year = Number(as_of_date.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const ytdLines = await fetchLinesForCommunity({ community_id, from_date: yearStart, to_date: as_of_date });
  const ytdByAcctFund = sumLinesPerAccountFund(ytdLines, accountFundById);
  let currentYearNetIncome = 0;
  const niByFund = {};
  for (const [acctId, fundSums] of ytdByAcctFund.entries()) {
    const a = accountById.get(acctId);
    if (!a || !['revenue', 'expense'].includes(a.account_type)) continue;
    for (const [fundId, sums] of fundSums.entries()) {
      const fc = fundMetaOf(fundId, a).fund_code || fundId;
      const delta = a.account_type === 'revenue' ? (sums.credit - sums.debit) : -(sums.debit - sums.credit);
      currentYearNetIncome += delta;
      niByFund[fc] = (niByFund[fc] || 0) + delta;
    }
  }

  // Build the report — one row per (account, fund). Single-fund accounts emit
  // exactly one row (identical to the old account-based output); a multi-fund
  // account (one 3050 segmented by fund) splits into a row per fund.
  const sections = { assets: [], liabilities: [], equity: [] };
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;

  for (const a of coa) {
    if (a.is_summary) continue;
    if (!['asset', 'liability', 'equity'].includes(a.account_type)) continue;
    const fundSums = balances.get(a.id);
    if (!fundSums) continue;
    for (const [fundId, sums] of fundSums.entries()) {
      if (fund_id && fundId !== fund_id) continue;
      const bal = sectionBalance(a.account_type, sums.debit, sums.credit);
      if (bal === 0) continue;
      const fm = fundMetaOf(fundId, a);
      const row = {
        account_id: a.id,
        account_number: a.account_number,
        account_name: a.account_name,
        account_subtype: a.account_subtype,
        group: _bsGroup(a.account_type, a.account_name),
        fund_id: fundId,
        fund_code: fm.fund_code,
        fund_name: fm.fund_name,
        balance_cents: bal,
      };
      if (a.account_type === 'asset') { sections.assets.push(row); totalAssets += bal; }
      else if (a.account_type === 'liability') { sections.liabilities.push(row); totalLiabilities += bal; }
      else { sections.equity.push(row); totalEquity += bal; }
    }
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
  // Columns = the community's funds present in the chart (labels from fundsMeta).
  const fundIdsInChart = [...new Set(coa.filter((a) => a.fund_id).map((a) => a.fund_id))];
  const funds = fundIdsInChart
    .map((id) => { const m = fundsMeta.get(id) || {}; return { fund_id: id, fund_code: m.fund_code || id, fund_name: m.fund_name || null }; })
    .sort((x, y) => String(x.fund_code).localeCompare(String(y.fund_code)));
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

  const [coa, periodLines, ytdLines, fundsMeta] = await Promise.all([
    fetchCoA(community_id),
    fetchLinesForCommunity({ community_id, from_date: period_start, to_date: period_end }),
    fetchLinesForCommunity({ community_id, from_date: yearStart, to_date: period_end }),
    fetchFunds(community_id),
  ]);
  const accountById = new Map(coa.map((a) => [a.id, a]));
  const accountFundById = new Map(coa.map((a) => [a.id, a.fund_id]));
  const fundMetaOf = (fundId, acct) => fundsMeta.get(fundId)
    || { fund_code: acct?.account_funds?.fund_code || null, fund_name: acct?.account_funds?.fund_name || null };
  const periodByAF = sumLinesPerAccountFund(periodLines, accountFundById);
  const ytdByAF = sumLinesPerAccountFund(ytdLines, accountFundById);

  const revenue = [];
  const expenses = [];
  let totalRevPeriod = 0, totalExpPeriod = 0;
  let totalRevYtd = 0, totalExpYtd = 0;

  for (const a of coa) {
    if (a.is_summary) continue;
    if (!['revenue', 'expense'].includes(a.account_type)) continue;
    const pMap = periodByAF.get(a.id) || new Map();
    const yMap = ytdByAF.get(a.id) || new Map();
    for (const fundId of new Set([...pMap.keys(), ...yMap.keys()])) {
      if (fund_id && fundId !== fund_id) continue;
      const pS = pMap.get(fundId) || { debit: 0, credit: 0 };
      const yS = yMap.get(fundId) || { debit: 0, credit: 0 };
      const pBal = naturalBalance(a, pS.debit, pS.credit);
      const ytdBal = naturalBalance(a, yS.debit, yS.credit);
      if (pBal === 0 && ytdBal === 0) continue;
      const fm = fundMetaOf(fundId, a);
      const row = {
        account_id: a.id,
        account_number: a.account_number,
        account_name: a.account_name,
        account_subtype: a.account_subtype,
        group: _plGroup(a.account_type, a.account_name),
        fund_id: fundId,
        fund_code: fm.fund_code,
        period_amount_cents: pBal,
        ytd_amount_cents: ytdBal,
      };
      if (a.account_type === 'revenue') { revenue.push(row); totalRevPeriod += pBal; totalRevYtd += ytdBal; }
      else { expenses.push(row); totalExpPeriod += pBal; totalExpYtd += ytdBal; }
    }
  }

  // ---- Fund columns (multi-column presentation) ----
  const fundIdsInChart = [...new Set(coa.filter((a) => a.fund_id).map((a) => a.fund_id))];
  const funds = fundIdsInChart
    .map((id) => { const m = fundsMeta.get(id) || {}; return { fund_id: id, fund_code: m.fund_code || id, fund_name: m.fund_name || null }; })
    .sort((x, y) => String(x.fund_code).localeCompare(String(y.fund_code)));
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
      group: _plGroup(a.account_type, a.account_name),
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

// ---------------------------------------------------------------------------
// Rolling N-month income statement (Ed 2026-07-19, "for my own review"). Every
// P&L account laid out as monthly columns (trailing N months ending end_date),
// with per-month revenue/expense/net totals — the Vantaca "Summary Statement"
// shape. Its whole point is spotting MONTHS THAT READ ZERO (a data gap / a
// month that didn't post). A migrated community reads zero for every month
// BEFORE its cutover (trustEd's GL starts at the opening) — that's the
// migration boundary, not a bug; a zero month INSIDE the coverage window is the
// real gap to chase.
// ---------------------------------------------------------------------------
function _monthKeys(endYm, n) {
  const [y, m] = String(endYm).slice(0, 7).split('-').map(Number);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    let mm = m - i, yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    keys.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return keys;
}

// Classify a P&L account into a reporting category by its name (the chart's
// account_subtype is only 'operating_revenue'/'operating_expense', too coarse).
// Matches the Vantaca "Statement of Revenues and Expenses" buckets. Order of
// the groups is fixed below.
function _plGroup(account_type, name) {
  const n = String(name || '').toLowerCase();
  if (account_type === 'revenue') return /interest\s*-/.test(n) ? 'Interest Income' : 'Assessments & Fees';
  if (/water|electric|\bgas\b|sewer|trash|refuse|utilit/.test(n)) return 'Utilities';
  if (/pool|splash|\bspa\b/.test(n)) return 'Pool Expenses';
  if (/landscap|irrigation|lawn|\btree|grounds|fountain|lake|mowing|mulch/.test(n)) return 'Landscaping';
  if (/bank|website|office|telephone|internet|postage|admin|manage|\bmgmt\b|legal|attorney|account|audit|\btax|permit|license|filing|insurance/.test(n)) return 'Administrative';
  return 'Other Expenses';
}
const _REV_ORDER = ['Assessments & Fees', 'Interest Income'];
const _EXP_ORDER = ['Landscaping', 'Pool Expenses', 'Utilities', 'Other Expenses', 'Administrative'];

// Balance-sheet reporting group by account name (subtype is only current_asset
// / current_liability / fund_balance — too coarse). Matches the Vantaca
// balance sheet's sub-sections.
function _bsGroup(account_type, name) {
  const n = String(name || '').toLowerCase();
  if (account_type === 'asset') {
    if (/\bdue (from|to)\b|prepaid/.test(n)) return 'Other Assets';   // interfund / prepaids first
    if (/cash|checking|savings account|money market|operating (cash|account)|\bics\b|\bbank\b/.test(n)) return 'Cash';
    if (/receivable|allowance for doubtful/.test(n)) return 'Accounts Receivable';
    return 'Other Assets';
  }
  if (account_type === 'liability') {
    if (/unearned|deferred/.test(n)) return 'Deferred Revenue';
    if (/prepaid|due to/.test(n)) return 'Prepaids & Other Liabilities';
    return 'Current Liabilities';
  }
  return 'Fund Balances';   // equity
}
const _BS_ASSET_ORDER = ['Cash', 'Accounts Receivable', 'Other Assets'];
const _BS_LIAB_ORDER = ['Current Liabilities', 'Deferred Revenue', 'Prepaids & Other Liabilities'];

// Group an array of {group, ...} rows into ordered {group, rows, subtotal_cents}
// by a chosen amount field. Shared by the statement renderers.
function groupRows(rows, order, amountKey) {
  const buckets = new Map();
  for (const r of rows) { const g = r.group || 'Other'; if (!buckets.has(g)) buckets.set(g, []); buckets.get(g).push(r); }
  const known = (order || []).filter((g) => buckets.has(g));
  const extra = [...buckets.keys()].filter((g) => !(order || []).includes(g)).sort();
  return [...known, ...extra].map((g) => {
    const grpRows = buckets.get(g);
    return { group: g, rows: grpRows, subtotal_cents: grpRows.reduce((s, r) => s + Number(r[amountKey] || 0), 0) };
  });
}

async function rollingIncomeStatement({ community_id, end_date, months = 12 }) {
  const keys = _monthKeys(end_date, months);
  const from_date = keys[0] + '-01';
  const [lines, coa] = await Promise.all([
    fetchLinesForCommunity({ community_id, from_date, to_date: end_date }),
    fetchCoA(community_id),
  ]);
  const acctById = new Map(coa.map((a) => [a.id, a]));
  const monthSet = new Set(keys);
  const rev = new Map(), exp = new Map();
  const monthTotals = Object.fromEntries(keys.map((k) => [k, { revenue: 0, expense: 0 }]));
  for (const ln of lines) {
    const a = acctById.get(ln.account_id);
    if (!a || (a.account_type !== 'revenue' && a.account_type !== 'expense')) continue;
    const ym = String(ln.journal_entries.posting_date).slice(0, 7);
    if (!monthSet.has(ym)) continue;
    const d = Number(ln.debit_cents) || 0, c = Number(ln.credit_cents) || 0;
    const amt = a.account_type === 'revenue' ? (c - d) : (d - c);   // natural (positive)
    const map = a.account_type === 'revenue' ? rev : exp;
    let row = map.get(a.account_number);
    if (!row) { row = { account_number: a.account_number, account_name: a.account_name, group: _plGroup(a.account_type, a.account_name), by_month: {}, total_cents: 0 }; map.set(a.account_number, row); }
    row.by_month[ym] = (row.by_month[ym] || 0) + amt;
    row.total_cents += amt;
    monthTotals[ym][a.account_type] += amt;
  }
  const byNum = (a, b) => String(a.account_number).localeCompare(String(b.account_number));
  // Organize accounts into ordered groups, each with a per-month subtotal.
  const groupBy = (rows, order) => {
    const buckets = new Map();
    for (const r of rows) { if (!buckets.has(r.group)) buckets.set(r.group, []); buckets.get(r.group).push(r); }
    const known = order.filter((g) => buckets.has(g));
    const extra = [...buckets.keys()].filter((g) => !order.includes(g)).sort();
    return [...known, ...extra].map((g) => {
      const accounts = buckets.get(g).sort(byNum);
      const subtotal_by_month = {}; let subtotal_total = 0;
      for (const a of accounts) { for (const [m, v] of Object.entries(a.by_month)) subtotal_by_month[m] = (subtotal_by_month[m] || 0) + v; subtotal_total += a.total_cents; }
      return { group: g, accounts, subtotal_by_month, subtotal_total };
    });
  };
  const monthly = keys.map((k) => ({ month: k, revenue_cents: monthTotals[k].revenue, expense_cents: monthTotals[k].expense, net_cents: monthTotals[k].revenue - monthTotals[k].expense }));
  return {
    community_id, months: keys, from_date, to_date: end_date,
    revenue_groups: groupBy([...rev.values()], _REV_ORDER),
    expense_groups: groupBy([...exp.values()], _EXP_ORDER),
    monthly,
    zero_months: monthly.filter((m) => m.revenue_cents === 0 && m.expense_cents === 0).map((m) => m.month),
  };
}

// ---------------------------------------------------------------------------
// Printed income statement — ONE fund at a time (Operating, then Reserve, then
// Savings / Adopt-A-School), category-grouped, with Current-Period AND YTD
// budget-vs-actual (Ed's print layout, 2026-07-20). Wraps budgetVsActual and
// pivots its per-account rows into per-fund → revenue/expense → category groups.
// ---------------------------------------------------------------------------
const _FUND_ORDER = ['OPR', 'RES', 'SAV', 'ADO'];
const _AMT_KEYS = ['mtd_actual_cents', 'mtd_budget_cents', 'mtd_variance_cents', 'ytd_actual_cents', 'ytd_budget_cents', 'ytd_variance_cents'];
const _zeroTotals = () => Object.fromEntries(_AMT_KEYS.map((k) => [k, 0]));
function _sumInto(dst, row) { for (const k of _AMT_KEYS) dst[k] += Number(row[k] || 0); }

async function perFundIncomeStatement({ community_id, period_end }) {
  const bva = await budgetVsActual({ community_id, period_end });
  // fund metadata for ordering + names
  const { data: funds } = await supabase.from('account_funds')
    .select('fund_code, fund_name, display_order').eq('community_id', community_id);
  const fundName = Object.fromEntries((funds || []).map((f) => [f.fund_code, f.fund_name]));
  const order = (funds || []).slice().sort((a, b) => (a.display_order || 99) - (b.display_order || 99)).map((f) => f.fund_code);
  const byFund = new Map();
  for (const r of bva.rows) {
    const fc = r.fund_code || 'OPR';
    if (!byFund.has(fc)) byFund.set(fc, { revenue: [], expense: [] });
    byFund.get(fc)[r.account_type === 'revenue' ? 'revenue' : 'expense'].push(r);
  }
  const fundCodes = [..._FUND_ORDER.filter((f) => byFund.has(f)), ...[...byFund.keys()].filter((f) => !_FUND_ORDER.includes(f))]
    .filter((f, i, a) => a.indexOf(f) === i);
  // honor per-community display_order where present, else the default fund order
  if (order.length) fundCodes.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));

  const groupWithTotals = (rows, ord) => groupRows(rows, ord, 'ytd_actual_cents').map((g) => {
    const totals = _zeroTotals(); for (const r of g.rows) _sumInto(totals, r);
    return { group: g.group, rows: g.rows, totals };
  });
  const fundsOut = fundCodes.map((fc) => {
    const { revenue, expense } = byFund.get(fc);
    const revTotals = _zeroTotals(); revenue.forEach((r) => _sumInto(revTotals, r));
    const expTotals = _zeroTotals(); expense.forEach((r) => _sumInto(expTotals, r));
    const net = _zeroTotals(); for (const k of _AMT_KEYS) net[k] = revTotals[k] - expTotals[k];
    return {
      fund_code: fc, fund_name: fundName[fc] || fc,
      revenue_groups: groupWithTotals(revenue, _REV_ORDER),
      expense_groups: groupWithTotals(expense, _EXP_ORDER),
      revenue_totals: revTotals, expense_totals: expTotals, net_totals: net,
    };
  });
  return { community_id, period_end, period_start: bva.period_start, amount_keys: _AMT_KEYS, funds: fundsOut };
}

module.exports = {
  balanceSheet, incomeStatement, equityStatement, budgetVsActual, rollingIncomeStatement, perFundIncomeStatement,
  groupRows, _BS_ASSET_ORDER, _BS_LIAB_ORDER, _REV_ORDER, _EXP_ORDER,
};
