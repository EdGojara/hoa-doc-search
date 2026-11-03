// ============================================================================
// lib/accounting/je_status.js
// ----------------------------------------------------------------------------
// THE rule for which journal entries count in balances. Every balance surface
// (trial balance view, statements, books, bank rec, cash, vendor spend, and
// conversion verification) must use it, so they cannot disagree.
//
// voidJournalEntry() posts a REVERSAL entry and then marks the original
// 'voided'. The economic pair is original + reversal = 0, so BOTH must count.
// Counting only 'posted' drops the original but keeps its reversal, which
// applies every void twice (LOPF 7/31: AP understated by $11,275.23).
//
// Counts:        status 'posted', or status 'voided' with its reversal present
// Never counts:  'draft', a 'voided' entry with no reversal, or any other status
// Mirrors the SQL predicate in migration 453 (v_trial_balance).
// ============================================================================

const COUNTED_JE_STATUSES = ['posted', 'voided'];

function countsInGl(je) {
  if (!je) return false;
  if (je.status === 'posted') return true;
  return je.status === 'voided' && !!je.void_reversal_je_id;
}

// A void of a system error dated in its own month (Ed 2026-11-03): the voided original and its
// reversal net to zero there, so a statement or drill-down shows neither; both stay in the general
// ledger as the audit record. rows: lines carrying journal_entries { id, status, void_reversal_je_id,
// posting_date }. A void reversed in a LATER month is kept visible (it changed that month).
function dropSameMonthVoidPairs(rows, jeOf = (r) => r.journal_entries) {
  const byId = new Map();
  for (const r of rows || []) { const j = jeOf(r); if (j && j.id) byId.set(j.id, j); }
  const mon = (d) => String(d || '').slice(0, 7);
  const pair = new Set();
  for (const j of byId.values()) {
    if (j.status !== 'voided' || !j.void_reversal_je_id) continue;
    const rv = byId.get(j.void_reversal_je_id);
    if (rv && mon(rv.posting_date) === mon(j.posting_date)) { pair.add(j.id); pair.add(rv.id); }
  }
  return pair.size ? (rows || []).filter((r) => { const j = jeOf(r); return !(j && pair.has(j.id)); }) : (rows || []);
}

module.exports = { COUNTED_JE_STATUSES, countsInGl, dropSameMonthVoidPairs };
