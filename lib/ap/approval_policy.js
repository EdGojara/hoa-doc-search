// ============================================================================
// lib/ap/approval_policy.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// WHICH approval path does this bill take? Encoded from Ed's rule:
//
//   "Release approve  — consistent with expectations AND recurring.
//    Manager approve  — not consistent with expectations, or one-off.
//    I still release all payments before checks can be cut or ACH made."
//
// Most software runs the same ceremony on every transaction. That isn't a
// stronger control — it's a weaker one: ask for the same signature on 200
// identical landscaping bills and you train the reviewer to click, and the
// ceremony is worthless on the one that mattered. Attention is finite; spend it
// where it changes an outcome. (project_risk_proportionate_controls.)
//
// The relaxation is NOT "recurring = safe" — that is the classic AP fraud
// vector (amount creep on a trusted vendor; a fake vendor built to look
// recurring). It is "recurring AND consistent = safe; recurring AND changed =
// look." The anomaly check is load-bearing, not decoration.
//
// Ed releases either way. The path decides whether a manager must vouch FIRST.
// ============================================================================

/**
 * @param {{recurring:boolean, cadence:string, amount_flag:string|null,
 *          variance_pct:number|null, typical_cents:number|null,
 *          months_covered:number, one_bill_per_month:boolean}|null} recurrence
 * @returns {{ path:'release'|'manager_review', reason:string, why:string }}
 *   path   — 'release'        : low risk, Ed can release directly
 *            'manager_review' : a manager vouches first, then Ed releases
 *   reason — one line for the operator, in plain language
 *   why    — the short label for the audit note
 */
function approvalPath(recurrence) {
  const r = recurrence || null;
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!r || !r.recurring) {
    return {
      path: 'manager_review',
      reason: 'One-off — no established pattern for this vendor on this community\'s books. A manager confirms it before release.',
      why: 'one-off / no established pattern',
    };
  }

  // Recurring, and we can genuinely compare this bill to the pattern.
  if (r.amount_flag === 'normal') {
    return {
      path: 'release',
      reason: `Recurring ${r.cadence} and consistent with expectations — ${r.months_covered} prior months, typically ${money(r.typical_cents)}. Ready for your release.`,
      why: `recurring ${r.cadence}, consistent with expectations`,
    };
  }
  if (r.amount_flag === 'high') {
    return {
      path: 'manager_review',
      reason: `Recurring, but this one is ${r.variance_pct}% ABOVE the usual ${money(r.typical_cents)} — not consistent with expectations. A manager confirms it before release.`,
      why: `recurring but ${r.variance_pct}% above the usual`,
    };
  }
  if (r.amount_flag === 'low') {
    return {
      path: 'manager_review',
      reason: `Recurring, but this one is ${Math.abs(r.variance_pct)}% below the usual ${money(r.typical_cents)} — not consistent with expectations. A manager confirms it before release.`,
      why: `recurring but ${Math.abs(r.variance_pct)}% below the usual`,
    };
  }

  // Recurring but no amount verdict at all (no comparable history). Recurring
  // alone doesn't clear Ed's bar — he said consistent AND recurring.
  return {
    path: 'manager_review',
    reason: `Recurring ${r.cadence} (${r.months_covered} prior months), but there isn't enough comparable history to tell whether this amount is typical. A manager confirms it before release.`,
    why: 'recurring, amount not verifiable against the pattern',
  };
}

module.exports = { approvalPath };
