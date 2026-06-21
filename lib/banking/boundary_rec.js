// ============================================================================
// lib/banking/boundary_rec.js — boundary (timing) bank reconciliation
// ----------------------------------------------------------------------------
// A bank reconciliation stated the way an accountant reads it, not as a
// per-transaction matching puzzle:
//
//     book (GL cash) − bank = deposits in transit − outstanding checks
//
// For Vantaca-migrated months the deposit side is unambiguous from the Payout
// Contents: an online payment clears the bank on its PAYOUT date, so a payment
// transacted on/before period-end but paid out AFTER it is a deposit in transit.
// That ties to the penny (it's the authoritative settlement key). What the
// payout key can't see — physical check deposits with their own lag, plus any
// genuine bookkeeping difference — falls out as a RESIDUAL that's surfaced for
// human review rather than force-matched.
//
//   boundaryReconcile({ periodEnd, bookCents, bankCents, payouts }) -> summary
//
// payouts: rows from bank_rec_payouts (trxn_date, payout_date, amount_cents,
// account_ref, txn_type). Positive amounts are payments; fees/refunds are
// negative and settle within their own payout, so they don't sit in transit.
// ============================================================================

const RECONCILED_TOLERANCE_CENTS = 100; // <= $1 noise = effectively tied

function boundaryReconcile({ periodEnd, bookCents, bankCents, payouts = [] }) {
  // Online deposits in transit: payments recorded on/before period-end whose
  // bank payout lands after it. Gross amount — that's what the book carries
  // until the payout date (the fee posts with the payout, after period-end).
  const inTransit = payouts.filter((p) =>
    Number(p.amount_cents) > 0
    && p.trxn_date && p.payout_date
    && p.trxn_date <= periodEnd
    && p.payout_date > periodEnd
  );
  const onlineDIT = inTransit.reduce((a, p) => a + Number(p.amount_cents), 0);

  const bookMinusBank = Number(bookCents) - Number(bankCents);
  // Everything the payout key explains is the online DIT; the rest (physical
  // check-deposit timing + any real difference) is the review residual.
  const residual = bookMinusBank - onlineDIT;

  return {
    period_end: periodEnd,
    book_cents: Number(bookCents),
    bank_cents: Number(bankCents),
    book_minus_bank_cents: bookMinusBank,
    online_in_transit_cents: onlineDIT,
    online_in_transit_items: inTransit
      .slice()
      .sort((a, b) => String(a.payout_date).localeCompare(String(b.payout_date)))
      .map((p) => ({
        account_ref: p.account_ref || null,
        amount_cents: Number(p.amount_cents),
        trxn_date: p.trxn_date,
        payout_date: p.payout_date,
      })),
    residual_cents: residual,
    reconciled: Math.abs(residual) <= RECONCILED_TOLERANCE_CENTS,
  };
}

module.exports = { boundaryReconcile, RECONCILED_TOLERANCE_CENTS };
