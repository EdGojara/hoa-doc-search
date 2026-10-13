// ============================================================================
// lib/close/policy.js  (Ed 2026-10-12: permanent accrual close policy)
// ----------------------------------------------------------------------------
// Ed: "We use accrual accounting, and expenses and revenue must be recognized in
// their proper accounting periods. No accounting month may be closed until Kat
// has completed a month-end cutoff review and I have approved the close."
//
// The policy is enforced by the existing month-end close (migration 502 +
// lib/close/*), not by a parallel system:
//   * Kat's cutoff review IS the checklist run: recorded by Kat, on an engine
//     that carries the cutoff controls (CUT-*, IF-*) next to the GL, cash, AR, AP,
//     recognition and data-completeness controls.
//   * Only the owner closes a month (API requireOwner + close_period, migration
//     517), and only on the latest run, which must be a Kat cutoff review.
//   * Nothing closes a period automatically and nothing posts an adjustment:
//     Kat proposes; every posting goes through its own approval workflow.
// ============================================================================

const KAT_REVIEWER = 'Kat (AI accountant)';
const CUTOFF_CONTROLS = ['CUT-01', 'CUT-02', 'CUT-03', 'IF-01'];

const CLOSE_POLICY = {
  title: 'Accrual close policy',
  adopted: '2026-10-12',
  adopted_by: 'Ed Gojara (owner)',
  rules: [
    'Books are kept on the accrual basis: revenue and expenses are recognized in the period earned or incurred, not the invoice or payment month.',
    'No accounting month closes until Kat has completed the month-end cutoff review for it and the owner has approved the close.',
    'Kat\'s review verifies: expenses in the period incurred; assessment revenue and delinquent interest in their periods; accrued and prepaid expenses; late-arriving invoices evaluated for prior-period recognition; AP, AR, homeowner subledgers, bank reconciliations and the GL agree; interfund transfers classified and reconciled; material unexplained balances, missing documents and cutoff exceptions identified.',
    'Periods are never closed automatically, and no adjustment is posted without support and its own approval.',
  ],
};

// Kat recorded it: the first word of run_by is Kat (the same test as close_period, migration 517).
const isKatName = (name) => String(name || '').trim().split(/\s+/)[0].toLowerCase() === 'kat';
const reviewerName =(requestedBy) => (requestedBy ? `${KAT_REVIEWER} cutoff review, requested by ${requestedBy}` : `${KAT_REVIEWER} cutoff review`);

// A run counts as Kat's cutoff review when Kat recorded it and it evaluated every
// cutoff control. (Mirrors close_period in migration 517.)
function isKatCutoffReview(run, results) {
  if (!run) return false;
  const codes = new Set((results || run.results || []).map((r) => r.code));
  return isKatName(run.run_by) && CUTOFF_CONTROLS.every((c) => codes.has(c));
}

module.exports = { isKatName, KAT_REVIEWER, CUTOFF_CONTROLS, CLOSE_POLICY, reviewerName, isKatCutoffReview };
