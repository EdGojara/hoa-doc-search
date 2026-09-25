// ============================================================================
// lib/accounting/budget_merge.js — how a budget save combines with what is saved.
// ----------------------------------------------------------------------------
// Budget Phase 0 (Ed 2026-09-25). The monthly schedule is the planning layer:
//   * A line sent WITH 12 months is taken as-is (the months must add to the annual).
//   * A line sent WITHOUT months keeps the saved schedule when its annual is
//     unchanged, byte for byte. If the annual changed and the saved schedule is
//     an intentional (uneven) pattern, the caller must say how: 'scale' (keep the
//     pattern, scaled to the new annual) or 'even' (spread evenly). Never a silent
//     annual/12 over a real schedule.
//   * A brand-new line with no months gets the even spread (there is no schedule
//     to lose), as before.
//   * Saved lines that are NOT in the request are kept. Removal is explicit only
//     (removeAccountIds).
// Pure: no database access, so it can be proven against real budgets in tests.
// ============================================================================

function evenSplit(annual) {
  const a = Math.round(Number(annual) || 0);
  const each = Math.trunc(a / 12);
  const m = Array(12).fill(each);
  m[11] += a - each * 12;
  return m;
}

// An even spread (the canonical split, every month within a cent of 1/12, or a
// whole-dollar split with one residue month) is
// not an intentional schedule; re-spreading it loses nothing.
function isEvenSchedule(monthly, annual) {
  const m = (monthly || []).map(Number);
  if (m.length !== 12) return true;
  const canon = evenSplit(annual);
  if (m.every((v, i) => v === canon[i])) return true;
  const avg = Number(annual) / 12;
  if (m.every((v) => Math.abs(v - avg) <= 1)) return true;
  // Whole-dollar even split: eleven equal months and one month carrying the
  // rounding residue (under $12). Budgets imported from Vantaca look like this.
  const counts = new Map(); m.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  if (counts.size === 2) {
    const [[v1, c1], [v2, c2]] = [...counts.entries()];
    if (Math.min(c1, c2) === 1 && Math.abs(v1 - v2) < 1200) return true;
  }
  return false;
}

// Keep the pattern, scale to a new annual; largest-remainder rounding so the
// months add exactly to the annual.
function scaleSchedule(monthly, oldAnnual, newAnnual) {
  const m = (monthly || []).map(Number);
  const base = m.reduce((s, v) => s + v, 0) || Number(oldAnnual) || 0;
  const target = Math.round(Number(newAnnual) || 0);
  if (!base) return evenSplit(target);
  const raw = m.map((v) => (v / base) * target);
  const out = raw.map((v) => Math.trunc(v));
  let rem = target - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, f: Math.abs(v - Math.trunc(v)) })).sort((a, b) => b.f - a.f || a.i - b.i);
  const step = rem >= 0 ? 1 : -1;
  for (let k = 0; rem !== 0; k = (k + 1) % 12) { out[order[k].i] += step; rem -= step; }
  return out;
}

/**
 * @param existing  saved lines [{account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes}]
 * @param incoming  request lines [{account_id, fund_id?, annual_amount_cents, monthly_amounts_cents?, notes?, phasing?}]
 * @param opts      { phasing?: 'scale'|'even' (default for changed uneven lines), removeAccountIds?: [] }
 * @returns { rows, kept, removed, decisionsNeeded: [{account_id, reason}], errors: [] }
 */
function mergeBudgetLines(existing, incoming, opts = {}) {
  const byAcct = new Map((existing || []).map((l) => [l.account_id, l]));
  const remove = new Set(opts.removeAccountIds || []);
  const out = new Map();
  const decisionsNeeded = []; const errors = [];

  for (const li of incoming || []) {
    if (!li || !li.account_id) { errors.push({ account_id: null, error: 'account_id_required' }); continue; }
    if (remove.has(li.account_id)) { errors.push({ account_id: li.account_id, error: 'line_both_sent_and_removed' }); continue; }
    const annual = Math.round(Number(li.annual_amount_cents) || 0);
    const prev = byAcct.get(li.account_id) || null;
    let monthly = null;
    if (Array.isArray(li.monthly_amounts_cents)) {
      const m = li.monthly_amounts_cents.map((n) => Math.round(Number(n) || 0));
      if (m.length !== 12) { errors.push({ account_id: li.account_id, error: 'monthly_must_have_12_values' }); continue; }
      if (m.reduce((s, v) => s + v, 0) !== annual) { errors.push({ account_id: li.account_id, error: 'monthly_total_does_not_equal_annual' }); continue; }
      monthly = m;
    } else if (prev) {
      const prevMonthly = (prev.monthly_amounts_cents || []).map(Number);
      if (Number(prev.annual_amount_cents) === annual && prevMonthly.length === 12) {
        monthly = prevMonthly;                                  // unchanged: keep exactly
      } else if (isEvenSchedule(prevMonthly, prev.annual_amount_cents)) {
        monthly = evenSplit(annual);                            // no intentional schedule to lose
      } else {
        const how = li.phasing || opts.phasing || null;
        if (how === 'scale') monthly = scaleSchedule(prevMonthly, prev.annual_amount_cents, annual);
        else if (how === 'even') monthly = evenSplit(annual);
        else { decisionsNeeded.push({ account_id: li.account_id, previous_annual_cents: Number(prev.annual_amount_cents), new_annual_cents: annual, previous_monthly_cents: prevMonthly }); continue; }
      }
    } else {
      monthly = evenSplit(annual);                              // new line, no schedule yet
    }
    out.set(li.account_id, {
      account_id: li.account_id,
      fund_id: li.fund_id !== undefined ? (li.fund_id || null) : (prev ? prev.fund_id || null : null),
      annual_amount_cents: annual,
      monthly_amounts_cents: monthly,
      notes: li.notes !== undefined ? (li.notes || null) : (prev ? prev.notes || null : null),
    });
  }
  const kept = (existing || []).filter((l) => !out.has(l.account_id) && !remove.has(l.account_id)).map((l) => l.account_id);
  const removed = (existing || []).filter((l) => remove.has(l.account_id)).map((l) => l.account_id);
  return { rows: [...out.values()], kept, removed, decisionsNeeded, errors };
}

module.exports = { mergeBudgetLines, evenSplit, isEvenSchedule, scaleSchedule };
