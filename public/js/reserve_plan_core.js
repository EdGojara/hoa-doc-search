// Reserve plan: the ONE calculation behind the Reserve Budget, shared by the budget
// editor (public/accounting.html, live as projects are typed) and the proposed-budget
// statement / PDF (lib/statements/model.js via lib/accounting/reserve_plan.js).
// (Ed 2026-10-11.)
//
//   - Reserve expenditures come ONLY from explicitly planned capital projects
//     (description, GL account, amount, expected month). Several projects may share
//     a GL account; the formal budget and the statements use the per-account sums.
//   - Prior-year reserve spending is history, never a basis for the next year.
//   - A saved budget amount on a reserve expense account that no project explains
//     (a legacy plan) is never dropped or rewritten: it is carried, counted once,
//     and flagged "needs review" until someone replaces or confirms it.
//   - Funding = transfers into the Reserve Fund (positive) less any transfers out,
//     plus reserve-fund revenue (interest). Net change = funding - planned capital
//     expenditures; projected ending balance = projected beginning + net change.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReservePlanCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

  // A configured interfund transfer line, as the amount it moves INTO the reserve fund
  // (negative when the reserve fund is the payer). A one-line budget records the outgoing
  // side as a negative revenue line (lib/accounting/budget_fund_summary.js): the amount
  // moved is its absolute value. Expense-typed transfer lines move their own amount.
  function transferIntoReserve({ account_type, amount_cents, to_fund_type, from_fund_type }) {
    const c = int(amount_cents);
    const moved = account_type === 'expense' ? c : Math.abs(c);
    if (to_fund_type === 'reserve') return moved;
    if (from_fund_type === 'reserve') return -moved;
    return 0;
  }

  function monthLabel(m) { const n = int(m); return n >= 1 && n <= 12 ? MONTHS[n - 1] : 'Timing not set'; }

  /**
   * @param projects       [{ project_name, account_id, planned_month, planned_amount_cents, review_status, note }]
   * @param saved_lines    [{ account_id, amount_cents }] reserve-expense amounts in the saved draft budget
   * @param plan_saved     true once the year's projects carry GL accounts (the saved lines are then
   *                       derived from the projects, not independent amounts)
   * @param funding        [{ account_id, label, kind: 'transfer' | 'revenue', amount_cents }] signed into reserve
   * @param beginning_cents projected reserve fund balance at the start of the year (null when unknown)
   * @param accounts       { [account_id]: { account_number, account_name } }
   */
  function computeReservePlan({ projects = [], saved_lines = [], plan_saved = false, funding = [], beginning_cents = null, accounts = {} } = {}) {
    const acct = (id) => accounts[id] || {};
    const warnings = [];
    const P = projects.filter((p) => String(p.project_name || '').trim() || int(p.planned_amount_cents)).map((p) => ({
      project_name: String(p.project_name || '').trim(), account_id: p.account_id || null,
      account_number: p.account_id ? acct(p.account_id).account_number || null : null, account_name: p.account_id ? acct(p.account_id).account_name || null : null,
      planned_month: p.planned_month ? int(p.planned_month) : null, month_label: monthLabel(p.planned_month),
      planned_amount_cents: int(p.planned_amount_cents), review_status: p.review_status === 'needs_review' ? 'needs_review' : 'planned', note: p.note || null,
    }));
    const by = new Map();
    const slot = (id) => { const k = id || ''; if (!by.has(k)) by.set(k, { account_id: id || null, account_number: id ? acct(id).account_number || null : null, account_name: id ? acct(id).account_name || null : 'GL account not chosen', planned_cents: 0, review_cents: 0, project_count: 0 }); return by.get(k); };
    for (const p of P) {
      const s = slot(p.account_id);
      if (p.review_status === 'needs_review') s.review_cents += p.planned_amount_cents; else s.planned_cents += p.planned_amount_cents;
      s.project_count += 1;
    }
    // Legacy saved amounts: an account with a saved amount and no project at all.
    const review_items = [];
    if (!plan_saved) {
      const withProjects = new Set(P.map((p) => p.account_id).filter(Boolean));
      for (const l of saved_lines) {
        const c = int(l.amount_cents);
        if (!c || withProjects.has(l.account_id)) continue;
        const a = acct(l.account_id);
        review_items.push({ account_id: l.account_id, account_number: a.account_number || null, account_name: a.account_name || null, amount_cents: c, reason: 'saved_without_project',
          text: `${a.account_number || ''} ${a.account_name || ''}: ${c / 100 < 0 ? '-' : ''}$${Math.abs(c / 100).toFixed(2)} is in the saved budget with no planned project behind it. Carried as is and flagged for review; it is not an approved project.`.trim() });
        slot(l.account_id).review_cents += c;
      }
    }
    const unassigned = by.get('');
    if (unassigned && (unassigned.planned_cents || unassigned.review_cents)) warnings.push({ code: 'project_without_account', text: `${unassigned.project_count} planned project${unassigned.project_count === 1 ? '' : 's'} ha${unassigned.project_count === 1 ? 's' : 've'} no GL account yet; choose one so the project reaches the budget by account.` });
    const undated = P.filter((p) => !p.planned_month).length;
    if (undated) warnings.push({ code: 'project_without_timing', text: `${undated} planned project${undated === 1 ? '' : 's'} ha${undated === 1 ? 's' : 've'} no expected month.` });
    const by_account = [...by.values()].map((s) => ({ ...s, total_cents: s.planned_cents + s.review_cents }))
      .sort((a, b) => (a.account_id ? 0 : 1) - (b.account_id ? 0 : 1) || String(a.account_number || '').localeCompare(String(b.account_number || '')));
    const F = funding.map((f) => ({ ...f, amount_cents: int(f.amount_cents) }));
    const funding_cents = F.reduce((t, f) => t + f.amount_cents, 0);
    const capex_cents = by_account.reduce((t, s) => t + s.total_cents, 0);
    const review_cents = by_account.reduce((t, s) => t + s.review_cents, 0);
    const net_change_cents = funding_cents - capex_cents;
    const beginning = beginning_cents === null || beginning_cents === undefined ? null : int(beginning_cents);
    return {
      projects: P, review_items, by_account, funding: F, warnings,
      totals: { funding_cents, transfers_cents: F.filter((f) => f.kind === 'transfer').reduce((t, f) => t + f.amount_cents, 0), revenue_cents: F.filter((f) => f.kind !== 'transfer').reduce((t, f) => t + f.amount_cents, 0),
        capex_cents, planned_cents: capex_cents - review_cents, review_cents, net_change_cents, beginning_cents: beginning, ending_cents: beginning === null ? null : beginning + net_change_cents },
    };
  }

  return { computeReservePlan, transferIntoReserve, monthLabel, MONTHS };
}));
