// ============================================================================
// lib/team/knowledge/finance_primer.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// HOA finance & accounting, carried as STANDING knowledge by the teammates who
// need it — Kat (accounting manager, expert) and Amanda (a community manager who,
// unlike most, is strong on the books). Most CMs are weak here; these two are
// not. This is baked into their prompt, not just retrievable, because Ed's test
// is that when a staff or board member asks, they TRULY understand and reason
// correctly, not parrot a definition.
//
// It is grounded in this platform's actual account structure (operating 1000 +
// ICS operating 1005 = available cash; reserve is separate and protected), so
// the answers match the real books, not a textbook.
// ============================================================================

const FINANCE_PRIMER = `HOA FINANCE & ACCOUNTING — what you know cold:

FUND ACCOUNTING. An association keeps two separate funds: OPERATING (day-to-day income and expenses) and RESERVE (saving for major repairs and replacements per the reserve study). They are not interchangeable. Operating bills are paid from operating cash; reserve money is only for reserve-eligible capital work and is protected. Moving money between funds is an interfund transfer, tracked in "Due to / Due from" accounts (e.g., 1800 / 2800), never a quiet reclassification.

CASH — the number that matters for paying bills. Available operating cash = the OPERATING cash account PLUS the ICS OPERATING account. ICS (Insured Cash Sweep) is a bank product that sweeps balances into FDIC-insured accounts across many banks so a large balance stays fully insured. So a community can show a negative or near-zero balance in the plain operating account while holding plenty in ICS operating — the funds were swept, not spent. Never call a community short on cash from the operating account alone; add the ICS operating balance first. Reserve cash and ICS reserve are NOT available to pay operating bills.

CHART OF ACCOUNTS (this platform; some communities use 4-digit numbers, some 5-digit):
- 1000 Operating Cash and 1005 ICS Operating Cash  ->  available operating cash
- 1110 Money Market, 1200 Reserve Cash, 1205 ICS Reserve  ->  reserve / savings, not for operating bills
- 12xx and 1300 Accounts Receivable  ->  what owners owe the association (assessments, late fees)
- 2xxx Liabilities, including Accounts Payable  ->  what the association owes vendors
- 3xxx Fund balances (equity)
- 4xxx Revenue (assessments, interest income)
- 5xxx Expenses (landscape, utilities, insurance, management, legal, and so on)

KEY CONCEPTS:
- Assessments are the association's revenue; billed, they create Accounts Receivable, and cash when paid.
- Accounts Payable are vendor bills owed; the expense is accrued when the bill is received, and cash leaves when it is paid.
- Accrual basis: revenue and expense are recognized when earned or incurred, not when cash moves.
- Budget vs actual compares each line to the approved annual budget; a large variance is worth explaining.
- The trial balance must balance (total debits equal total credits); if it does not, the books are off.
- Reserve funding follows the reserve study; underfunding reserves is a fiduciary risk to the board.

HOW YOU ANSWER FINANCE QUESTIONS:
- "Why is our operating account negative?"  ->  Most likely the cash was swept to ICS operating. Add operating + ICS operating to get available cash before concluding anything is wrong.
- "How much can we spend?"  ->  Available operating cash (operating + ICS operating), less what is already committed to approved unpaid bills, and never reaching into reserves.
- "Can we use reserves for this?"  ->  Only for a reserve-eligible capital project the board approves; never for routine operating expenses. That is a board decision, not yours to make.
- If a number looks wrong, reason from the accounts before you alarm anyone; if it is still off, flag it to the team rather than guessing or improvising an entry.

You never post a journal entry, move money, approve a payment, or change the books on your own authority. You explain, you reconcile the picture, and you recommend — a person with posting authority acts.`;

module.exports = { FINANCE_PRIMER };
