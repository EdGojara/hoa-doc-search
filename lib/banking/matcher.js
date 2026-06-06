// ============================================================================
// lib/banking/matcher.js — three-way reconciliation matcher
// ----------------------------------------------------------------------------
// Inputs:
//   - bankTransactions: array from bank_statement_transactions (signed cents)
//   - checkRegisterChecks: array from vantaca check_register extraction
//   - glEntries: array from vantaca GL extraction (signed cents, debits +)
//   - bankEndingCents, glEndingCents — from the source documents
//
// Outputs the line items that populate bank_reconciliation_items, plus a
// summary that becomes bank_reconciliations.* fields:
//
//   matched:              both bank ↔ check register (and ↔ GL when present)
//   outstanding_check:    in register, not on bank → reduces bank balance
//   deposit_in_transit:   on GL deposit side, not on bank → increases bank balance
//   bank_only:            on bank, not on GL (fees/interest/NSF) → add to GL balance
//   gl_only:              on GL, not on bank (timing or error)
//
// Matching passes:
//   1. Exact check-number match: bank check ↔ register check (highest signal)
//   2. Amount + date proximity: bank txn ↔ GL entry within 7 days, same signed amount
//   3. Bank-only categorization: unmatched bank items classified by transaction_type
//   4. Register/GL residuals → outstanding / DIT
//
// The matcher is deterministic and pure — given the same inputs, returns the
// same partition. That keeps the rec auditable across re-runs.
// ============================================================================

const DATE_PROXIMITY_DAYS = 7;     // amount-match windows
const ROUNDING_TOLERANCE_CENTS = 1; // tolerate 1-cent rounding noise

function parseDate(s) {
  if (!s) return null;
  // Accept YYYY-MM-DD or M/D/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T12:00:00Z');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs((a.getTime() - b.getTime()) / 86400000);
}

function normCheckNum(s) {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, '');
  return digits || null;
}

/**
 * @param {object} args
 * @param {Array}  args.bankTransactions      — from bank_statement_transactions
 * @param {Array}  [args.checkRegisterChecks] — from check_register extraction_raw.checks
 * @param {Array}  [args.glEntries]           — from gl_export extraction_raw.entries
 * @param {number} args.bankEndingCents       — period-end bank balance (signed)
 * @param {number} [args.glEndingCents]       — period-end GL balance (signed)
 * @returns {object} match result + summary
 */
function reconcile(args) {
  const {
    bankTransactions = [],
    checkRegisterChecks = [],
    glEntries = [],
    bankEndingCents,
    glEndingCents,
  } = args;

  // Mutable working sets — items get removed as they're matched.
  const bankUnmatched = bankTransactions.map((t, i) => ({ ...t, _idx: 'B' + i, _matched: false }));
  const checksUnmatched = checkRegisterChecks.map((c, i) => ({ ...c, _idx: 'C' + i, _matched: false }));
  const glUnmatched = glEntries.map((g, i) => ({ ...g, _idx: 'G' + i, _matched: false }));

  const items = [];   // array of {category, amount_cents, date, description, check_number, refs, match_method, confidence}

  // -----------------------------------------------------------------------
  // PASS 1 — Exact check-number match
  // Bank checks ↔ register checks. When both sides have a check#, it's the
  // most reliable signal. We also link the GL check entry if amount matches.
  // -----------------------------------------------------------------------
  for (const bt of bankUnmatched) {
    if (bt._matched) continue;
    if (bt.transaction_type !== 'check') continue;
    const bn = normCheckNum(bt.check_number);
    if (!bn) continue;
    const checkMatch = checksUnmatched.find((c) =>
      !c._matched && normCheckNum(c.check_number) === bn
    );
    if (!checkMatch) continue;

    // Try to find the GL entry for the same check number
    const glMatch = glUnmatched.find((g) =>
      !g._matched && normCheckNum(g.check_number) === bn
    );

    bt._matched = true;
    checkMatch._matched = true;
    if (glMatch) glMatch._matched = true;

    items.push({
      category: 'matched',
      amount_cents: bt.amount_cents,
      date_ref: bt.posting_date,
      description: `Check #${bn} — ${checkMatch.payee || bt.description || ''}`.trim(),
      check_number: bn,
      bank_transaction_id: null,                         // resolved at persist time from _idx
      bank_transaction_idx: bt._idx,
      check_register_ref: bn,
      gl_ref: glMatch?.ref || null,
      match_method: 'check_number_exact',
      match_confidence: 'high',
    });
  }

  // -----------------------------------------------------------------------
  // PASS 2 — Amount + date proximity match (bank ↔ GL)
  // For each remaining bank txn, look for a GL entry with the same signed
  // amount within DATE_PROXIMITY_DAYS. This catches non-check items like
  // ACH transfers, wires, and deposits that the GL captured by total.
  // -----------------------------------------------------------------------
  for (const bt of bankUnmatched) {
    if (bt._matched) continue;
    const btDate = parseDate(bt.posting_date);
    const candidates = glUnmatched.filter((g) =>
      !g._matched
      && Math.abs(g.amount_signed_cents - bt.amount_cents) <= ROUNDING_TOLERANCE_CENTS
      && daysBetween(btDate, parseDate(g.posting_date)) <= DATE_PROXIMITY_DAYS
    );
    // Take the closest-date single match. If multiple at same date, skip
    // (ambiguous) and let operator review.
    if (candidates.length === 1) {
      const glMatch = candidates[0];
      bt._matched = true;
      glMatch._matched = true;
      items.push({
        category: 'matched',
        amount_cents: bt.amount_cents,
        date_ref: bt.posting_date,
        description: bt.description || glMatch.description || '',
        check_number: null,
        bank_transaction_idx: bt._idx,
        check_register_ref: null,
        gl_ref: glMatch.ref || null,
        match_method: 'amount_date_proximity',
        match_confidence: 'medium',
      });
    }
  }

  // -----------------------------------------------------------------------
  // PASS 3 — Bank-only items (fees / interest / NSF not on GL)
  // Bank items still unmatched are typically bank-side adjustments that
  // need to be posted to the GL. These ADD to the GL balance side of the
  // reconciliation (i.e., the GL needs to catch up to them).
  // -----------------------------------------------------------------------
  for (const bt of bankUnmatched) {
    if (bt._matched) continue;
    items.push({
      category: 'bank_only',
      amount_cents: bt.amount_cents,
      date_ref: bt.posting_date,
      description: bt.description || '',
      check_number: normCheckNum(bt.check_number),
      bank_transaction_idx: bt._idx,
      check_register_ref: null,
      gl_ref: null,
      match_method: null,
      match_confidence: 'medium',
    });
    bt._matched = true;
  }

  // -----------------------------------------------------------------------
  // PASS 4 — Outstanding checks (in register, not on bank)
  // Issued + not yet cleared. Subtract from bank balance side.
  // Voided checks don't count (they're not real liabilities).
  // -----------------------------------------------------------------------
  for (const c of checksUnmatched) {
    if (c._matched) continue;
    if (c.status === 'voided' || c.status === 'stopped') continue;
    if (!c.amount_cents) continue;
    items.push({
      category: 'outstanding_check',
      amount_cents: -Math.abs(c.amount_cents),    // negative — reduces bank-side balance
      date_ref: c.issue_date,
      description: `Outstanding check #${c.check_number || '?'} — ${c.payee || ''}`.trim(),
      check_number: normCheckNum(c.check_number),
      bank_transaction_idx: null,
      check_register_ref: normCheckNum(c.check_number),
      gl_ref: null,
      match_method: null,
      match_confidence: 'high',
    });
    c._matched = true;
  }

  // -----------------------------------------------------------------------
  // PASS 5 — GL-only items
  // Remaining GL entries. Deposits (positive) become deposits_in_transit
  // (on book side, not yet on bank). Negatives become gl_only and warrant
  // operator review (could be timing on a check that hasn't cleared and
  // wasn't on the register either, or a GL error).
  // -----------------------------------------------------------------------
  for (const g of glUnmatched) {
    if (g._matched) continue;
    if (g.entry_type === 'deposit' && g.amount_signed_cents > 0) {
      items.push({
        category: 'deposit_in_transit',
        amount_cents: g.amount_signed_cents,
        date_ref: g.posting_date,
        description: g.description || 'Deposit in transit',
        check_number: null,
        bank_transaction_idx: null,
        check_register_ref: null,
        gl_ref: g.ref || null,
        match_method: null,
        match_confidence: 'medium',
      });
    } else {
      items.push({
        category: 'gl_only',
        amount_cents: g.amount_signed_cents,
        date_ref: g.posting_date,
        description: g.description || '',
        check_number: normCheckNum(g.check_number),
        bank_transaction_idx: null,
        check_register_ref: null,
        gl_ref: g.ref || null,
        match_method: null,
        match_confidence: 'low',
      });
    }
    g._matched = true;
  }

  // -----------------------------------------------------------------------
  // SUMMARY
  // -----------------------------------------------------------------------
  const sum = (cat) => items
    .filter((i) => i.category === cat)
    .reduce((acc, i) => acc + i.amount_cents, 0);

  const outstanding_checks_total = sum('outstanding_check');         // negative cents
  const deposits_in_transit_total = sum('deposit_in_transit');      // positive cents
  const bank_only_total = sum('bank_only');                         // signed cents
  const gl_only_total = sum('gl_only');                             // signed cents

  // Reconciled balance (bank side):
  //   bank_ending + outstanding_checks (negative) + DIT (positive)
  // The bank-only items are not part of the bank-side calc — they represent
  // what the GL needs to catch up to (the bank already has them).
  const reconciled_balance = bankEndingCents != null
    ? bankEndingCents + outstanding_checks_total + deposits_in_transit_total
    : null;

  // Book-side calc (the side that should match reconciled_balance):
  //   gl_ending + bank_only items (the GL doesn't have them yet) - gl_only items?
  // Standard rec: GL needs to add unrecorded bank items (interest, fees).
  // gl_only items are anomalies — they should NOT be subtracted from the
  // GL to "make it balance" because that would mask real timing/error issues.
  // We expose them as their own line and let the operator decide.
  const adjusted_gl_balance = glEndingCents != null
    ? glEndingCents + bank_only_total
    : null;

  const difference = (reconciled_balance != null && adjusted_gl_balance != null)
    ? reconciled_balance - adjusted_gl_balance
    : null;

  return {
    items,
    summary: {
      bank_ending_balance_cents: bankEndingCents,
      gl_ending_balance_cents: glEndingCents,
      outstanding_checks_total_cents: outstanding_checks_total,
      deposits_in_transit_total_cents: deposits_in_transit_total,
      bank_only_adjustments_cents: bank_only_total,
      gl_only_adjustments_cents: gl_only_total,
      reconciled_balance_cents: reconciled_balance,
      adjusted_gl_balance_cents: adjusted_gl_balance,
      difference_cents: difference,
      balanced: difference != null && Math.abs(difference) <= ROUNDING_TOLERANCE_CENTS,
      counts: {
        matched: items.filter((i) => i.category === 'matched').length,
        outstanding_check: items.filter((i) => i.category === 'outstanding_check').length,
        deposit_in_transit: items.filter((i) => i.category === 'deposit_in_transit').length,
        bank_only: items.filter((i) => i.category === 'bank_only').length,
        gl_only: items.filter((i) => i.category === 'gl_only').length,
      },
    },
  };
}

module.exports = { reconcile };
