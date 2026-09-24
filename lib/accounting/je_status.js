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

module.exports = { COUNTED_JE_STATUSES, countsInGl };
