// ============================================================================
// lib/accounting/recognition_schedule.js  (Phase 3C, pure: no database access)
// ----------------------------------------------------------------------------
// The accounting fact a forecast must not guess: WHEN a billed or paid amount
// belongs on the income statement.
//
//   billing / payment event  ->  balance-sheet position  ->  recognition schedule
//   (AR, cash, AP)                (2205 unearned, 1400 prepaid)  (period rows)
//                                                              ->  monthly P&L
//
// The schedule's period rows are the single source of truth for "how much in
// which month" (migration 466, recognition_schedule_periods). This module:
//   buildRecognitionPeriods()  exact-to-the-cent period amounts (same rules the
//                              database uses to generate calculated schedules)
//   recognitionStatus()        scheduled / recognized / remaining / missing, from
//                              period rows + posting rows (never inferred)
//   recognitionFacts()         Amanda-ready structured facts (numbers only)
//   forecastMonthsFromSchedules()  fiscal-year P&L months a forecast should use
// ============================================================================

const int = (v) => Math.round(Number(v || 0));
const monthKey = (d) => String(d).slice(0, 7);

function addMonths(iso, n) {
  const [y, m] = String(iso).slice(0, 7).split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
}

/**
 * Period amounts that tie EXACTLY to total_cents.
 *   straight_line_monthly: every month = monthly_cents (default round(total/term)),
 *                          the last month takes the rounding remainder.
 *   daily:                 each month's share of days in [period_start, period_end],
 *                          computed as differences of cumulative roundings.
 *   documented_schedule / manual: the supplied months (must sum to the total).
 */
function buildRecognitionPeriods({ total_cents, start_month, term_months, method = 'straight_line_monthly', monthly_cents = null, period_start = null, period_end = null, months = null }) {
  const total = int(total_cents);
  if (!(total > 0)) throw new Error('total_cents must be positive');
  if (method === 'documented_schedule' || method === 'manual') {
    if (!Array.isArray(months) || !months.length) throw new Error('a documented schedule needs its months');
    const out = months.map((m) => ({ period_month: `${monthKey(m.period_month)}-01`, scheduled_cents: int(m.scheduled_cents) }));
    const sum = out.reduce((s, p) => s + p.scheduled_cents, 0);
    if (sum !== total) throw new Error(`documented months sum ${sum} but the schedule total is ${total}`);
    if (new Set(out.map((p) => p.period_month)).size !== out.length) throw new Error('a month appears twice');
    return out.sort((a, b) => a.period_month.localeCompare(b.period_month));
  }
  const term = int(term_months);
  if (!(term > 0)) throw new Error('term_months must be positive');
  const start = `${monthKey(start_month)}-01`;
  if (method === 'daily') {
    const DAY = 86400000, P = Date.parse(period_start), E = Date.parse(period_end);
    if (!Number.isFinite(P) || !Number.isFinite(E) || E < P) throw new Error('daily recognition needs period_start <= period_end');
    const totalDays = Math.round((E - P) / DAY) + 1;
    const cum = (k) => {
      if (k < 0) return 0;
      const ms = addMonths(start, k);
      const monthEnd = Date.UTC(Number(ms.slice(0, 4)), Number(ms.slice(5, 7)), 0);
      const clamp = Math.min(monthEnd, E);
      if (clamp < P) return 0;
      return Math.round((Math.min(Math.round((clamp - P) / DAY) + 1, totalDays) * total) / totalDays);
    };
    return Array.from({ length: term }, (_, k) => ({ period_month: addMonths(start, k), scheduled_cents: cum(k) - cum(k - 1) }));
  }
  if (method !== 'straight_line_monthly') throw new Error(`unknown recognition method ${method}`);
  const monthly = monthly_cents == null ? Math.round(total / term) : int(monthly_cents);
  const last = total - monthly * (term - 1);
  if (last < 0) throw new Error('monthly amount too large for the total');
  return Array.from({ length: term }, (_, k) => ({ period_month: addMonths(start, k), scheduled_cents: k === term - 1 ? last : monthly }));
}

/**
 * Status from period rows + posting rows. postings: [{period_month, amount_cents,
 * kind: 'recognition'|'reversal', reversed: bool}]. Recognized = sum of all posting
 * amounts (reversals are negative), so reversals net out explicitly.
 */
function recognitionStatus({ total_cents, periods = [], postings = [], as_of_month = null, fiscal_year = null }) {
  const total = int(total_cents);
  const effective = new Set(postings.filter((p) => (p.kind || 'recognition') === 'recognition' && !p.reversed).map((p) => monthKey(p.period_month)));
  const recognized = postings.reduce((s, p) => s + int(p.amount_cents), 0);
  const asOf = as_of_month ? monthKey(as_of_month) : null;
  const scheduled_sum = periods.reduce((s, p) => s + int(p.scheduled_cents), 0);
  const due = periods.filter((p) => int(p.scheduled_cents) > 0 && asOf && monthKey(p.period_month) <= asOf);
  const missing = due.filter((p) => !effective.has(monthKey(p.period_month)));
  const unposted = periods.filter((p) => int(p.scheduled_cents) > 0 && !effective.has(monthKey(p.period_month)));
  const inFy = (p) => fiscal_year == null || Number(monthKey(p.period_month).slice(0, 4)) === Number(fiscal_year);
  const recognized_fy = postings.filter(inFy).reduce((s, p) => s + int(p.amount_cents), 0);
  const scheduled_through_as_of = due.reduce((s, p) => s + int(p.scheduled_cents), 0);
  const amounts = periods.map((p) => int(p.scheduled_cents)).filter((c) => c > 0);
  const mode = amounts.length ? [...amounts].sort((a, b) => amounts.filter((x) => x === b).length - amounts.filter((x) => x === a).length)[0] : 0;
  return {
    total_cents: total,
    scheduled_sum_cents: scheduled_sum,
    periods_tie: scheduled_sum === total,
    recognized_cents: recognized,
    recognized_fy_cents: recognized_fy,
    remaining_cents: total - recognized,
    ties: recognized + (total - recognized) === total && recognized <= total && recognized >= 0,
    scheduled_through_as_of_cents: scheduled_through_as_of,
    behind_schedule_cents: scheduled_through_as_of - due.filter((p) => effective.has(monthKey(p.period_month))).reduce((s, p) => s + int(p.scheduled_cents), 0),
    monthly_cents: mode,
    next_recognition_month: unposted.length ? `${monthKey(unposted[0].period_month)}-01` : null,
    missing_months: missing.map((p) => `${monthKey(p.period_month)}-01`),
    missing_cents: missing.reduce((s, p) => s + int(p.scheduled_cents), 0),
    overdue: missing.length > 0,
  };
}

/**
 * Amanda-ready facts for one schedule. Numbers and references only; any sentence
 * Amanda says must be assembled from these fields, never inferred.
 * gl_balance_cents (optional): the balance-sheet account's GL balance, normal-signed.
 */
function recognitionFacts({ schedule, periods, postings, as_of_month, fiscal_year, balance_account = null, recognition_account = null, source_document = null, gl_balance_cents = null }) {
  const st = recognitionStatus({ total_cents: schedule.recognize_amount_cents, periods, postings, as_of_month, fiscal_year });
  const isRevenue = schedule.schedule_type === 'deferred_revenue';
  return {
    schedule_id: schedule.id || null,
    description: schedule.description,
    schedule_type: schedule.schedule_type,
    status: schedule.status,
    recognition_method: schedule.recognition_method || 'straight_line_monthly',
    schedule_basis: schedule.schedule_basis || 'calculated',
    service_period: { start: schedule.period_start || null, end: schedule.period_end || null },
    balance_sheet_account: balance_account,
    pnl_account: recognition_account,
    source_document,
    schedule_total_cents: st.total_cents,
    recognized_to_date_cents: st.recognized_cents,
    recognized_ytd_cents: st.recognized_fy_cents,
    remaining_cents: st.remaining_cents,
    remaining_label: isRevenue ? 'deferred revenue remaining' : 'prepaid remaining',
    monthly_recognition_cents: st.monthly_cents,
    next_recognition_month: st.next_recognition_month,
    missing_months: st.missing_months,
    missing_cents: st.missing_cents,
    overdue: st.overdue,
    reconciles: st.ties && st.periods_tie,
    gl_balance_cents,
    gl_matches_remaining: gl_balance_cents == null ? null : int(gl_balance_cents) === st.remaining_cents,
  };
}

/**
 * The fiscal year's P&L months (index 0..11) that a forecast should use from one
 * or more schedules recognizing into the line's account.
 *   months <= as_of : actual comes from the GL; nothing here (0).
 *   months >  as_of : the scheduled amount for the month (unposted).
 *   due months not yet posted (<= as_of): carried as a labelled catch-up in the
 *   first remaining month, because the schedule says they belong in this year.
 * Returns { months, catch_up_cents, missing_months, basis }.
 */
function forecastMonthsFromSchedules({ schedules, fiscal_year, as_of_month }) {
  const months = Array(12).fill(0);
  let catch_up = 0; const missing = []; let documented = true;
  for (const s of schedules) {
    if (s.schedule_basis !== 'documented') documented = false;
    const effective = new Set((s.postings || []).filter((p) => (p.kind || 'recognition') === 'recognition' && !p.reversed).map((p) => monthKey(p.period_month)));
    for (const p of s.periods) {
      const [y, m] = monthKey(p.period_month).split('-').map(Number);
      if (y !== Number(fiscal_year)) continue;
      const amt = int(p.scheduled_cents); if (!amt) continue;
      if (m > as_of_month) { if (!effective.has(monthKey(p.period_month))) months[m - 1] += amt; }
      else if (!effective.has(monthKey(p.period_month))) { catch_up += amt; missing.push(`${monthKey(p.period_month)}-01`); }
    }
  }
  if (catch_up && as_of_month < 12) months[as_of_month] += catch_up;
  return { months, catch_up_cents: catch_up, missing_months: missing, basis: documented ? 'documented' : 'calculated' };
}

module.exports = { addMonths, buildRecognitionPeriods, recognitionStatus, recognitionFacts, forecastMonthsFromSchedules };
