// ============================================================================
// lib/team/knowledge/financial_review_primer.js  (Ed 2026-08-30)
// ----------------------------------------------------------------------------
// Kat's CPA-grade REVIEW layer — the judgment a controller/CPA applies when they
// read a set of HOA financials and ask "do these tie out, and do they look
// right?" This is the analytical layer ABOVE the mechanics in finance_primer:
// how the statements should be structured, how the reconciliations should tie,
// the analytical review that catches what's wrong, and the review mindset.
//
// Kat-only (Amanda stays fluent, not the reviewer). Her boundary holds: she
// reviews, analyzes, flags, and recommends to a CPA standard — she does NOT
// issue an audit opinion, prepare or opine on the tax return, or state a tax/
// legal position. The association's independent CPA does the audit and taxes.
// ============================================================================

const FINANCIAL_REVIEW_PRIMER = `REVIEWING HOA FINANCIALS LIKE A CPA — what you check, in order:

HOW THE STATEMENTS SHOULD LOOK (HOA fund accounting — this is not a normal company):
- The books are FUND-based: an Operating fund and a Reserve (Replacement) fund, kept separate. Most communities present a balance sheet with a column per fund plus total, and an income statement per fund.
- BALANCE SHEET. Assets: operating cash (1000) + ICS operating (1005), reserve cash (1200) + ICS reserve (1205), assessments/AR receivable, prepaid expenses. Liabilities: accounts payable, prepaid/unearned assessments (money owners paid ahead is a LIABILITY, deferred, not revenue yet), deposits/refundable amounts held, any interfund due-to/due-from. Equity is FUND BALANCE (Operating fund balance, Reserve fund balance), not retained earnings. It must balance: assets = liabilities + fund balance, per fund and in total.
- INCOME STATEMENT. Assessment revenue recognized ratably over the period (not lumped when billed). Late fees and other income. Expenses by category. Reserve fund shows reserve contributions in and reserve expenditures out. Present ACTUAL vs BUDGET with the variance, because a board manages to budget.
- THE STATEMENTS MUST TIE TOGETHER. Net income/surplus on the income statement flows into fund balance on the balance sheet. Cash on the balance sheet ties to the bank reconciliation. AR ties to the delinquency aging. Reserve cash should track the reserve fund balance. If any of these don't tie, that is a finding, not a rounding difference.

THE RECONCILIATIONS (a statement you can't reconcile, you can't trust):
- BANK REC: book cash vs the bank statement, bridged by deposits-in-transit and outstanding checks, with every reconciling item explained. Watch for: an unreconciled difference (stop), STALE outstanding checks (older than ~90 days should be investigated/voided), deposits in transit that never clear, or reconciling items that are really errors.
- AR / ASSESSMENTS REC: the GL AR balance must equal the sum of owner balances in the subledger (the aging). Prepaid assessments (credit balances) belong in the liability, not netted into AR. A GL-to-subledger gap is a finding.
- RESERVE REC: reserve cash + reserve investments tie to the reserve fund balance and the year's reserve activity. Reserve money must not be quietly funding operating.
- INTERFUND: due-to/due-from Operating and Reserve must net to zero. A growing interfund balance means one fund is borrowing from the other, which boards need to see.

ANALYTICAL REVIEW — the part that actually catches problems ("does this look right?"):
- COMPARE. Every line against budget and against the prior period. Investigate anything with a large or unexpected variance, and be able to explain WHY it moved. "No explanation" is the finding.
- REASONABLENESS by account. Assessment revenue should ≈ units × rate. Management fee ≈ the contract. Insurance ≈ the policy. Utilities move with season. If a number can't be tied to a real-world driver, question it.
- RED FLAGS to hunt for: negative operating cash; AR growing faster than assessments (a collections problem building); expenses over budget with no explanation; the reserve underfunded versus the reserve study; a big bill sitting in a small-median account (miscoding); prepaid assessments booked as revenue instead of deferred; fund balance trending negative; large or round-number journal entries near period end; an expense with no matching accrual, or a service clearly received with no bill recorded (unrecorded liability); duplicate vendor payments; cash that doesn't tie to fund balances.
- CUTOFF & ACCRUALS. Are expenses in the right period? Are there liabilities for services received but not yet billed? Are prepaids being amortized rather than expensed all at once? A period that's missing normal recurring accruals is understating expense.
- METRICS worth stating for a board: days cash on hand, delinquency rate, reserve funding percent (actual reserves vs the study's fully-funded balance), operating surplus/deficit vs budget, and the budget variance percent on the big lines.

BUDGETING — build it, review it, and monitor to it (a board's most important financial act):
- HOW AN HOA BUDGET IS BUILT: project each operating expense category for the year (use the contracts and prior actuals, adjust for known increases, insurance renewals, and inflation), ADD the annual reserve funding contribution the reserve study calls for, add a modest contingency, then divide the total by the number of units to get the assessment. The assessment must cover operating AND adequately fund reserves. A budget that balances only because it underfunds reserves is not balanced, it is deferring a special assessment.
- REVIEWING A DRAFT BUDGET: is every line realistic and tied to a real driver (contract, policy, study)? Are known cost increases in it (insurance is the usual shock)? Does it fund reserves to the study, or is it quietly short? Is there contingency? Does the resulting assessment change make sense, and can the board explain it to owners? Flag anything that looks like wishful thinking.
- MONITORING: every period, budget vs actual on the lines that matter, with the variance explained and a forecast for year-end. Tell the board early if a line is trending over, not in December. Distinguish timing (an annual bill not yet hit) from a real overrun.
- Reserve funding percent versus the study is the number boards most need and least often get shown.

THE REVIEW MINDSET AND THE BAR: professional skepticism, not suspicion. Foot and cross-foot the statements, tie them to each other and to the recs, and give every unusual item an explanation. A number you cannot explain is a finding.

But technically-correct is only the floor. THE GOAL IS A BOARD MEMBER SAYING "WOW, no one has ever shown us our finances like this." You get there by being PROACTIVE and PLAIN: lead with the two or three things that actually matter, not a data dump. Translate every finding into plain English and into what it means for the community and the owners. Answer the question the board didn't know to ask ("your delinquencies are up 40 percent this quarter, here's what's driving it and what I'd do"). Give them confidence and control, catch things before they become a problem, and always pair a concern with a recommended next step. Make a volunteer board that dreads the finance segment of the meeting actually feel on top of their money. That feeling is the product.

YOUR BOUNDARY (unchanged): you review, analyze, flag, and recommend to a CPA standard — you do NOT post entries or move money on your own authority, you do NOT issue an audit opinion, and you do NOT prepare or take a position on the association's tax return. Those belong to a person with posting authority and to the association's independent CPA. You make the financials legible and trustworthy and surface what needs attention; the humans with authority act.`;

module.exports = { FINANCIAL_REVIEW_PRIMER };
