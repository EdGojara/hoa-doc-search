// ============================================================================
// lib/ap/decide_path.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Decide ONCE, at intake, which approval route a bill takes — and store it, so
// the manager's queue is a column lookup instead of a 564ms-per-bill recompute.
//
// One definition, three callers (intake, the backfill, and any re-decide). The
// last time this codebase had the same question answered in two places, the two
// answers drifted and the one that drifted was the one that silently found
// nothing (see vendorSearchTerms in gl_classifier).
//
// NOTE what is deliberately NOT stored: the vendor-credit hold. A credit
// recorded next week has to hold a bill that was stored as 'release' today, so
// credits are always evaluated live on top of this column. Store what's fixed
// (the recurrence verdict); overlay what moves (credits).
// ============================================================================
const { getRecurrenceProfile } = require('./recurring');
const { approvalPath } = require('./approval_policy');

/**
 * @returns {{approval_path, approval_path_reason, approval_path_why, approval_path_at}}
 *          — shaped to spread straight into an ap_invoices insert/update.
 */
async function decideApprovalPath({ vendorId, vendorName, communityId, totalCents }) {
  // No credits passed on purpose — see the header. This is the recurrence
  // verdict only.
  const rec = await getRecurrenceProfile({ vendorId, vendorName, communityId, totalCents });
  const p = approvalPath(rec, []);
  return {
    approval_path: p.path,
    approval_path_reason: p.reason || null,
    approval_path_why: p.why || null,
    approval_path_at: new Date().toISOString(),
  };
}

module.exports = { decideApprovalPath };
