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
// PURE: integer cents in, integer cents out. Used by the board portal budget tile
// and Ask Amanda's budget context.
// ============================================================================

const { transferConfig } = require('../forecast/working_forecast_data');

const int = (n) => Math.round(Number(n) || 0);
const TYPE_ORDER = ['operating', 'reserve', 'special_assessment', 'capital_improvement', 'escrow', 'other', null, 'unassigned'];

/**
 * lines:    [{ account_id, fund_id, annual_amount_cents }]
 * accounts: [{ id, account_number, account_name, account_type, account_subtype, fund_id, interfund_from_fund_id, interfund_to_fund_id }]
 * funds:    [{ id, fund_code, fund_name, fund_type }]
 */
function summarizeBudgetByFund({ lines = [], accounts = [], funds = [] }) {
  const A = new Map(accounts.map((a) => [a.id, a]));
  const F = new Map(funds.map((f) => [f.id, f]));
  const groups = new Map();
  const group = (fundId) => {
    const k = fundId && F.has(fundId) ? fundId : 'unassigned';
    if (!groups.has(k)) {
      const f = F.get(k);
      groups.set(k, { fund_id: f ? f.id : null, fund_code: f ? f.fund_code : null, fund_name: f ? f.fund_name || null : null, fund_type: f ? f.fund_type || null : 'unassigned',
        revenue_cents: 0, expense_cents: 0, transfers_in_cents: 0, transfers_out_cents: 0 });
    }
    return groups.get(k);
  };
  const transfers = [], candidates = [], warnings = [];
  for (const l of lines) {
    const a = A.get(l.account_id);
    if (!a || !['revenue', 'expense'].includes(a.account_type)) continue;
    const amt = int(l.annual_amount_cents);
    const cfg = transferConfig(a, funds);
    if (cfg.transfer) {
      const t = cfg.transfer; const mag = Math.abs(amt);
      group(t.from_fund_id).transfers_out_cents += mag;
      group(t.to_fund_id).transfers_in_cents += mag;
      transfers.push({ account: `${a.account_number} ${a.account_name}`, from_fund_code: t.from_fund_code, from_fund_type: t.from_fund_type, to_fund_code: t.to_fund_code, to_fund_type: t.to_fund_type, amount_cents: mag });
      continue;
    }
    if (cfg.transfer_config_error) warnings.push({ code: 'transfer_config_invalid', account: `${a.account_number} ${a.account_name}`, text: `${a.account_number} ${a.account_name}: ${cfg.transfer_config_error}; treated as an ordinary line.` });
    const g = group(l.fund_id || a.fund_id);
    if (a.account_type === 'revenue') {
      g.revenue_cents += amt;
      if (amt < 0) candidates.push({ account: `${a.account_number} ${a.account_name}`, fund_code: g.fund_code, amount_cents: amt });
    } else g.expense_cents += amt;
  }
  if (candidates.length) warnings.push({ code: 'negative_revenue_budget', text: `${candidates.map((c) => `${c.account} (${c.fund_code || 'no fund'})`).join('; ')}: a negative revenue budget usually records a transfer between funds but is not configured as one, so it is reported as budgeted in its fund.` });
  const out = [...groups.values()].map((g) => {
    const net = g.revenue_cents - g.expense_cents;
    return { ...g, net_before_transfers_cents: net, net_after_transfers_cents: net + g.transfers_in_cents - g.transfers_out_cents };
  }).sort((x, y) => (TYPE_ORDER.indexOf(x.fund_type) - TYPE_ORDER.indexOf(y.fund_type)) || String(x.fund_code).localeCompare(String(y.fund_code)));
  const ops = out.filter((g) => g.fund_type === 'operating');
  if (ops.length !== 1) warnings.push({ code: 'no_operating_fund', text: ops.length ? 'More than one operating fund; no single operating figure is shown.' : 'No operating fund identified; no operating figure is shown.' });
  const operating = ops.length === 1 ? ops[0] : null;
  const reserveFunding = operating ? transfers.filter((t) => t.from_fund_code === operating.fund_code && t.to_fund_type === 'reserve').reduce((s, t) => s + t.amount_cents, 0) : 0;
  // If an unconfigured transfer-like line sits IN the operating fund (e.g. a negative
  // "Reserve Contribution" revenue line), the operating net already includes it: it is
  // labelled "as budgeted", never "before reserve funding".
  const netBasis = !operating ? null : candidates.some((c) => c.fund_code === operating.fund_code) ? 'as_budgeted_includes_unconfigured_transfer' : 'before_reserve_funding';
  return { funds: out, operating, operating_net_basis: netBasis, transfers, reserve_funding_cents: reserveFunding, unconfigured_transfer_candidates: candidates, warnings };
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

module.exports = { summarizeBudgetByFund, budgetHeadline, budgetContextText, loadBudgetByFund };
