// ============================================================================
// lib/ap/deposit_reconcile.js  (Ed 2026-09-28)
// ----------------------------------------------------------------------------
// PURE reconciliation of a vendor DEPOSIT against the next bill from the same
// vendor + community. No DB, no I/O, never pays, never creates a payable. It
// answers one question for a human reviewer: given what was agreed, what was
// billed and ACTUALLY PAID as deposit, and what this new document says, what is
// the correct net amount still due, and is anything ambiguous?
//
// Trigger: PRYME THYME KOOKERS #2836 (Waterview), a 50% deposit with "balance
// due day of set-up". Ed: "how will Emma know to pay the remaining balance?"
// and "the vendor may send another invoice" in one of four forms:
//   balance_only             the bill is the balance only; the deposit stays
//                            separately paid/posted.
//   full_total_less_deposit  the bill shows the full total with the deposit
//                            credited (or shows the full total and we must net
//                            the deposit ourselves). Never pay the face twice.
//   revised_total            the final total changed (extras, tax, scope).
//                            Always flagged for manager review with the math.
//   duplicate_or_statement   a re-sent deposit invoice or a vendor statement:
//                            linked, never a new payable.
//   ambiguous                can't tell; a person decides.
//
// THE INVARIANT (checked on every result):
//   deposit paid + deposit still owed + net due on this bill = final total
// so across the deposit invoice and the final bill the Association pays the
// final total exactly once, whether or not the deposit has been paid yet.
// Reconcile against ACTUAL payment status (amount_paid_cents), not the mere
// existence of a deposit invoice.
// ============================================================================

const DEFAULT_TOLERANCE_CENTS = 100;   // $1: rounding on a 50% split, not a scope change
const CREDIT_WORDS = /\b(deposit|retainer|advance|prior payment|payment received|paid|less)\b/i;
const EXTRA_WORDS = /\b(tax|fee|extra|additional|overtime|change order|surcharge|delivery|gratuity|service charge)\b/i;

const normNo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
const near = (a, b, tol) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
const money = (c) => (c == null ? 'n/a' : (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toFixed(2));
const int = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

// What the deposit side looks like right now, from the subledger row and the
// deposit invoice's LIVE payment state.
function depositPosition(deposit, depositInvoice) {
  const inv = depositInvoice || {};
  const voided = inv.status === 'voided';
  const billed = voided ? 0 : (int(deposit.deposit_amount_cents) ?? int(inv.total_cents) ?? 0);
  const paid = voided ? 0 : Math.min(int(inv.amount_paid_cents) || 0, billed);
  const stated = int(deposit.remaining_balance_cents);             // "balance due" printed on the deposit bill
  let agreed = int(deposit.agreed_total_cents);
  let agreedBasis = deposit.agreed_total_basis || null;
  if (agreed == null && stated != null) { agreed = billed + stated; agreedBasis = 'derived_from_deposit_invoice'; }
  return {
    voided, billed, paid, still_owed: billed - paid,
    agreed_total_cents: agreed, agreed_total_basis: agreedBasis,
    expected_balance_cents: agreed != null ? agreed - billed : null,
    estimate: agreed != null && !['contract', 'quote'].includes(agreedBasis),
  };
}

/**
 * @param {object} p
 * @param {object} p.deposit          vendor_deposits row
 * @param {object} p.depositInvoice   ap_invoices row of the deposit (live status/amount_paid)
 * @param {object} p.incoming         the new document (ap_invoices-shaped or extracted):
 *                                    { vendor_invoice_number|invoice_number, total_cents, tax_cents,
 *                                      file_sha256, is_deposit_invoice, project_total_cents }
 * @param {Array}  [p.incomingLines]  [{ description, amount_cents }]
 * @param {boolean}[p.isStatement]    vendor statement (lib/ap/statement_lines classifyStatement)
 * @param {number} [p.toleranceCents]
 */
function reconcileDeposit({ deposit, depositInvoice, incoming, incomingLines = [], isStatement = false, toleranceCents = DEFAULT_TOLERANCE_CENTS }) {
  if (!deposit || !incoming) throw new Error('reconcileDeposit: deposit and incoming are required');
  const tol = toleranceCents;
  const pos = depositPosition(deposit, depositInvoice);
  const face = int(incoming.total_cents) || 0;
  const tax = int(incoming.tax_cents) || 0;
  const reasons = [];    // needs a manager's judgment
  const warnings = [];   // informational; still needs the normal human approval
  const math = [];

  const lines = (incomingLines || []).filter((l) => l && int(l.amount_cents) != null);
  const creditShown = -lines.filter((l) => int(l.amount_cents) < 0 && CREDIT_WORDS.test(l.description || ''))
    .reduce((s, l) => s + int(l.amount_cents), 0);
  const otherNegatives = lines.filter((l) => int(l.amount_cents) < 0 && !CREDIT_WORDS.test(l.description || ''));
  const grossLines = lines.filter((l) => int(l.amount_cents) > 0).reduce((s, l) => s + int(l.amount_cents), 0);
  const extras = lines.filter((l) => int(l.amount_cents) > 0 && EXTRA_WORDS.test(l.description || ''))
    .reduce((s, l) => s + int(l.amount_cents), 0);

  const base = {
    agreed_total_cents: pos.agreed_total_cents, agreed_total_basis: pos.agreed_total_basis,
    agreed_total_is_estimate: pos.estimate,
    expected_balance_cents: pos.expected_balance_cents,
    deposit_billed_cents: pos.billed, deposit_paid_cents: pos.paid, deposit_still_owed_cents: pos.still_owed,
    incoming_face_cents: face, credits_shown_cents: creditShown, extras_cents: extras, tax_cents: tax,
  };
  const done = (form, finalTotal, netDue) => {
    if (pos.voided) reasons.push('deposit_invoice_voided');
    if (pos.still_owed > 0 && netDue != null) warnings.push('deposit_not_yet_paid');
    if (pos.estimate && form !== 'duplicate_or_statement' && form !== 'ambiguous') warnings.push('agreed_total_is_an_estimate');
    if (otherNegatives.length) reasons.push('unexplained_credit_lines');
    const variance = finalTotal != null && pos.agreed_total_cents != null ? finalTotal - pos.agreed_total_cents : null;
    if (variance != null && Math.abs(variance) > tol && form !== 'revised_total') reasons.push('final_total_differs_from_agreed');
    // Zero or negative net on a real bill means the vendor owes us (or nothing is
    // due): that is a credit/refund to collect, never an ordinary payable.
    if (netDue != null && netDue <= 0 && form !== 'duplicate_or_statement') reasons.push('net_due_not_positive_credit_or_refund');
    const out = {
      ...base, form,
      final_total_cents: finalTotal, net_due_cents: netDue,
      outstanding_obligation_cents: netDue == null ? null : pos.still_owed + netDue,
      variance_cents: variance,
      reasons: [...new Set(reasons)], warnings: [...new Set(warnings)],
      needs_review: reasons.length > 0 || netDue == null,
      math,
    };
    out.invariant_ok = invariantHolds(out);
    if (!out.invariant_ok) { out.reasons.push('invariant_failed'); out.needs_review = true; }
    return out;
  };

  // ---- 1. The same document again, or a statement: never a new payable. ----
  const incNo = normNo(incoming.vendor_invoice_number || incoming.invoice_number);
  const depNo = normNo(depositInvoice && depositInvoice.vendor_invoice_number);
  const sameFile = incoming.file_sha256 && depositInvoice && incoming.file_sha256 === depositInvoice.file_sha256;
  if ((incNo && depNo && incNo === depNo) || sameFile) {
    math.push(`Same ${sameFile ? 'file' : 'invoice number'} as the deposit invoice: a re-sent or revised copy, not a new bill.`);
    if (face !== pos.billed) reasons.push('revised_copy_amount_differs');
    return done('duplicate_or_statement', null, 0);
  }
  if (isStatement) {
    math.push('Vendor statement: it reports balances, it is not a new bill. Nothing new is payable from it.');
    return done('duplicate_or_statement', null, 0);
  }

  // ---- 2. Another "deposit" of the same amount: second deposit or the completion bill? ----
  if (incoming.is_deposit_invoice && near(face, pos.billed, tol)) {
    reasons.push('looks_like_second_deposit_or_completion');
    math.push(`Billed as a deposit for ${money(face)}, the same as the existing ${money(pos.billed)} deposit. It may be the completion bill (e.g. "50% at completion") or a second deposit; a person must decide.`);
    return done('ambiguous', null, null);
  }

  // ---- 3. The bill carries the deposit as a credit: full total less deposit. ----
  if (creditShown > 0) {
    const gross = grossLines || face + creditShown;
    const vendorNet = gross - creditShown;
    math.push(`Full total ${money(gross)} less deposit credit ${money(creditShown)} = ${money(vendorNet)} on the bill.`);
    if (!near(face, vendorNet, tol)) { reasons.push('face_does_not_equal_total_less_credit'); math.push(`But the bill's total reads ${money(face)}.`); }
    if (!near(creditShown, pos.billed, tol)) reasons.push('credit_differs_from_deposit_billed');
    if (creditShown > pos.paid + tol) {
      reasons.push('vendor_credited_a_deposit_not_yet_paid');
      math.push(`The vendor credited ${money(creditShown)}, but only ${money(pos.paid)} of the deposit has actually been paid; the deposit invoice still owes ${money(pos.still_owed)}.`);
    }
    // Pay the vendor's net; the deposit invoice carries whatever of the deposit is unpaid.
    const netDue = gross - Math.max(creditShown, 0);
    return done('full_total_less_deposit', gross, netDue);
  }

  // ---- 4. No credit shown. Compare to what was expected. ----
  const exp = pos.expected_balance_cents;
  const agreed = pos.agreed_total_cents;
  if (exp != null && near(face, exp, tol)) {
    math.push(`Bill ${money(face)} matches the expected balance ${money(exp)} (${money(agreed)} total less ${money(pos.billed)} deposit billed).`);
    return done('balance_only', pos.billed + face, face);
  }
  if (agreed != null && near(face, agreed, tol)) {
    // Full contract total billed with no deposit credit: net the deposit ourselves.
    reasons.push('full_total_billed_without_deposit_credit');
    math.push(`Bill ${money(face)} equals the full agreed total with no deposit credit. Net due = ${money(face)} less ${money(pos.billed)} deposit billed = ${money(face - pos.billed)}. Do not pay the face amount.`);
    return done('full_total_less_deposit', face, face - pos.billed);
  }
  if (agreed == null) {
    reasons.push('no_agreed_total_to_compare');
    math.push(`No agreed total or stated balance on file, so ${money(face)} can't be classified as a balance or a full total.`);
    return done('ambiguous', null, null);
  }

  // Revised total: decide which reading is closer, and always send to review.
  reasons.push('revised_total');
  const asBalance = { final: pos.billed + face, net: face };
  const asFull = { final: face, net: face - pos.billed };
  const readAsFull = Math.abs(face - agreed) < Math.abs(face - exp);
  const pick = readAsFull ? asFull : asBalance;
  if (readAsFull) reasons.push('read_as_revised_full_total_without_credit');
  math.push(readAsFull
    ? `Bill ${money(face)} is closest to the agreed total ${money(agreed)}: read as a revised FULL total. Net due = ${money(face)} less ${money(pos.billed)} deposit = ${money(pick.net)}.`
    : `Bill ${money(face)} is closest to the expected balance ${money(exp)}: read as a revised BALANCE. Final total = ${money(pos.billed)} deposit + ${money(face)} = ${money(pick.final)}.`);
  math.push(`Change vs agreed: ${money(pick.final - agreed)}${extras ? `; extras/tax on the bill: ${money(extras)}` : ''}.`);
  return done('revised_total', pick.final, pick.net);
}

// paid + still owed + net due must equal the final total (when both are known).
function invariantHolds(r) {
  if (r.form === 'duplicate_or_statement' || r.form === 'ambiguous') return true;
  if (r.net_due_cents == null || r.final_total_cents == null) return false;
  return r.deposit_paid_cents + r.deposit_still_owed_cents + r.net_due_cents === r.final_total_cents;
}

// Can a reviewer APPROVE this reconciliation against this invoice as it stands?
// The payable must already equal the net due. We never rewrite an AP amount
// here; staff net the deposit on the bill through the normal recode path first.
function approvalBlockers(reconciliation, invoice, { role } = {}) {
  const out = [];
  if (!reconciliation) return ['no_reconciliation'];
  if (reconciliation.form === 'ambiguous') out.push('classify_first');
  if (reconciliation.needs_review && role !== 'admin') out.push('manager_review_required');
  if (['balance_only', 'full_total_less_deposit', 'revised_total'].includes(reconciliation.form)) {
    if (!invoice) out.push('invoice_missing');
    else if (Number(invoice.total_cents) !== Number(reconciliation.net_due_cents)) out.push('invoice_total_not_net_due');
    if (invoice && invoice.status === 'voided') out.push('invoice_voided');
  }
  return out;
}

// A DEPOSIT bill's lines all belong to the deposit (prepaid) account, whatever
// their words say; the line classifier must not re-code them to an expense.
function forceDepositLineCoding(lines, coded) {
  if (!coded || !coded.account_id) return lines;
  return (lines || []).map((l) => ({ ...l, gl_account_id: coded.account_id, needs_review: true, reason: coded.reason || l.reason }));
}

module.exports = { forceDepositLineCoding, reconcileDeposit, depositPosition, invariantHolds, approvalBlockers, DEFAULT_TOLERANCE_CENTS };
