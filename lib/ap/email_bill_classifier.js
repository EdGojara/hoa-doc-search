// ============================================================================
// lib/ap/email_bill_classifier.js  (Ed 2026-07-14)
// ----------------------------------------------------------------------------
// Reads a vendor email and decides what to DO with it, so Emma's inbox can flow
// into payables in bulk instead of one manual link at a time. Two questions:
//
//   1) disposition — is this money ALREADY OUT the door, or is it a bill we owe?
//        'already_paid' : autopay / ACH-draft / "successfully charged"
//                         confirmations. Record Dr expense / Cr cash. No check.
//        'payable'      : an invoice / payment request. Load to payables for
//                         approval + (unless the vendor auto-drafts) a check.
//        'review'       : not clearly a bill (spending summary, receipt, reply)
//                         — leave for a human, never post.
//   2) method — how did / will the money move: 'ach' | 'card' | 'check' | 'unknown'.
//
// The signal is primarily the EMAIL TEXT — "Auto-Pay Successfully Submitted" is
// itself the ACH signal — because most of these vendors have no payment history
// yet. The caller overlays what history/flags exist (vendors.auto_pay_ach,
// ap_payments) to firm up 'method'. Pure + synchronous so it's unit-testable.
// ============================================================================

// Real-world confirmation phrasings, learned from the Inframark/Starnik water
// bills (Ed 2026-07-20): the subject is "Payment Success", the body says
// "Your payment has been submitted successfully" and "Thank you for your payment
// to BARKER CYPRESS M.U.D.", and the summary says "confirms payment of $X" —
// none of which the original word-order-strict patterns caught, so 4 of 5
// identical confirmations fell through to "not a bill".
const ALREADY_PAID = /\b(auto.?pay|autopay|auto.?draft|autodraft)\b|payment success|thank you for your payment|confirm(s|ed|ing)?\s+(your\s+)?payment|payment\s+(has\s+been\s+|was\s+|been\s+)?(submitted|charged|processed|posted|received|successful|completed)|submitted\s+successfully|successfully\s+(charged|submitted|processed|posted|paid|received|completed)|was (successfully )?charged|(has been|was) (drafted|debited|withdrawn)|draft(ed)? from your account|e-?check (cleared|posted)|payment confirmation|receipt of payment/i;
const PAYABLE = /\binvoice\b|payment request|amount due|balance due|please (pay|remit)|past due|remittance|statement (enclosed|attached)|new bill|bill(ing statement| is ready)|net \d+|due (on|upon) receipt/i;
const NOT_A_BILL = /spending summary|order (confirmation|summary)|your receipt|shipment|newsletter|survey|unsubscribe|password|verify your|account statement is (ready|available) to view$/i;
const CARD = /\b(credit|debit)\s*card\b|card ending|visa|mastercard|amex|charged to (your )?card/i;

// Classify one vendor email. `extracted` is Emma's parse ({ amounts: [...] } etc.).
function classifyBill({ subject = '', bodyText = '', hasPdf = false, extracted = null } = {}) {
  const text = `${subject}\n${bodyText}`;
  const paidHit = ALREADY_PAID.test(text);
  const payableHit = PAYABLE.test(text);
  const notBill = NOT_A_BILL.test(text) && !paidHit && !payableHit;

  let disposition, reason;
  if (notBill) {
    disposition = 'review';
    reason = 'Not clearly a bill or payment — needs a human look.';
  } else if (paidHit && !payableHit) {
    disposition = 'already_paid';
    reason = 'Email confirms the money already moved (autopay / charge confirmation).';
  } else if (payableHit || hasPdf) {
    disposition = 'payable';
    reason = hasPdf && !payableHit ? 'Has an attached bill to load.' : 'Reads as an invoice / payment request.';
  } else if (paidHit) {
    // paidHit AND payableHit both true — a "your invoice was paid" notice. Treat
    // as already paid (the confirmation wins) but say so.
    disposition = 'already_paid';
    reason = 'Mentions an invoice but confirms it was already charged.';
  } else {
    disposition = 'review';
    reason = 'Couldn\'t tell if it\'s a bill or a confirmation.';
  }

  let method = 'unknown';
  if (disposition === 'already_paid') method = CARD.test(text) ? 'card' : 'ach';
  else if (disposition === 'payable') method = 'check'; // default; caller overrides if vendor auto-drafts

  const amounts = extracted && Array.isArray(extracted.amounts) ? extracted.amounts : [];
  return { disposition, method, reason, has_single_amount: amounts.length === 1 };
}

module.exports = { classifyBill };
