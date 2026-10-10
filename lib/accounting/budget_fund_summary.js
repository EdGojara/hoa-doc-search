// ============================================================================
// lib/accounting/budget_fund_summary.js  (Ed 2026-10-10)
// ----------------------------------------------------------------------------
// An approved budget summarized BY FUND, with the same fund definitions as the
// financial statements and the working forecast:
//   - a line's fund is the budget line's fund, else its account's fund
//     (lib/forecast/working_forecast_data.js);
//   - the Operating fund is the one fund whose fund_type is 'operating'; Reserve
//     and every other fund (e.g. Adopt-a-School) are reported separately and never
//     folded into Operating; a line with no fund stays in its own group;
//   - an interfund transfer is recognized ONLY by explicit account configuration
//     (account_subtype 'interfund_transfer' + from / to fund, migration 506; the
//     working forecast's transferConfig). It is neither revenue nor expense: the
//     from-fund shows it as a transfer out, the to-fund as a transfer in, so it is
//     never double-counted. An unconfigured negative revenue line is reported as a
//     candidate, not reclassified.
// PURE: integer cents in, integer cents out. ONE classification (classifyByFund) used by
// the board portal budget tile, Ask Amanda's budget context and the detailed budget view.
// ============================================================================

const { transferConfig } = require('../forecast/working_forecast_data');

const int = (n) => Math.round(Number(n) || 0);
const TYPE_ORDER = ['operating', 'reserve', 'special_assessment', 'capital_improvement', 'escrow', 'other', null, 'unassigned'];

/**
 * THE classification (one calculation for the tile, Ask Amanda and the detailed view).
 * rows:     [{ account_id, fund_id, ...measures }]   e.g. { annual_budget_cents, ytd_budget_cents, ytd_actual_cents }
 * accounts: [{ id, account_number, account_name, account_type, account_subtype, fund_id, interfund_from_fund_id, interfund_to_fund_id }]
 * funds:    [{ id, fund_code, fund_name, fund_type }]
 * measures: the measure keys to total; the FIRST is the budget measure that decides which side of a
 *           transfer a one-line budget records (a negative revenue line records the outgoing side).
 * A null measure value stays null-sticky in its totals (e.g. YTD actuals not available in trustEd).
 */
function classifyByFund({ rows = [], accounts = [], funds = [], measures = ['annual_budget_cents'], transferActuals = null }) {
  const A = new Map(accounts.map((a) => [a.id, a]));
  const F = new Map(funds.map((f) => [f.id, f]));
  const primary = measures[0];
  const zero = () => Object.fromEntries(measures.map((m) => [m, 0]));
  const add = (o, m, v) => { o[m] = o[m] === null || v === null || v === undefined ? (v === undefined ? o[m] : null) : o[m] + int(v); };
  const groups = new Map();
  const group = (fundId) => {
    const k = fundId && F.has(fundId) ? fundId : 'unassigned';
    if (!groups.has(k)) {
      const f = F.get(k);
      groups.set(k, { fund_id: f ? f.id : null, fund_code: f ? f.fund_code : null, fund_name: f ? f.fund_name || null : null, fund_type: f ? f.fund_type || null : 'unassigned',
        revenue: [], expense: [], transfers: [], rev: zero(), exp: zero(), tin: zero(), tout: zero() });
    }
    return groups.get(k);
  };
  const transfers = [], candidates = [], warnings = [];
  for (const r of rows) {
    const a = A.get(r.account_id);
    if (!a || !['revenue', 'expense'].includes(a.account_type)) continue;
    const isExp = a.account_type === 'expense';
    const label = `${a.account_number} ${a.account_name}`;
    const cfg = transferConfig(a, funds);
    if (cfg.transfer) {
      const t = cfg.transfer;
      const outgoingLeg = isExp || int(r[primary]) < 0;
      // The amount moving from -> to, positive, per measure (never revenue, never double-counted).
      const amt = Object.fromEntries(measures.map((m) => [m, r[m] === null || r[m] === undefined ? (r[m] === null ? null : 0) : (outgoingLeg ? (isExp ? int(r[m]) : -int(r[m])) : int(r[m]))]));
      // The ACTUAL transfer comes from what the books show (lib/accounting/transfer_activity.js),
      // never from the account's net balance alone: offsetting entries net to zero but are a
      // transfer, and an unreconcilable period has no amount (null), never an unsupported $0.
      const act = transferActuals && transferActuals[a.id];
      if (act && 'ytd_actual_cents' in amt) amt.ytd_actual_cents = act.amount_cents === null || act.amount_cents === undefined ? null : int(act.amount_cents);
      const from = group(t.from_fund_id), to = group(t.to_fund_id);
      for (const m of measures) { add(from.tout, m, amt[m]); add(to.tin, m, amt[m]); }
      const base = { account_id: a.id, account: label, account_number: a.account_number, account_name: a.account_name, from_fund_code: t.from_fund_code, from_fund_type: t.from_fund_type, to_fund_code: t.to_fund_code, to_fund_type: t.to_fund_type, recorded_leg: outgoingLeg ? 'outgoing' : 'incoming', ...amt,
        ...(act ? { actual_status: act.status, actual_status_label: act.status_label, actual_note: act.note } : {}) };
      transfers.push(base);
      from.transfers.push({ ...base, direction: 'out', label: t.to_fund_type === 'reserve' ? 'Planned reserve funding' : `Transfer to ${t.to_fund_code}` });
      to.transfers.push({ ...base, direction: 'in', label: `Transfer in from ${t.from_fund_code}` });
      continue;
    }
    if (cfg.transfer_config_error) warnings.push({ code: 'transfer_config_invalid', account: label, text: `${label}: ${cfg.transfer_config_error}; treated as an ordinary line.` });
    const g = group(r.fund_id || a.fund_id);
    if (isExp) { g.expense.push(r); for (const m of measures) add(g.exp, m, r[m]); }
    else {
      g.revenue.push(r); for (const m of measures) add(g.rev, m, r[m]);
      if (int(r[primary]) < 0) candidates.push({ account: label, fund_code: g.fund_code, amount_cents: int(r[primary]) });
    }
  }
  if (candidates.length) warnings.push({ code: 'negative_revenue_budget', text: `${candidates.map((c) => `${c.account} (${c.fund_code || 'no fund'})`).join('; ')}: a negative revenue budget usually records a transfer between funds but is not configured as one, so it is reported as budgeted in its fund.` });
  const sub = (x, y) => (x === null || y === null ? null : x - y);
  const out = [...groups.values()].map((g) => {
    const totals = Object.fromEntries(measures.map((m) => { const net = sub(g.rev[m], g.exp[m]);
      return [m, { revenue: g.rev[m], expense: g.exp[m], net_before_transfers: net, transfers_in: g.tin[m], transfers_out: g.tout[m], net_after_transfers: net === null || g.tin[m] === null || g.tout[m] === null ? null : net + g.tin[m] - g.tout[m] }]; }));
    const { rev, exp, tin, tout, ...meta } = g;
    return { ...meta, totals };
  }).sort((x, y) => (TYPE_ORDER.indexOf(x.fund_type) - TYPE_ORDER.indexOf(y.fund_type)) || String(x.fund_code).localeCompare(String(y.fund_code)));
  const ops = out.filter((g) => g.fund_type === 'operating');
  if (ops.length !== 1) warnings.push({ code: 'no_operating_fund', text: ops.length ? 'More than one operating fund; no single operating figure is shown.' : 'No operating fund identified; no operating figure is shown.' });
  const operating = ops.length === 1 ? ops[0] : null;
  // If an unconfigured transfer-like line sits IN the operating fund, the operating net already
  // includes it: it is labelled "as budgeted", never "before reserve funding".
  const netBasis = !operating ? null : candidates.some((c) => c.fund_code === operating.fund_code) ? 'as_budgeted_includes_unconfigured_transfer' : 'before_reserve_funding';
  return { funds: out, operating, operating_net_basis: netBasis, transfers, unconfigured_transfer_candidates: candidates, warnings };
}

/**
 * The approved budget by fund (tile + Ask Amanda): classifyByFund on the budget lines.
 * lines: [{ account_id, fund_id, annual_amount_cents }]
 */
function summarizeBudgetByFund({ lines = [], accounts = [], funds = [] }) {
  const c = classifyByFund({ rows: lines.map((l) => ({ account_id: l.account_id, fund_id: l.fund_id, annual_budget_cents: l.annual_amount_cents })), accounts, funds, measures: ['annual_budget_cents'] });
  const flat = (g) => { const t = g.totals.annual_budget_cents; const { totals, revenue, expense, transfers, ...meta } = g;
    return { ...meta, revenue_cents: t.revenue, expense_cents: t.expense, transfers_in_cents: t.transfers_in, transfers_out_cents: t.transfers_out, net_before_transfers_cents: t.net_before_transfers, net_after_transfers_cents: t.net_after_transfers }; };
  const out = c.funds.map(flat);
  const operating = c.operating ? out.find((g) => g.fund_id === c.operating.fund_id) : null;
  const transfers = c.transfers.map((t) => ({ account: t.account, from_fund_code: t.from_fund_code, from_fund_type: t.from_fund_type, to_fund_code: t.to_fund_code, to_fund_type: t.to_fund_type, amount_cents: t.annual_budget_cents }));
  const reserveFunding = operating ? transfers.filter((t) => t.from_fund_code === operating.fund_code && t.to_fund_type === 'reserve').reduce((s, t) => s + t.amount_cents, 0) : 0;
  return { funds: out, operating, operating_net_basis: c.operating_net_basis, transfers, reserve_funding_cents: reserveFunding, unconfigured_transfer_candidates: c.unconfigured_transfer_candidates, warnings: c.warnings };
}

// The board portal budget tile headline. Field names the tile already reads are
// kept; every figure is the OPERATING fund alone. Reserve and other funds are in
// `funds`, never combined into operating.
function budgetHeadline(budget, summary) {
  const op = summary.operating;
  return {
    fiscal_year: budget.fiscal_year,
    status: budget.status,
    operating_fund_code: op ? op.fund_code : null,
    operating_revenue_cents: op ? op.revenue_cents : null,
    operating_expense_cents: op ? op.expense_cents : null,
    operating_net_cents: op ? op.net_before_transfers_cents : null,            // before reserve funding (see operating_net_basis)
    operating_net_basis: summary.operating_net_basis,
    reserve_contribution_cents: summary.reserve_funding_cents,                  // planned Operating -> Reserve transfer (configured only)
    operating_net_after_reserve_funding_cents: op ? op.net_after_transfers_cents : null,
    funds: summary.funds.map((g) => ({ fund_code: g.fund_code, fund_name: g.fund_name, fund_type: g.fund_type, revenue_cents: g.revenue_cents, expense_cents: g.expense_cents,
      net_before_transfers_cents: g.net_before_transfers_cents, transfers_in_cents: g.transfers_in_cents, transfers_out_cents: g.transfers_out_cents, net_after_transfers_cents: g.net_after_transfers_cents })),
    warnings: summary.warnings.map((w) => w.text),
  };
}

// Ask Amanda's budget context: each fund on its own, Operating before and after
// reserve funding when a reserve transfer is configured.
function budgetContextText(budget, summary, money) {
  const op = summary.operating;
  const out = [`ADOPTED BUDGET (FY ${budget.fiscal_year}, ${budget.status}), by fund. Funds are separate; never add them together.`];
  if (op) {
    const lines = [`OPERATING FUND (${op.fund_code}):`, `- Budgeted operating revenue: ${money(op.revenue_cents)}`, `- Budgeted operating expense: ${money(op.expense_cents)}`,
      summary.operating_net_basis === 'before_reserve_funding'
        ? `- Operating surplus / (deficit) before reserve funding: ${money(op.net_before_transfers_cents)}`
        : `- Operating surplus / (deficit) as budgeted: ${money(op.net_before_transfers_cents)} (includes a line not configured as a transfer; see the note)`];
    if (op.transfers_out_cents || op.transfers_in_cents) {
      if (summary.reserve_funding_cents) lines.push(`- Planned reserve funding (transfer to Reserve): ${money(summary.reserve_funding_cents)}`);
      const other = op.transfers_out_cents - summary.reserve_funding_cents;
      if (other) lines.push(`- Other transfers out: ${money(other)}`);
      if (op.transfers_in_cents) lines.push(`- Transfers in: ${money(op.transfers_in_cents)}`);
      lines.push(`- Operating surplus / (deficit) after reserve funding: ${money(op.net_after_transfers_cents)}`);
    }
    out.push(lines.join('\n'));
  }
  for (const g of summary.funds.filter((x) => x !== op)) {
    const title = g.fund_type === 'unassigned' ? 'LINES WITH NO FUND' : `${String(g.fund_name || g.fund_code || '').toUpperCase()} (${g.fund_code}, ${String(g.fund_type || '').replace('_', ' ')})`;
    const lines = [`${title}:`, `- Budgeted revenue: ${money(g.revenue_cents)}`, `- Budgeted expense: ${money(g.expense_cents)}`];
    if (g.transfers_in_cents) lines.push(`- Transfers in: ${money(g.transfers_in_cents)}`);
    if (g.transfers_out_cents) lines.push(`- Transfers out: ${money(g.transfers_out_cents)}`);
    lines.push(`- Net: ${money(g.net_after_transfers_cents)}`);
    out.push(lines.join('\n'));
  }
  for (const w of summary.warnings) out.push(`NOTE: ${w.text}`);
  return out.join('\n');
}

// Read an approved budget with its accounts and funds (no embeds; bounded by the
// budget's own lines).
async function loadBudgetByFund(supabase, { community_id, budget_id }) {
  const must = (r, w) => { if (r.error) throw Object.assign(new Error(`${w}: ${r.error.message}`), { code: r.error.code }); return r.data || []; };
  const lines = must(await supabase.from('budget_line_items').select('account_id, fund_id, annual_amount_cents').eq('budget_id', budget_id).limit(5000), 'budget_line_items');
  const ids = [...new Set(lines.map((l) => l.account_id).filter(Boolean))];
  const accounts = [];
  for (let i = 0; i < ids.length; i += 200) {
    accounts.push(...must(await supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, account_subtype, fund_id, interfund_from_fund_id, interfund_to_fund_id')
      .eq('community_id', community_id).in('id', ids.slice(i, i + 200)), 'chart_of_accounts'));
  }
  const funds = must(await supabase.from('account_funds').select('id, fund_code, fund_name, fund_type').eq('community_id', community_id).limit(50), 'account_funds');
  return summarizeBudgetByFund({ lines, accounts, funds });
}

module.exports = { classifyByFund, summarizeBudgetByFund, budgetHeadline, budgetContextText, loadBudgetByFund };
