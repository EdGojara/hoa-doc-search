// ============================================================================
// lib/portal/board_reporting.js  (Ed 2026-10-10)
// ----------------------------------------------------------------------------
// The board portal's reporting period and its honesty labels. Read-only.
//   - Default period: the last COMPLETED calendar month that has posted accounting
//     activity (never a partial current month, so budget-to-date and actuals cover
//     the same months).
//   - Status: "closed" only when the month-end close has closed that period (or a
//     later one); otherwise "provisional". A month is not closed because it ended.
//   - Completeness: the month-end close's own controls (lib/close), evaluated read-only
//     for the period and split into material financial statement exceptions and
//     outstanding close procedures. Not invented here; nothing is dropped.
// ============================================================================

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // m = 1..12 → last day of that month
const dayLabel = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

// Pure: the last day of the month before `today` (YYYY-MM-DD).
function lastCompletedMonthEnd(today) {
  const [y, m] = String(today).slice(0, 10).split('-').map(Number);
  return m === 1 ? monthEnd(y - 1, 12) : monthEnd(y, m - 1);
}
// Pure: the month end `n` months before a month end.
function monthEndBack(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) - n;
  return monthEnd(Math.floor(idx / 12), (idx % 12) + 1);
}

// Pure: split the month-end close's findings (lib/close/controls.js evaluateClose results)
// into what the BOARD must see prominently and what is routine close work.
//
//   material   - findings that mean a financial statement figure is incomplete or does not
//                tie: ledger integrity, receivables / payables ties, unrecorded revenue or
//                recognition, bills received but not recorded, and CASH that is not verified.
//                Cash is judged per account, never dismissed: a missing statement or an
//                unfinished reconciliation is material when that account carries a balance
//                at period end (the balance sheet's cash is unverified); an account with no
//                balance is a routine procedure.
//   procedures - other outstanding close steps (warning-level housekeeping, zero-balance
//                accounts awaiting statements, recurring bills to confirm).
// Nothing is dropped: every non-passing finding lands in one of the two lists. No
// materiality threshold is invented; an issue is material by WHAT it affects, not its size.
const MATERIAL_TITLE = {
  'GL-01': 'The general ledger does not balance', 'GL-02': 'Some journal entries are incomplete', 'GL-03': 'Unposted entries are dated in the month',
  'GL-04': 'Some entries have invalid posting dates', 'GL-05': 'Entries were recorded into a closed month', 'GL-06': 'A fund does not balance',
  'AR-01': 'Homeowner receivables do not tie to the general ledger', 'AR-02': 'Homeowner credit balances do not tie to the general ledger',
  'AP-01': 'Unpaid bills do not tie to the general ledger',
  'REC-01': 'Scheduled monthly recognition entries are behind',
  'DATA-01': 'Assessment billing and homeowner payments for the month are not fully recorded',
  'DATA-03': 'Prepaid and deferred balances are not yet being recognized monthly',
  'DATA-04': 'Bills received have not all been recorded',
  'CONV-01': 'This period\'s books are not kept in trustEd',
};
const PROCEDURE_TITLE = {
  'GL-07': 'Voided entries to pair with their reversals', 'CASH-03': 'Bank accounts sharing a cash account in the ledger',
  'CASH-04': 'Bank reconciling items to review', 'AP-02': 'Held or disputed bills to resolve', 'CONV-02': 'Conversion reconciling items to disclose',
  'DATA-05': 'Recurring vendor bills to confirm (a missing bill may mean an unrecorded expense)',
};
const CASH_CODES = new Set(['CASH-01', 'CASH-02', 'DATA-02']);
const money = (c) => `$${(Math.abs(Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

function classifyFindings(results = [], input = {}) {
  const open = results.filter((r) => r.status !== 'PASS');
  const material = [], procedures = [];
  // ---- cash, per account
  const bank = input.bank || {};
  const per = input.period || {};
  const accts = (bank.accounts || []).filter((a) => a.is_active !== false);
  const glBal = bank.gl_balances || {};
  const hasStmt = (a) => (bank.statements || []).some((s) => s.bank_account_id === a.id && s.status === 'completed'
    && String(s.statement_period_end) >= String(per.period_start) && String(s.statement_period_end) <= String(per.period_end));
  const reconciled = (a) => (bank.recs || []).some((r) => r.bank_account_id === a.id && r.status === 'reconciled' && Number(r.difference_cents) === 0
    && String(r.period_end) >= String(per.period_start) && String(r.period_end) <= String(per.period_end));
  const cashOpen = open.filter((r) => CASH_CODES.has(r.code));
  if (cashOpen.length) {
    const unverified = accts.filter((a) => !hasStmt(a) || !reconciled(a)).map((a) => {
      const bal = glBal[a.gl_account_number];
      return { name: `${a.account_nickname}${a.account_last4 ? ` ••${a.account_last4}` : ''}`, balance_cents: bal == null ? null : Number(bal), statement: hasStmt(a), reconciled: reconciled(a) };
    });
    const withBal = unverified.filter((u) => u.balance_cents === null || u.balance_cents !== 0);   // unknown balance is treated as carrying cash
    const zero = unverified.filter((u) => u.balance_cents === 0);
    const tieOff = open.find((r) => r.code === 'CASH-02' && r.amount_cents);
    const why = (u) => `${u.name}${u.balance_cents == null ? '' : ` (${money(u.balance_cents)})`}: ${!u.statement ? 'no statement' : 'statement received'}, ${u.reconciled ? 'reconciled' : 'not reconciled'}`;
    if (withBal.length || tieOff || !accts.length) {
      const total = withBal.reduce((t, u) => t + (u.balance_cents || 0), 0);
      material.push({ code: 'CASH', codes: cashOpen.map((r) => r.code), title: 'Cash balances are not yet verified against bank statements',
        explanation: !accts.length ? 'No bank or investment accounts are set up, so no cash balance can be verified.'
          : `${withBal.length} ${withBal.length === 1 ? 'account carrying' : 'accounts carrying'} ${money(total)} at ${per.period_end || 'period end'} ${withBal.length === 1 ? 'is' : 'are'} not yet verified: ${withBal.map(why).join('; ')}.${tieOff ? ` ${tieOff.explanation}` : ''}` });
    }
    if (zero.length) procedures.push({ code: 'CASH-ZERO', codes: cashOpen.map((r) => r.code), title: `Bank statements or reconciliations still to file for ${zero.length} ${zero.length === 1 ? 'account' : 'accounts'} with no balance`, explanation: zero.map(why).join('; ') + '.' });
  }
  // ---- everything else
  for (const r of open) {
    if (CASH_CODES.has(r.code)) continue;
    if (MATERIAL_TITLE[r.code] || (r.status === 'BLOCK' && !PROCEDURE_TITLE[r.code])) material.push({ code: r.code, title: MATERIAL_TITLE[r.code] || r.label, explanation: r.explanation });
    else procedures.push({ code: r.code, title: PROCEDURE_TITLE[r.code] || r.label, explanation: r.explanation });
  }
  return { material, procedures };
}

/**
 * Choose the period. requested (YYYY-MM-DD) wins; otherwise the last completed month with
 * posted activity, stepping back at most 6 months.
 */
async function chooseReportingPeriod(supabase, community_id, { today, requested } = {}) {
  if (requested && ISO.test(requested)) return { period_end: requested, basis: 'requested', stepped_back_from: null };
  const { COUNTED_JE_STATUSES } = require('../accounting/je_status');
  const first = lastCompletedMonthEnd(today);
  for (let back = 0; back <= 6; back++) {
    const end = monthEndBack(first, back); const start = `${end.slice(0, 7)}-01`;
    const { count, error } = await supabase.from('journal_entries').select('id', { count: 'exact', head: true })
      .eq('community_id', community_id).in('status', COUNTED_JE_STATUSES).gte('posting_date', start).lte('posting_date', end);
    if (error) throw Object.assign(new Error(`reporting period: ${error.message}`), { code: error.code });
    if (count > 0) return { period_end: end, basis: 'last_completed_month', stepped_back_from: back ? first : null };
  }
  return { period_end: first, basis: 'last_completed_month', stepped_back_from: null, no_recent_activity: true };
}

// Close status of the period's month, from the month-end close records.
async function periodStatus(supabase, community_id, period_end) {
  const end = monthEnd(+period_end.slice(0, 4), +period_end.slice(5, 7));
  const { data: per, error } = await supabase.from('accounting_periods').select('id, period_end, status, period_type')
    .eq('community_id', community_id).eq('period_end', end).maybeSingle();
  if (error) throw Object.assign(new Error(`accounting period: ${error.message}`), { code: error.code });
  const th = await supabase.rpc('close_closed_through', { p_community: community_id });
  const closedThrough = th.error ? null : (th.data ? String(th.data).slice(0, 10) : null);
  let closeRec = null;
  if (per) { const r = await supabase.from('period_closes').select('status, close_label').eq('period_id', per.id).maybeSingle(); if (!r.error) closeRec = r.data; }
  const closed = !!((per && ['closed', 'locked'].includes(per.status)) || (closeRec && closeRec.status === 'closed') || (closedThrough && closedThrough >= end));
  const partial = period_end !== end;   // a requested mid-month date
  return {
    period_id: per ? per.id : null, month_end: end, closed_through: closedThrough,
    status: closed && !partial ? 'closed' : 'provisional',
    status_label: closed && !partial ? `Closed${closeRec && closeRec.close_label ? ` (${closeRec.close_label})` : ''}` : partial ? 'Provisional: a partial month' : 'Provisional: this month has not been closed',
  };
}

// The close's findings for the period (read-only gather + pure evaluation), split into
// material financial statement exceptions and outstanding close procedures. `details` keeps
// every non-passing finding in full (with staff actions) for authorized accounting staff.
async function periodCompleteness(supabase, community_id, period_id) {
  if (!period_id) return { available: false, material: [], procedures: [], details: [], note: 'No accounting period is set up for this month, so completeness could not be checked.' };
  try {
    const { gatherCloseInput } = require('../close/gather');
    const { evaluateClose } = require('../close/controls');
    const input = await gatherCloseInput(supabase, community_id, period_id);
    const results = evaluateClose(input).results;
    const { material, procedures } = classifyFindings(results, input);
    return { available: true, material, procedures, details: results.filter((r) => r.status !== 'PASS').map((r) => ({ code: r.code, group: r.group, label: r.label, status: r.status, explanation: r.explanation, action: r.action, amount_cents: r.amount_cents, count: r.count })) };
  } catch (e) {
    console.warn('[board_reporting] completeness unavailable:', e.message);
    return { available: false, material: [], procedures: [], details: [], note: 'Data completeness could not be checked for this month.' };
  }
}

module.exports = { lastCompletedMonthEnd, monthEndBack, classifyFindings, chooseReportingPeriod, periodStatus, periodCompleteness, dayLabel };
