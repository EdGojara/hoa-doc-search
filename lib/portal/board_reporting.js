// ============================================================================
// lib/portal/board_reporting.js  (Ed 2026-10-10)
// ----------------------------------------------------------------------------
// The board portal's reporting period and its honesty labels. Read-only.
//   - Default period: the last COMPLETED calendar month that has posted accounting
//     activity (never a partial current month, so budget-to-date and actuals cover
//     the same months).
//   - Status: "closed" only when the month-end close has closed that period (or a
//     later one); otherwise "provisional". A month is not closed because it ended.
//   - Completeness: the month-end close's own data-completeness and recognition
//     controls (lib/close), evaluated read-only for the period. Not invented here.
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

// Pure: which close findings the board should see. Data completeness and recognition
// controls that did not pass; staff "action" text is left out.
const BOARD_GROUPS = new Set(['Data completeness', 'Recognition']);
function boardCompleteness(results = []) {
  return results.filter((r) => BOARD_GROUPS.has(r.group) && r.status !== 'PASS')
    .map((r) => ({ code: r.code, label: r.label, severity: r.status === 'BLOCK' ? 'incomplete' : 'check', explanation: r.explanation }));
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

// The close's completeness findings for the period (read-only gather + pure evaluation).
async function periodCompleteness(supabase, community_id, period_id) {
  if (!period_id) return { available: false, items: [], note: 'No accounting period is set up for this month, so completeness could not be checked.' };
  try {
    const { gatherCloseInput } = require('../close/gather');
    const { evaluateClose } = require('../close/controls');
    const input = await gatherCloseInput(supabase, community_id, period_id);
    return { available: true, items: boardCompleteness(evaluateClose(input).results) };
  } catch (e) {
    console.warn('[board_reporting] completeness unavailable:', e.message);
    return { available: false, items: [], note: 'Data completeness could not be checked for this month.' };
  }
}

module.exports = { lastCompletedMonthEnd, monthEndBack, boardCompleteness, chooseReportingPeriod, periodStatus, periodCompleteness, dayLabel };
