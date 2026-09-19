// evals/cases/bank-reconciliation/case.js
// ---------------------------------------------------------------------------
// Case #2: month-end bank reconciliation for a community operating account.
// This is where a wrong number — or a correction applied in the wrong direction —
// does the most damage, so it's the sharpest test of model reliability.
//
// The scenario is built to TIE at a true reconciled cash balance of $61,910.00:
//   Bank side: 58,910 + 6,200 DIT - 3,200 outstanding checks       = 61,910
//   Book side: 62,200 - 60 fee - 500 NSF + 270 error correction    = 61,910
//
// Planted traps that separate a careful reconciliation from a naive one:
//   * Check #1039 was written/cleared for $1,250 but RECORDED in the books as
//     $1,520 — a $270 overstatement of the disbursement, so book cash is
//     UNDERSTATED and must be INCREASED by $270. Getting the direction backwards
//     is the classic error.
//   * The $500 NSF returned check is a book-side reduction AND means the
//     homeowner's assessment receivable must be reinstated — a downstream catch a
//     strong read (or a cross-check) surfaces, a weak one misses.
//   * The $60 bank fee is a book-side item not yet recorded.
//   * Both adjusted balances must equal $61,910; a model that "balances" without
//     applying every item is wrong even if it states a number.
// ---------------------------------------------------------------------------

const SYSTEM = [
  'You are the bank-reconciliation function of an HOA accounting platform, used by a CPA.',
  'Reconcile the bank balance to the book (GL) balance. Produce the adjusted balance for BOTH sides and show they tie. List every reconciling item and every recording ERROR with its dollar amount, which side it adjusts, and the DIRECTION of the adjustment (increase or decrease). Show the arithmetic.',
  'Flag anything downstream that also needs correcting as a result of these items. Do not claim it balances unless your two adjusted balances are actually equal.',
].join(' ');

const PROMPT = `Community: operating account, month-end reconciliation.

Book (GL) cash balance: $62,200.00
Bank statement ending balance: $58,910.00

Known information:
- Deposits in transit (recorded in the books on 6/30, not yet on the bank statement): $6,200.00 (assessment deposit).
- Outstanding checks (recorded in the books, not yet cleared the bank):
    Check #1042  $1,850.00  (landscaping)
    Check #1047  $920.00    (utilities)
    Check #1051  $430.00    (supplies)
- Bank service fee charged by the bank this month: $60.00. This has NOT been recorded in the books.
- NSF (returned) item: a homeowner's assessment check for $500.00 was deposited last month, cleared, and has now bounced. The bank debited $500.00 this month. This has NOT been recorded in the books.
- Recording error: Check #1039 was written and cleared the bank for $1,250.00, but it was entered in the books as $1,520.00.

Reconcile the account. Give the adjusted bank balance and the adjusted book balance, show they tie, list each adjustment with its direction, and flag any downstream correction needed.`;

const RUBRIC = [
  { id: 'true_balance', type: 'number', value: 61910, tolerance: 1, weight: 3, sev: 'catastrophic', desc: 'Reconciled balance ties to $61,910.00' },
  { id: 'outstanding_total', type: 'number', value: 3200, tolerance: 1, weight: 1, sev: 'financial', desc: 'Outstanding checks total $3,200' },
  { id: 'fee', type: 'regex', pattern: '(service fee|bank fee|\\$?60(\\.00)?\\b)[\\s\\S]{0,80}(book|decrease|deduct|reduce|record)|(book|decrease|deduct|reduce|record)[\\s\\S]{0,40}\\$?60\\b', weight: 1, sev: 'operational', desc: 'Records the $60 bank fee against the books' },
  { id: 'nsf', type: 'regex', pattern: '(nsf|returned|bounced)[\\s\\S]{0,80}(500)|\\$?500[\\s\\S]{0,60}(nsf|returned|bounced|deduct|book)', weight: 1, sev: 'financial', desc: 'Deducts the $500 NSF item from the books' },
  { id: 'error_amount', type: 'number', value: 270, tolerance: 1, weight: 2, sev: 'financial', desc: 'Catches the Check #1039 recording error of $270 (1,520 vs 1,250)' },
  { id: 'error_direction', type: 'regex', pattern: '(understat|increase|add|\\+\\s?\\$?270|overstat(ed)? (the )?(disbursement|payment|expense|check))', weight: 2, sev: 'catastrophic', desc: 'Applies the #1039 correction in the RIGHT direction (book cash increased by $270)' },
  { id: 'ar_reinstate', type: 'regex', pattern: '(receivable|\\bA/?R\\b|reinstate|re-?bill|owe|delinqu|homeowner.{0,20}(account|balance))', weight: 2, sev: 'compliance', desc: 'Downstream catch: NSF means the homeowner\'s receivable must be reinstated' },
  { id: 'no_false_balance', type: 'absent', pattern: '(already balance|no adjustments needed|ties without adjustment|reconciles as-is)', weight: 1, sev: 'catastrophic', desc: 'Does NOT claim it balances without applying the items' },
];

module.exports = {
  id: 'bank-reconciliation',
  title: 'Month-end bank reconciliation (operating account)',
  system: SYSTEM,
  prompt: PROMPT,
  maxTokens: 2400,
  rubric: RUBRIC,
  meta: { truth: { reconciled: 61910, outstanding: 3200, error: 270, fee: 60, nsf: 500 } },
};
