// ============================================================================
// lib/payments/brand.js — Bedrock Pay.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "what if we call it Bedrock Pay" and "i want the association to
// be the vendor of record."
//
// Both, and they are different layers. Keeping them straight is the whole point
// of this file existing rather than the name being sprinkled through templates.
//
//   THE EXPERIENCE is ours.        The portal tile, the button, the receipt, the
//                                  confirmation email, the success page. This is
//                                  what a homeowner at Canyon Gate and one at
//                                  Waterview both recognise, and it is the same
//                                  everywhere. That is Bedrock Pay.
//
//   THE MERCHANT is the association. on_behalf_of on the Stripe charge, set in
//                                  lib/payments/stripe.js. Their legal name on
//                                  the checkout page, their name on the card
//                                  statement, their account bearing a dispute.
//
// The second one is not branding, it is substance. A rental agreement is between
// the renter and the ASSOCIATION; Bedrock signs it as managing agent. If a
// renter disputes a $400 deposit, the party to that agreement should defend it
// on their own account, out of their own money. Putting Bedrock's name there
// would mean standing personally behind somebody else's contract — the opposite
// of how Ed signs everything else.
//
// So the pitch a board hears is: one experience across every community, and
// seven completely separate sets of books underneath. Nothing pooled, nothing
// commingled. The incumbents do not do the second half.
//
// NAMING RULE: "Bedrock Pay" names the WAY a payment is made, never the party
// being paid. "Pay <Association> with Bedrock Pay" is right. "Pay Bedrock Pay"
// is wrong, and would undo the distinction this file exists to hold.
// ============================================================================

const PAY_BRAND = 'Bedrock Pay';

/** The button a homeowner clicks to start a payment. */
function payButtonLabel({ canTakePayment = true } = {}) {
  // An association that takes a check is a normal association, not a broken
  // one — so the no-Stripe path gets its own honest label rather than a
  // disabled payment button.
  return canTakePayment ? 'Reserve & Pay →' : 'Reserve →';
}

/** What we say while handing off to Stripe. Names who is being paid. */
function redirectingLabel(associationName) {
  return associationName
    ? `Taking you to ${PAY_BRAND} to pay ${associationName}…`
    : `Taking you to ${PAY_BRAND}…`;
}

/**
 * The line that explains where the money goes, in a homeowner's words.
 *
 * Worth saying out loud on the page. "Your money goes to your association, not
 * to the management company" is the single most reassuring thing a homeowner
 * can read before typing a card number, and almost nobody says it.
 */
// Association legal names end in "Inc." or "LLC." far more often than not, so
// anything that follows one with a full stop produces "…Association, Inc.."
// That is small, and it appears directly under a card form, which is precisely
// where a homeowner is deciding whether this looks like a real payment page.
function endSentence(name) {
  return /[.!?]$/.test(String(name || '').trim()) ? name : `${name}.`;
}

function settlementNote(associationName) {
  return associationName
    ? `Payments go directly to ${endSentence(associationName)} ${PAY_BRAND} never holds your association's money.`
    : `Payments go directly to your association. ${PAY_BRAND} never holds your association's money.`;
}

/** Receipt / confirmation heading. */
function receiptHeading(associationName) {
  return associationName ? `Receipt from ${associationName}` : 'Receipt';
}

/** The small print under a receipt, naming the rail without claiming the money. */
function receiptFooter(associationName) {
  const who = associationName || 'your association';
  return `Paid to ${endSentence(who)} through ${PAY_BRAND}, Bedrock Association Management's payment service. `
    + `${endSentence(who)} is the merchant of record for this payment.`;
}

/**
 * Card-statement descriptor suffix — what a homeowner sees on their statement
 * NEXT to the association's name.
 *
 * With on_behalf_of set, the association's name leads. So the suffix should say
 * what the charge was FOR, not repeat who it was to. "WATERVIEW ESTATES*
 * CLUBHOUSE" reads correctly three weeks later; "WATERVIEW* WATERVIEW" does not.
 *
 * Stripe allows 22 characters, letters/numbers/spaces only.
 */
function statementSuffix(what) {
  return String(what || 'AMENITY')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    .slice(0, 22) || 'AMENITY';
}

module.exports = {
  PAY_BRAND,
  payButtonLabel,
  redirectingLabel,
  settlementNote,
  receiptHeading,
  receiptFooter,
  statementSuffix,
};
