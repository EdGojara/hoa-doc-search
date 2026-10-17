// ============================================================================
// lib/accounting/ownership.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// ACCOUNTING OWNERSHIP: the one answer to "does trustEd keep this
// association's books?" Every financial workflow (AP intake, the approval
// queues, approval, payment, check runs, AP and bill-back postings) asks here
// and processes only associations whose accounting is enabled in trustEd.
//
// Eaglewood is the case that forced it: its books stay in Vantaca (trustEd
// runs only its violations and ACC), yet email intake loaded 17 of its bills
// into trustEd Payables and posted accruals, because no financial path checked
// books_of_record / financials_active. Violations, ACC and every non-financial
// module do NOT call this, so they are unaffected.
//
// Enabled = financials_active is not false
//         AND books_of_record is 'trusted' (or unset)
//         AND not a prospect
//         AND not a former client (terminated, or terminating past its last day).
// ============================================================================
const { isFormerClient } = require('../ap/former_client');
// The books condition is lib/ap/books_scope's rule (Issue #14), the same one AP
// backfill, replay and 1099 scope already use. It just was never applied to the
// live paths (intake, queues, approval, payment, check runs) until now.
const { outsideTrustedBooks } = require('../ap/books_scope');

const SELECT = 'id, name, management_status, management_end_date, books_of_record, financials_active';

function accountingStatus(c, today) {
  if (!c) return { enabled: false, code: 'not_found', reason: 'Association not found.' };
  const name = c.name || 'This association';
  if (outsideTrustedBooks(c)) {
    if (c.books_of_record && c.books_of_record !== 'trusted') {
      const where = c.books_of_record === 'vantaca' ? 'Vantaca' : c.books_of_record;
      return { enabled: false, code: 'books_elsewhere', reason: `${name}'s accounting is kept in ${where}, not trustEd. trustEd does not process its accounting.` };
    }
    return { enabled: false, code: 'financials_off', reason: `trustEd does not keep the books for ${name}, so its accounting is not processed here.` };
  }
  if (c.management_status === 'prospect') return { enabled: false, code: 'prospect', reason: `${name} is a prospect. No financial processing until it is onboarded.` };
  if (isFormerClient(c, today)) return { enabled: false, code: 'former_client', reason: `${name} is a former client${c.management_end_date ? ` (last day ${c.management_end_date})` : ''}. Its records are preserved and its accounting is not processed in trustEd.` };
  return { enabled: true, code: 'enabled', reason: null };
}

// Ids of every association trustEd must NOT process financially.
async function financialsDisabledIds(supabase, today) {
  const { data, error } = await supabase.from('communities').select(SELECT);
  if (error) throw error;
  return new Set((data || []).filter((c) => !accountingStatus(c, today).enabled).map((c) => c.id));
}

async function accountingStatusFor(supabase, communityId, today) {
  if (!communityId) return accountingStatus(null, today);
  const { data, error } = await supabase.from('communities').select(SELECT).eq('id', communityId).maybeSingle();
  if (error) throw error;
  return Object.assign({ community: data || null }, accountingStatus(data, today));
}

// Throws (code 'financials_not_enabled') unless trustEd keeps the books.
async function assertFinancialsEnabled(supabase, communityId, what = 'This financial action') {
  const st = await accountingStatusFor(supabase, communityId);
  if (!st.enabled) throw Object.assign(new Error(`${what} refused: ${st.reason}`), { code: 'financials_not_enabled', ownership: st.code });
  return st;
}

// True for a refusal because trustEd does not keep the association's books: the app check
// (financials_not_enabled) or the migration 528 database guard (message 'books_closed:').
function isBooksClosed(err) { return !!err && (err.code === 'financials_not_enabled' || /books_closed:/.test(String(err.message || ''))); }
module.exports = { accountingStatus, accountingStatusFor, financialsDisabledIds, assertFinancialsEnabled, isBooksClosed };
