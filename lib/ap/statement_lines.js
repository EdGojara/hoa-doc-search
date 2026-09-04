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

// ============================================================================
// PRIOR-PERIOD RESTATEMENT (the other pattern — Ed 2026-09-04)
// ----------------------------------------------------------------------------
// Some vendors don't net; they RESTACK. Fort Bend County Sheriff's Office bills
// the current month AND re-lists the two prior months as POSITIVE "Outstanding
// Invoice" lines, and re-lists the same mid-year true-up credit every month —
// even after it's been paid/taken. Unlike the statement case above, the negatives
// don't name a payment, so classifyStatement doesn't fire, and with no payment
// history during the Vantaca cutover Emma can't tell the priors are already paid.
// Left alone she'd pay the whole stack (a Sheriff bill: $37,690 instead of the
// $14,230 current month).
//
// Scar (Ed 2026-09-04, Sheriff 26-11S / 26-12S): "they for some reason put these
// on even when they are already paid so emma should only pay the current month."
//
// Rule: if a bill carries a current-service line AND one or more prior-period
// restatement lines (wording names a prior/outstanding/past-due invoice) or a
// re-listed adjustment (true-up / mid-year / retro), flag it. The current-month
// payable is the sum of the lines that are NEITHER prior-period NOR adjustment.
// We do NOT auto-reduce the payable — a human confirms and applies the hold
// (POST .../hold-prior-periods), because "already paid" is a judgment we can't
// make from the bill alone until history is loaded.
// ============================================================================

// Positive line whose wording names a prior/outstanding/past-due invoice.
const PRIOR_PERIOD_RX = /\boutstanding\s+invoice|\bpast[\s-]*due|\bprior\s+(?:balance|period|invoice|month)|\bbalance\s+forward|\barrears|\bprevious\s+invoice\b/i;
// Any line that is a re-listed period adjustment (held during cutover).
const ADJUSTMENT_RX = /\btrue[\s-]*up|\bmid[\s-]*year|\bretro(?:active)?\b|\bprior[\s-]*period\s+adjustment/i;

function isPriorPeriodLine(l) { return cents(l) > 0 && PRIOR_PERIOD_RX.test(desc(l)); }
function isAdjustmentLine(l) { return ADJUSTMENT_RX.test(desc(l)); }
// A line held under restatement handling: prior-period restack OR re-listed adj.
function isHeldRestatementLine(l) { return isPriorPeriodLine(l) || isAdjustmentLine(l); }

// Classify a bill for the restatement pattern. Returns:
//   { is_restatement, held_line_numbers:Set, held_line_ids:[], held_cents,
//     current_cents, prior_period_count, has_adjustment, isHeldLine(l) }
function classifyRestatement(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const priorPeriod = arr.filter(isPriorPeriodLine);
  // Only a restatement if there's at least one prior-period restack AND at least
  // one current line to actually pay (a positive line that is not held).
  const heldSet = arr.filter(isHeldRestatementLine);
  const currentLines = arr.filter((l) => cents(l) > 0 && !isHeldRestatementLine(l));
  const isRestatement = priorPeriod.length > 0 && currentLines.length > 0;
  const heldNumbers = new Set();
  const heldIds = [];
  let heldCents = 0;
  if (isRestatement) {
    for (const l of heldSet) {
      if (l.line_number != null) heldNumbers.add(l.line_number);
      if (l.id != null) heldIds.push(l.id);
      heldCents += cents(l);
    }
  }
  const currentCents = isRestatement ? currentLines.reduce((s, l) => s + cents(l), 0) : 0;
  return {
    is_restatement: isRestatement,
    held_line_numbers: heldNumbers,
    held_line_ids: heldIds,
    held_cents: heldCents,               // net of held lines (may be negative from a credit)
    current_cents: currentCents,         // the current-month payable
    prior_period_count: priorPeriod.length,
    has_adjustment: arr.some(isAdjustmentLine),
    isHeldLine: (l) => isRestatement && isHeldRestatementLine(l),
  };
}

module.exports = {
  classifyStatement, isPriorPaymentLine, PAYMENT_RX,
  classifyRestatement, isPriorPeriodLine, isAdjustmentLine, isHeldRestatementLine,
  PRIOR_PERIOD_RX, ADJUSTMENT_RX,
};
