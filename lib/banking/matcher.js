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

// Batched-deposit matching (one bank credit ↔ many register/GL deposits).
// Vantaca records each homeowner payment individually but deposits them to the
// bank in batches (a single "VANTACA - PAYOUT" credit covers several payments).
const BATCH_DATE_WINDOW_DAYS = 14;  // individual payments precede the batch deposit
const BATCH_TOLERANCE_CENTS = 2;    // small slack for cross-item rounding
const MAX_BATCH_SIZE = 12;          // cap on constituents per batch
const MAX_SUBSET_NODES = 400000;    // exploration cap — give up gracefully past this

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

// True when a register/GL deposit (gDate) could be part of a bank batch that
// posted on bDate. Individual payments come in on/before the batch hits the
// bank; allow a small forward slack for same-day/next-day posting noise.
function withinBatchWindow(gDate, bDate) {
  if (!gDate || !bDate) return false;
  const days = (bDate.getTime() - gDate.getTime()) / 86400000;
  return days >= -2 && days <= BATCH_DATE_WINDOW_DAYS;
}

// Bounded subset-sum. Returns the smallest subset of `pool` whose
// amount_signed_cents sums to `target` within `tolerance`, or null. Iterative
// deepening by size (prefer the fewest constituents); deterministic given the
// caller's pool order. Sorted descending for aggressive pruning, with a hard
// node cap so a pathological pool can't hang the matcher.
function findSubsetSum(pool, target, tolerance) {
  const cand = pool.slice().sort((a, b) => b.amount_signed_cents - a.amount_signed_cents);
  const n = cand.length;
  const amts = cand.map((c) => c.amount_signed_cents);
  const suffix = new Array(n + 1).fill(0);       // suffix[i] = sum of amts[i..n-1]
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + amts[i];
  let nodes = 0;

  function search(start, remaining, sum, picked) {
    if (++nodes > MAX_SUBSET_NODES) return null;
    if (remaining === 0) return Math.abs(sum - target) <= tolerance ? picked.slice() : null;
    for (let i = start; i + remaining <= n; i++) {
      const next = sum + amts[i];
      if (next - target > tolerance) continue;   // overshoots; smaller items sit later, keep scanning
      // largest achievable from here = next + the (remaining-1) largest items after i
      const maxRest = next + (suffix[i + 1] - suffix[i + remaining]);
      if (maxRest + tolerance < target) break;   // even the largest can't reach target (sorted desc) → stop
      picked.push(cand[i]);
      const r = search(i + 1, remaining - 1, next, picked);
      if (r) return r;
      picked.pop();
    }
    return null;
  }

  for (let k = 2; k <= Math.min(MAX_BATCH_SIZE, n); k++) {
    const r = search(0, k, 0, []);
    if (r) return r;
  }
  return null;
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
    vantacaPayouts = [],     // Vantaca Pay settlement detail (online side)
    bankEndingCents,
    glEndingCents,
  } = args;

  // Group Vantaca Pay settlement items by payout date — the NET of each date's
  // payments/fees/refunds is the ACH credit that should appear on the bank.
  const payoutByDate = {};
  for (const p of vantacaPayouts) { if (p && p.payout_date) (payoutByDate[p.payout_date] = payoutByDate[p.payout_date] || []).push(p); }
  const payoutGroups = Object.keys(payoutByDate).map((d) => ({
    payout_date: d,
    net_cents: payoutByDate[d].reduce((s, x) => s + (Number(x.amount_cents) || 0), 0),
    items: payoutByDate[d],
    _used: false,
  }));

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
  // PASS 2.4 — Vantaca Pay payout match (authoritative online batching).
  // The payout-contents report tells us exactly which payments settled on each
  // payout date and the net (after dispute fees / refunds). Match each bank
  // "VANTACA - PAYOUT" credit to its payout-date group by net amount, and clear
  // the corresponding online deposits from the book side so they don't show as
  // in transit. Settlement splits (group net ≠ a single bank credit) simply
  // don't match here and fall through to review — by design, not forced.
  // -----------------------------------------------------------------------
  for (const bt of bankUnmatched) {
    if (bt._matched) continue;
    if (!(bt.amount_cents > 0)) continue;
    if (!/vantaca|payout/i.test(bt.description || '')) continue;
    const btDate = parseDate(bt.posting_date);
    let grp = payoutGroups.find((g) => !g._used && g.payout_date === bt.posting_date && Math.abs(g.net_cents - bt.amount_cents) <= ROUNDING_TOLERANCE_CENTS);
    if (!grp) grp = payoutGroups.find((g) => !g._used && Math.abs(g.net_cents - bt.amount_cents) <= ROUNDING_TOLERANCE_CENTS && daysBetween(parseDate(g.payout_date), btDate) <= 4);
    if (!grp) continue;
    grp._used = true;
    bt._matched = true;
    // Clear the corresponding book-side online deposits (prefer account-ref
    // match, then same-amount non-check entries) so they don't become DIT.
    const pmts = grp.items.filter((i) => Number(i.amount_cents) > 0);
    for (const pmt of pmts) {
      let pick = pmt.account_ref ? glUnmatched.find((g) => !g._matched && g.amount_signed_cents === pmt.amount_cents && (g.description || '').includes(pmt.account_ref)) : null;
      if (!pick) pick = glUnmatched.find((g) => !g._matched && g.amount_signed_cents === pmt.amount_cents && !/check\s*#/i.test(g.description || ''));
      if (!pick) pick = glUnmatched.find((g) => !g._matched && g.amount_signed_cents === pmt.amount_cents);
      if (pick) pick._matched = true;
    }
    const hasAdj = grp.items.some((i) => Number(i.amount_cents) < 0);
    items.push({
      category: 'matched',
      amount_cents: bt.amount_cents,
      date_ref: bt.posting_date,
      description: `Vantaca Pay payout — ${pmts.length} payment${pmts.length === 1 ? '' : 's'}${hasAdj ? ' (net of fees/refunds)' : ''}`,
      check_number: null,
      bank_transaction_idx: bt._idx,
      check_register_ref: null,
      gl_ref: grp.items.map((i) => i.account_ref).filter(Boolean).join(', ') || null,
      match_method: 'vantaca_payout',
      match_confidence: 'high',
    });
  }

  // -----------------------------------------------------------------------
  // PASS 2.5 — Batched-deposit match (one bank credit ↔ many GL deposits)
  // Vantaca records each homeowner payment individually in the deposit register
  // but deposits them to the bank in batches, so a single "VANTACA - PAYOUT"
  // credit can cover several payments. A 1:1 matcher leaves every individual
  // payment as a permanent deposit_in_transit that never clears. Here, for each
  // unmatched bank deposit, we find a SUBSET of unmatched GL deposit entries
  // (within a date window) that sums to it, and clear them together.
  // -----------------------------------------------------------------------
  for (const bt of bankUnmatched) {
    if (bt._matched) continue;
    if (!(bt.amount_cents > 0)) continue;            // deposits only
    const btDate = parseDate(bt.posting_date);
    const pool = glUnmatched.filter((g) =>
      !g._matched
      && g.amount_signed_cents > 0
      && (g.entry_type === 'deposit' || g.entry_type == null)
      && withinBatchWindow(parseDate(g.posting_date), btDate)
    );
    if (pool.length < 2) continue;                   // a batch implies ≥2 parts
    const subset = findSubsetSum(pool, bt.amount_cents, BATCH_TOLERANCE_CENTS);
    if (!subset || subset.length < 2) continue;
    bt._matched = true;
    subset.forEach((g) => { g._matched = true; });
    items.push({
      category: 'matched',
      amount_cents: bt.amount_cents,
      date_ref: bt.posting_date,
      description: `Batched deposit — ${subset.length} payments (${bt.description || ''})`.trim(),
      check_number: null,
      bank_transaction_idx: bt._idx,
      check_register_ref: null,
      gl_ref: subset.map((g) => g.ref).filter(Boolean).join(', ') || null,
      match_method: 'batch_deposit',
      match_confidence: subset.length <= 4 ? 'high' : 'medium',
    });
  }

  // -----------------------------------------------------------------------
  // PASS 2.7 — Ambiguous 1:1 (same amount repeats — e.g. many $260 dues).
  // Runs AFTER batch matching so batched payouts get first claim on their
  // grouped payments. For each still-unmatched bank txn, match the closest-date
  // register/GL entry of equal amount; flagged 'low' confidence so the operator
  // can confirm which identical payment it was. Without this, every repeated
  // dues payment would sit forever as a deposit_in_transit.
  // -----------------------------------------------------------------------
  for (const bt of bankUnmatched) {
    if (bt._matched) continue;
    const btDate = parseDate(bt.posting_date);
    const cands = glUnmatched.filter((g) =>
      !g._matched
      && Math.abs(g.amount_signed_cents - bt.amount_cents) <= ROUNDING_TOLERANCE_CENTS
      && daysBetween(btDate, parseDate(g.posting_date)) <= BATCH_DATE_WINDOW_DAYS
    );
    if (!cands.length) continue;
    cands.sort((a, b) => daysBetween(btDate, parseDate(a.posting_date)) - daysBetween(btDate, parseDate(b.posting_date)));
    const glMatch = cands[0];
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
      match_method: 'amount_date_ambiguous',
      match_confidence: 'low',
    });
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
