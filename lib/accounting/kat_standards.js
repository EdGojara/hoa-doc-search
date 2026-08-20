// ============================================================================
// lib/accounting/kat_standards.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// What Kat Reed checks when she reviews a community's books.
//
// EVERY RULE HERE IS A DEFECT THAT ACTUALLY HAPPENED. None are invented from
// general accounting practice, because a standards list nobody has been burned
// by is a list nobody enforces. Each carries the incident that produced it.
//
// Kat's role is REVIEW. She reports and recommends; she never posts, recodes,
// moves money or reverses anything. Every finding names what a person should
// do, and the person decides.
//
// The rule ids are the memory keys — staff_document_reviews.finding_ids — so
// next month can compute "still happening" rather than assert it.
// ============================================================================

const STANDARDS = [
  {
    id: 'interfund_vs_cash',
    title: 'Interfund accounts are not cash accounts',
    rule: 'A transfer between funds moves CASH (1000 Operating, 1100 Savings). '
        + '1810 "Due from Operating to Savings" and 2810 "Due to Savings from Operating" are the two halves of an interfund payable and are NOT the source or destination of a transfer.',
    why: 'LOPF August 2026: the board approved moving $50,000 "from savings (1810) to operations (2810)". '
       + 'Both accounts exist, so it read perfectly plausibly. Booked as written it records a payable rather than moving any money.',
    check_by_hand: 'Any transfer wording naming an 18xx or 28xx account.',
  },
  {
    id: 'cross_community_posting',
    title: 'One association never carries another association\'s expense',
    rule: 'Every posted expense must trace to an invoice belonging to the SAME community. A bill posted to two associations is not a duplicate, it is one association paying for another.',
    why: 'Superior LawnCare invoice 43444 ($476.30) belongs to Quail Ridge and posted to Quail Ridge AND Waterview on 2026-08-01. '
       + 'Both entries live, neither reversed. Waterview\'s landscape expense and accounts payable were each overstated by that amount.',
    check_by_hand: 'Same vendor invoice number appearing under two community_ids.',
    machine_checkable: true,
  },
  {
    id: 'orphan_gl_entry',
    title: 'Every expense entry traces to its invoice and its document',
    rule: 'A posted AP entry must have an ap_invoices row pointing at it, and that invoice must carry its source PDF.',
    why: 'This is the claim Kat makes on camera — "every dollar traces back to the invoice it came from". '
       + 'Verified 2026-08-19 at 86 of 87 live entries. The one exception was the cross-community mispost above.',
    check_by_hand: 'journal_entries where source_module = ap_invoice with no invoice linked.',
    machine_checkable: true,
  },
  {
    id: 'staff_coding_ignored',
    title: 'A staff coding instruction is followed exactly, or the bill is held',
    rule: 'When a staff member forwards a bill with a coding split, every line and amount is used as given. Never pick one account and drop the rest.',
    why: 'Lake Pro invoice 262093: Celina instructed $700 to 5130 and $485.22 to 5140. '
       + 'The whole $1,185.22 went to a single account, and the check stub then read "Emma: loaded from email" so nothing on screen showed the instruction had been lost.',
    check_by_hand: 'Bills whose forwarding note contains two or more account numbers.',
  },
  {
    id: 'magnitude_vs_count',
    title: 'Vendor history is weighed by amount, not just frequency',
    rule: 'When a vendor has both many small jobs and one large recurring contract, the amount decides the account, not the count of prior entries.',
    why: 'Swim Houston\'s $11,064.87 pool-management bill auto-coded to 5370 Splash Pad Repair (median $525) because 18 small repairs outvoted 10 contract payments. '
       + 'The largest bill landed in the smallest-ticket account, at medium confidence with review off.',
    check_by_hand: 'Any coded amount an order of magnitude from that account\'s median.',
  },
  {
    id: 'reserve_transfer_purpose',
    title: 'Money leaving savings or reserves states why',
    rule: 'A transfer out of savings or reserve records its purpose in the same place the amount is recorded.',
    why: 'A year later nobody remembers, and money leaving reserves is the first thing an auditor asks about. '
       + 'The LOPF $50,000 motion recorded the amount and the accounts and no reason at all.',
    check_by_hand: 'Transfers from 1100 / reserve accounts with no narrative.',
  },
  {
    id: 'stale_ar_data',
    title: 'A balance is only as current as the last import',
    rule: 'Never present an owner balance as current when the underlying transactions end weeks earlier. Label it with the date the data actually ends.',
    why: 'On 2026-08-18 every community\'s newest transaction was weeks old and Waterview owners were shown balances derived from data ending 2026-03-01, stamped "As of August 18". '
       + 'A confident wrong number nobody reports.',
    check_by_hand: 'Newest transaction date per community versus today.',
    machine_checkable: true,
  },
  {
    id: 'void_leaves_books_intact',
    title: 'Voiding a payment reverses the payment',
    rule: 'A voided check reverses its journal entry, marks the AP payment void, and reopens the bill. Marking only the register leaves the books saying the cash left.',
    why: 'The void path marked the check register and deliberately left the GL alone, with a note in an API response telling somebody to reverse it separately. '
       + 'The bank rec could never tie and the vendor would never be re-paid.',
    check_by_hand: 'Voided checks whose journal entry is still posted.',
    machine_checkable: true,
  },
];

const BY_ID = Object.fromEntries(STANDARDS.map((s) => [s.id, s]));

/** The block Kat is given when she reviews. Rule ids stay out of her prose. */
function standardsPrompt() {
  return STANDARDS.map((s, i) =>
    `${i + 1}. ${s.title} [${s.id}]\n   RULE: ${s.rule}\n   WHY: ${s.why}`
  ).join('\n\n');
}

module.exports = { STANDARDS, BY_ID, standardsPrompt };
