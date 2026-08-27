// ============================================================================
// lib/ap/convenience_fee.js  (Ed 2026-07-23)
// ----------------------------------------------------------------------------
// A per-vendor flat "convenience fee" (MUD water districts: $1 per invoice, all
// communities). Both AP intake paths — Emma's email path (commitInvoice) and the
// manual-upload path (createInvoice) — call this so the fee is applied the same
// way no matter how the bill arrives. ONE place, so the two can't drift.
//
// Design: the fee is a real LINE on the invoice (not a silent total bump) so it
// is visible and auditable, and the total goes up by exactly the fee. When the
// bill has no other line items, we only bump the total (a lone "$1 fee" line with
// no water line would leave the split-accrual JE unbalanced).
// ============================================================================

// Read a vendor's convenience-fee config. Degrades to "no fee" if the columns
// aren't there yet (migration 329 not applied) — never throws.
async function getVendorConvenienceFee(supabase, vendorId) {
  if (!vendorId) return { cents: 0, label: null };
  try {
    const { data, error } = await supabase.from('vendors')
      .select('is_mud, convenience_fee_cents').eq('id', vendorId).maybeSingle();
    if (error || !data) return { cents: 0, label: null };
    const cents = Number(data.convenience_fee_cents) || 0;
    if (cents <= 0) return { cents: 0, label: null };
    return { cents, label: data.is_mud ? 'MUD convenience fee' : 'Convenience fee' };
  } catch (_) {
    return { cents: 0, label: null };
  }
}

// Apply a resolved fee to an invoice shape. `inv` may use either the extractor
// shape (line_items / total_cents / subtotal_cents) or the engine shape (lines /
// total_cents / subtotal_cents) — pass the field names you use via `lineKey`.
// Mutates and returns inv. No-op when fee is 0.
function applyConvenienceFee(inv, fee, lineKey /* 'line_items' | 'lines' */) {
  const cents = fee && Number(fee.cents) || 0;
  if (cents <= 0) return inv;
  const label = (fee && fee.label) || 'Convenience fee';
  inv.total_cents = (Number(inv.total_cents) || 0) + cents;
  // Only adjust subtotal when the bill actually tracked one — many bills carry a
  // total with subtotal 0, and fabricating a $1 subtotal there just looks wrong.
  if (Number(inv.subtotal_cents) > 0) inv.subtotal_cents = Number(inv.subtotal_cents) + cents;
  const arr = inv[lineKey];
  // Ed 2026-08-27: a $1 fee is too small to be its own line — it just clutters
  // the bill and the staff email. So DON'T itemize it. Fold it into the largest
  // existing line (the split JE stays balanced because the lines still sum to the
  // total), and record a MEMO explaining the bump. A no-line bill carries the fee
  // in the total alone. The two intake paths use different amount fields — the
  // extractor's line_items use `amount` (DOLLARS); the engine's lines use
  // `amount_cents` — so bump whichever the line has.
  if (Array.isArray(arr) && arr.length) {
    let idx = 0, best = -Infinity;
    arr.forEach((l, i) => {
      const c = l.amount_cents != null ? Number(l.amount_cents) : Math.round((Number(l.amount) || 0) * 100);
      if (c > best) { best = c; idx = i; }
    });
    const line = arr[idx];
    if (line.amount_cents != null) line.amount_cents = Number(line.amount_cents) + cents;
    if (line.amount != null) line.amount = Number(line.amount) + cents / 100;
    if (line.unit_price_cents != null) line.unit_price_cents = Number(line.unit_price_cents) + cents;
    line._convenience_fee_included_cents = cents;
  }
  // The memo that replaces the line item is written by each caller onto the
  // invoice-record notes (lib/ap/intake.js + lib/accounting/ap_engine.js), so the
  // $1-higher total is always explained. This helper only adjusts the numbers.
  return inv;
}

module.exports = { getVendorConvenienceFee, applyConvenienceFee };
