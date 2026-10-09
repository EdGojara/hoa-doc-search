// ============================================================================
// lib/ar/aging_reconciliation.js  (Ed 2026-10-08) — PURE
// ----------------------------------------------------------------------------
// The AR aging must tie to GL 1300, explicitly, without changing the accounting.
//
// The aging shows each current owner's NET position aged: their receivable rows
// with every reduction applied (payments, credits, negative rows), and an owner
// whose reductions exceed their charges shows nothing. The GL keeps the gross
// picture: receivable rows in 1300 (Accounts Receivable), owner credit rows in
// 2400 (Prepaid Owners). Both are right; they answer different questions. This
// module computes, from the SAME current-owner ledger rows the aging uses:
//
//   per owner   receivable_cents = sum of rows that are not 'credit'  (GL 1300)
//               credit_cents     = sum of 'credit' rows (negative)    (GL 2400)
//               net_cents        = receivable + credit
//   open charges aged        = sum of max(net, 0)   (what the aging shows)
//   owner credit balances    = sum of min(net, 0)   (owners in credit)
//   = owners' net position   = sum of net
//   + credits carried in 2400, added back = -sum of credit
//   = receivable rows (GL 1300 basis)     = sum of receivable
//   vs GL 1300 as of the date  -> difference, named, never hidden
//
// Nothing is reclassified: a difference is shown, not posted. If a policy ever
// requires owner credit balances to sit in 2400, it is computed from these
// owner-level balances, consistently, not from a report difference.
// ============================================================================

/**
 * @param p.rows        current-owner ledger rows ({ property_id, txn_type, amount_cents, transaction_date })
 * @param p.asOf        'YYYY-MM-DD' (rows after it are excluded)
 * @param p.agingOpenCents  the aging's open-charge total (to prove it equals sum of max(net, 0) + native)
 * @param p.nativeOpenCents open charges trustEd billed natively (ar_charges) that are not in the migrated
 *                       ledger but are in GL 1300 (e.g. certified-letter fees); aged on top, added on both sides
 * @param p.glArCents   GL 1300 balance at asOf (debit +), or null when the account is missing
 * @param p.glPrepaidCents GL 2400 balance at asOf (credit balance as a positive number), or null
 */
function reconcileAgingToGl({ rows = [], asOf, agingOpenCents, nativeOpenCents = 0, glArCents = null, glPrepaidCents = null }) {
  const native = Number(nativeOpenCents) || 0;
  const owners = new Map();
  for (const r of rows) {
    if (!r.property_id) continue;
    if (asOf && String(r.transaction_date || '').slice(0, 10) > asOf) continue;
    const o = owners.get(r.property_id) || { property_id: r.property_id, receivable_cents: 0, credit_cents: 0 };
    const amt = Number(r.amount_cents) || 0;
    if (r.txn_type === 'credit') o.credit_cents += amt; else o.receivable_cents += amt;
    owners.set(r.property_id, o);
  }
  let open = 0; let creditBal = 0; let receivable = 0; let credit = 0;
  const inCredit = [];
  for (const o of owners.values()) {
    o.net_cents = o.receivable_cents + o.credit_cents;
    receivable += o.receivable_cents; credit += o.credit_cents;
    if (o.net_cents > 0) open += o.net_cents;
    if (o.net_cents < 0) { creditBal += o.net_cents; inCredit.push(o); }
  }
  inCredit.sort((a, b) => a.net_cents - b.net_cents);
  const net = open + native + creditBal;
  const glBasis = receivable + native;
  const glDiff = glArCents == null ? null : glBasis - glArCents;
  const prepaidDiff = glPrepaidCents == null ? null : -credit - glPrepaidCents;
  return {
    as_of: asOf || null,
    lines: [
      { key: 'open_charges', label: 'Open charges aged (owners who owe)', cents: open + native },
      ...(native ? [{ key: 'native_charges', label: 'of which: charges billed in trustEd (e.g. certified-letter fees)', cents: native, detail: true }] : []),
      { key: 'owner_credit_balances', label: 'Owner credit balances (owners in credit)', cents: creditBal, count: inCredit.length },
      { key: 'net_position', label: 'Owners’ net position', cents: net, subtotal: true },
      { key: 'credits_in_2400', label: 'Add back: owner credits recorded in 2400 Prepaid Owners', cents: -credit },
      { key: 'receivable_rows', label: 'Receivables recorded in GL 1300', cents: glBasis, subtotal: true },
    ],
    gl_ar_cents: glArCents,
    difference_cents: glDiff,
    tied: glDiff === 0,
    // The aging's own total must equal the open charges computed here (same rows, same rules).
    aging_matches_ledger: agingOpenCents == null ? null : agingOpenCents === open + native,
    aging_open_cents: agingOpenCents == null ? null : agingOpenCents,
    prepaid: { subledger_cents: -credit, gl_cents: glPrepaidCents, difference_cents: prepaidDiff,
      note: 'Current-owner credits only; prior-owner credits also sit in 2400 and are listed with former owners.' },
    owners_in_credit: inCredit.map((o) => ({ property_id: o.property_id, receivable_cents: o.receivable_cents, credit_cents: o.credit_cents, net_cents: o.net_cents })),
  };
}

module.exports = { reconcileAgingToGl };
