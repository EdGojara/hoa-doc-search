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
 *          months_covered:number, one_bill_per_month:boolean,
 *          description_match?:{checked:boolean, matched:boolean|null, summary:string|null}}|null} recurrence
 * @returns {{ path:'release'|'manager_review', reason:string, why:string }}
 *   path   — 'release'        : low risk, Ed can release directly
 *            'manager_review' : a manager vouches first, then Ed releases
 *   reason — one line for the operator, in plain language
 *   why    — the short label for the audit note
 */
function approvalPath(recurrence, openCredits) {
  const r = recurrence || null;
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // A credit this vendor OWES us outranks everything else. Even a perfectly
  // routine recurring bill must not slip out on the light path while the vendor
  // still owes the association money — paying full price is exactly how the
  // credit gets forgotten, quietly, forever. (Swim Houston: pool closed 6/26,
  // Matt agreed to credit the lifeguard time; two invoices were sitting in the
  // queue with nothing connecting them to that promise.)
  const credits = Array.isArray(openCredits) ? openCredits : [];
  if (credits.length) {
    const c = credits[0];
    const amt = c.expected_cents ? ` (${money(c.expected_cents)})` : '';
    return {
      path: 'manager_review',
      reason: `This vendor owes ${credits.length === 1 ? 'a credit' : `${credits.length} credits`} on this community${amt} — ${String(c.reason || '').replace(/\s*\.\s*$/, '')}. Confirm the credit is applied before releasing.`,
      why: `credit expected from vendor${amt}`,
      credit_hold: true,
    };
  }

  if (!r || !r.recurring) {
    return {
      path: 'manager_review',
      reason: 'One-off — no established pattern for this vendor on this community\'s books. A manager confirms it before release.',
      why: 'one-off / no established pattern',
    };
  }

  // Recurring vendor, but THIS bill is for different work than its usual bills
  // (Earthcare #1348: 57 lines of irrigation repairs from the monthly landscape
  // vendor, priced near the monthly bill). Consistent means the same kind of
  // bill, not merely a similar number. (Ed 2026-10-15, lib/ap/bill_pattern.)
  const dm = r.description_match;
  if (dm && dm.checked && dm.matched === false) {
    return {
      path: 'manager_review',
      reason: `Recurring vendor, but this bill doesn't match its usual bills here: ${dm.summary} A manager confirms it before release.`,
      why: 'recurring vendor, but not its usual kind of bill',
    };
  }

  // Release needs PRECEDENT in more than one prior bill: two or more bills
  // within 10% of this amount (the vendor's largest set aside), or this same
  // work described on two or more prior bills. One matching bill is an
  // anecdote, and a bill must never vouch for itself (CLAUDE.md n=1 scar).
  // Profiles computed before this rule (no amount_precedent) keep the old test.
  // (PR #207 review, Ed 2026-10-15.)
  const precedentKnown = r.amount_precedent !== undefined;
  const precedent = !precedentKnown || r.amount_precedent >= 2 || !!(dm && dm.checked && dm.matched && dm.matched_bills >= 2);
  if (r.amount_flag === 'normal' && !precedent) {
    return {
      path: 'manager_review',
      reason: `Recurring ${r.cadence}, but fewer than two prior bills look like this one (amount within 10%, or the same work described). A manager confirms it before release.`,
      why: 'recurring, but not enough precedent for this bill',
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
