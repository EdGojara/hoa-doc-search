// ============================================================================
// lib/accounting/statement_periods.js  (Ed 2026-10-09, month-end close PR B)
// ----------------------------------------------------------------------------
// THE ONE RULE for which journal lines are revenue/expense ACTIVITY of a period.
// Every statement that reports period activity (income statement, budget vs
// actual, rolling 12-month, the printed by-fund statement, the budget plan's
// monthly actuals) goes through here, so they cannot drift apart.
//
// A converted community's books start with a conversion opening entry
// (journal_entries.source_module = 'opening_entry', CONV-<code>-OPEN-<fund>),
// dated the source cutoff (e.g. 7/31/2026). Besides balance sheet balances it
// carries the prior system's year-to-date revenue and expense (Jan-Jul) as ONE
// lump on its posting date. That lump is real YTD activity, but trustEd has no
// monthly detail for it. So:
//
//   CARRYFORWARD WINDOW  each opening entry carrying revenue/expense defines a
//     window: Jan 1 of its year through its posting date (the cutoff). The
//     identification is the entry's source_module (durable provenance), never
//     a date. An opening entry with no revenue/expense (a balance-sheet-only
//     opening, e.g. Eaglewood's 1/1 JE-2026-OPEN) defines no window.
//
//   A PERIOD [start, end] and a window:
//     covers   start <= window.from and end >= window.through: the carryforward
//              is part of the period's activity (a YTD through or after the
//              cutoff, a full year, a 12-month range spanning Jan-Jul). It is
//              reported as its own identifiable component.
//     disjoint the period is entirely before or after the window: nothing to do.
//     partial  any other overlap (July alone; June-August): the carryforward
//              cannot be split into months, so it is EXCLUDED, and the months of
//              the period inside the window are NOT AVAILABLE IN TRUSTED. If the
//              whole period lies inside the window, the period's activity is
//              not available (never a fake zero); otherwise it is partial.
//
//   Activity lines that are not opening-entry lines are always counted (even
//   inside a not-available month) and never hidden; an ordinary community with
//   no carryforward window is completely unchanged.
//
//   Balance sheet balances are NOT affected: this rule is for period activity.
// ============================================================================

const OPENING_MODULE = 'opening_entry';
const PL_TYPES = new Set(['revenue', 'expense']);
const NOT_AVAILABLE_LABEL = 'Not available in TrustEd';

const day = (v) => (v ? String(v).slice(0, 10) : null);
const isOpeningLine = (l) => !!(l && l.journal_entries && l.journal_entries.source_module === OPENING_MODULE);
const fmtUs = (d) => { const [y, m, dd] = String(d).split('-'); return `${Number(m)}/${Number(dd)}/${y}`; };
const carryLabel = (through) => `Opening YTD activity carried from prior system through ${fmtUs(through)}`;

// Month keys (YYYY-MM) from a..b inclusive.
function monthsBetween(a, b) {
  const out = [];
  let [y, m] = String(a).slice(0, 7).split('-').map(Number);
  const [ey, em] = String(b).slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}

// Windows from opening entries + their lines. openingEntries: [{id, reference, posting_date}]
// openingLines: [{journal_entry_id, account_id}]; accountTypeById: Map(account_id -> account_type)
function buildWindows(openingEntries, openingLines, accountTypeById) {
  const plEntry = new Set();
  for (const l of openingLines || []) if (PL_TYPES.has(accountTypeById.get(l.account_id))) plEntry.add(l.journal_entry_id);
  const byThrough = new Map();
  for (const je of openingEntries || []) {
    if (!plEntry.has(je.id)) continue;
    const through = day(je.posting_date);
    if (!byThrough.has(through)) byThrough.set(through, { from: `${through.slice(0, 4)}-01-01`, through, references: [], journal_entry_ids: [] });
    const w = byThrough.get(through);
    w.references.push(je.reference); w.journal_entry_ids.push(je.id);
  }
  return [...byThrough.values()].sort((a, b) => a.through.localeCompare(b.through))
    .map((w) => ({ ...w, references: w.references.sort(), label: carryLabel(w.through) }));
}

function relation(w, start, end) {
  if (end < w.from || start > w.through) return 'disjoint';
  if (start <= w.from && end >= w.through) return 'covers';
  return 'partial';
}

// How a period [start, end] relates to the carryforward windows.
function coverage(windows, start, end) {
  const covered = [], partial = [];
  for (const w of windows || []) { const r = relation(w, start, end); if (r === 'covers') covered.push(w); else if (r === 'partial') partial.push(w); }
  const unavailable = new Set();
  for (const w of partial) for (const m of monthsBetween(start > w.from ? start : w.from, end < w.through ? end : w.through)) unavailable.add(m);
  const inside = partial.some((w) => start >= w.from && end <= w.through);
  const status = !partial.length ? 'available' : inside ? 'not_available' : 'partial';
  const unavailable_months = [...unavailable].sort();
  return {
    status, unavailable_months,
    carryforward_included: covered.map((w) => ({ through: w.through, label: w.label, references: w.references })),
    carryforward_excluded: partial.map((w) => ({ through: w.through, label: w.label, references: w.references })),
    note: status === 'available' ? null
      : `${NOT_AVAILABLE_LABEL}: ${unavailable_months.join(', ')} (monthly detail before the cutover is in the prior system; it is carried as one opening YTD amount through ${fmtUs(partial[0].through)}).`,
  };
}

// The lines that are period ACTIVITY for [start, end]: every non-opening line
// dated in the period, plus opening-entry lines only when their window is
// covered. carry = the included opening lines (for the identifiable component).
function selectActivity(lines, windows, start, end) {
  const cov = coverage(windows, start, end);
  const coveredThrough = new Set(cov.carryforward_included.map((w) => w.through));
  const kept = [], carry = [];
  for (const l of lines || []) {
    const d = day(l.journal_entries && l.journal_entries.posting_date);
    if (!d || d < start || d > end) continue;
    if (isOpeningLine(l)) {
      if (!coveredThrough.has(d)) continue;
      carry.push(l);
    }
    kept.push(l);
  }
  return { lines: kept, carry, coverage: cov };
}

// Load the windows for a community (read-only).
async function loadWindows(supabase, community_id, accountTypeById) {
  const { COUNTED_JE_STATUSES } = require('./je_status');
  const { data: jes, error } = await supabase.from('journal_entries')
    .select('id, reference, posting_date, status')
    .eq('community_id', community_id).eq('source_module', OPENING_MODULE).in('status', COUNTED_JE_STATUSES).limit(200);
  if (error) throw Object.assign(new Error(`opening entries: ${error.message}`), { code: 'statement_periods_unavailable' });
  if (!jes || !jes.length) return [];
  const { data: lines, error: lErr } = await supabase.from('journal_entry_lines')
    .select('journal_entry_id, account_id').in('journal_entry_id', jes.map((j) => j.id)).limit(5000);
  if (lErr) throw Object.assign(new Error(`opening entry lines: ${lErr.message}`), { code: 'statement_periods_unavailable' });
  return buildWindows(jes, lines, accountTypeById);
}

module.exports = { OPENING_MODULE, NOT_AVAILABLE_LABEL, isOpeningLine, buildWindows, coverage, selectActivity, loadWindows, monthsBetween, carryLabel };
