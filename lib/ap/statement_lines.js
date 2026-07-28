// ============================================================================
// lib/ap/statement_lines.js  (Ed 2026-07-28)
// ----------------------------------------------------------------------------
// Some vendor "invoices" are really STATEMENTS that span the Vantaca cutover:
// they list the full project cost AND the prior payments already made (and
// already posted in Vantaca), netting to a BALANCE DUE. Those negative lines are
// NOT credits we're owed and must NOT be re-posted in our GL — they're history
// that lives in Vantaca. We record only the balance due (the invoice total).
//
// Scar (Ed 2026-07-28, Saifee Signs 29548): a "Payment 04/24 Check ACH"
// (-$32,017.26) and a "Customer Disc." (-$710) were read as vendor credits; the
// popup said the bill "already carries a credit … worth confirming you're owed"
// and the auto-post was blocked because the lines didn't reconcile to the total.
// The truth: both are prior payments in Vantaca; we only owe the $15,001.13
// balance. Ed: "only include payment of the new amount and leave the rest as
// previously posted in Vantaca."
//
// Rule: if a bill carries ANY prior-payment line (a negative line whose wording
// names a payment — Payment/Paid/Check/ACH/Wire/Remittance/etc.), the whole bill
// is treated as a cutover statement, and EVERY negative line is prior activity
// (Ed confirmed the discount on this bill was a prior payment too). We post the
// balance due (total) and label the negatives as "recorded in Vantaca, not
// posted here." A bill with NO prior-payment line keeps the normal credit
// handling (a genuine current credit still applies).
// ============================================================================

const PAYMENT_RX = /\b(payment|paid|pmt|check\b|cheque|e-?check|ach\b|wire|remit(?:tance)?|autopay|auto-?pay|deposit(?:ed)?|balance\s*forward|prior\s*balance|less\s*payment|amount\s*(?:received|paid))\b/i;

const cents = (l) => Number(l.amount_cents != null ? l.amount_cents : l.cents) || 0;
const desc = (l) => String(l.description || '');

// A prior-payment line: negative AND its wording names a payment.
function isPriorPaymentLine(l) {
  return cents(l) < 0 && PAYMENT_RX.test(desc(l));
}

// Classify a bill's lines. Returns:
//   { is_statement, prior_payment_line_numbers:Set, prior_payment_cents,
//     line_note(l) }  — line_note gives the display note for a negative line.
function classifyStatement(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const hasPriorPayment = arr.some(isPriorPaymentLine);
  const isStatement = hasPriorPayment;
  // On a statement, treat every negative as prior activity (Vantaca history).
  const priorNumbers = new Set();
  let priorCents = 0;
  if (isStatement) {
    for (const l of arr) {
      if (cents(l) < 0) { priorNumbers.add(l.line_number); priorCents += cents(l); }
    }
  }
  return {
    is_statement: isStatement,
    prior_payment_line_numbers: priorNumbers,
    prior_payment_cents: priorCents, // negative total of prior activity
    isPriorLine: (l) => isStatement && cents(l) < 0,
  };
}

module.exports = { classifyStatement, isPriorPaymentLine, PAYMENT_RX };
