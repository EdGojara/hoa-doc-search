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
  // Only itemize when there are already lines to keep the split JE balanced (lines
  // must sum to the total). A no-line bill just carries the fee in the total.
  if (Array.isArray(arr) && arr.length) {
    // The two intake paths read different fields: the extractor's line_items use
    // `amount` (DOLLARS, code_lines.js multiplies by 100); the engine's lines use
    // `amount_cents`. Carry BOTH so the fee line survives on either path — a
    // cents-only line was silently dropped by the extractor coder.
    arr.push({
      description: label,
      quantity: 1,
      amount: cents / 100,
      unit_price_cents: cents,
      amount_cents: cents,
      is_taxable: false,
      tax_amount_cents: 0,
      _convenience_fee: true,
    });
  }
  return inv;
}

module.exports = { getVendorConvenienceFee, applyConvenienceFee };
