// ============================================================================
// lib/ap/dedup.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Duplicate detection for AP invoices. This is the whole reason the intake is a
// single chokepoint: the same bill arrives by email AND as a physical scan, and
// we must not pay it twice. Layers, strongest first:
//
//   1. file_sha256 match         -> CERTAIN  (literally the same file re-uploaded)
//   2. vendor + norm invoice #    -> CERTAIN  (same vendor billing the same number)
//   3. vendor + total + same date -> HIGH     (amount+date match; catches null/typo invoice#)
//   4. vendor + total + date ±7d  -> MEDIUM   (re-sent a few days later)
//
// A CERTAIN match blocks the new payable (it's the same bill). HIGH/MEDIUM are
// SUSPECTED — the invoice still lands, but on_hold and flagged, so a human
// decides. We never silently drop; a duplicate is always visible.
// ============================================================================

// Normalize a vendor invoice number so "INV-01023", "inv 1023", "1023" collapse
// to one key. Uppercase, strip non-alphanumerics, drop leading zeros.
function normInvoiceNo(s) {
  if (s == null) return '';
  const stripped = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return stripped.replace(/^0+(?=\d)/, '');
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
  if (isNaN(da) || isNaN(db)) return Infinity;
  return Math.abs(Math.round((da - db) / 86400000));
}

// Returns { verdict: 'unique'|'suspected'|'certain', matches: [{invoice, reason, confidence}] }
// candidate: { communityId, vendorId, invoiceNumber, totalCents, invoiceDate, fileSha256 }
async function findDuplicates(supabase, candidate) {
  const { communityId, vendorId, invoiceNumber, totalCents, invoiceDate, fileSha256 } = candidate;
  const matches = [];
  const seen = new Set();
  const add = (inv, reason, confidence) => {
    if (!inv || seen.has(inv.id)) return;
    seen.add(inv.id);
    matches.push({ invoice: inv, reason, confidence });
  };

  const COLS = 'id, vendor_invoice_number, invoice_date, total_cents, status, dedup_status, received_at, source_filename';

  // 1) Same file, same community — certain.
  if (fileSha256 && communityId) {
    const { data } = await supabase.from('ap_invoices').select(COLS)
      .eq('community_id', communityId).eq('file_sha256', fileSha256)
      .neq('status', 'voided').limit(5);
    for (const inv of (data || [])) add(inv, 'Same file already on file', 'certain');
  }

  // Pull this vendor's recent invoices in this community once; classify in JS.
  if (vendorId && communityId) {
    const { data } = await supabase.from('ap_invoices').select(COLS)
      .eq('community_id', communityId).eq('vendor_id', vendorId)
      .neq('status', 'voided').order('invoice_date', { ascending: false }).limit(400);
    const rows = data || [];
    const normCand = normInvoiceNo(invoiceNumber);

    for (const inv of rows) {
      // 2) Same normalized invoice number — certain.
      if (normCand && normInvoiceNo(inv.vendor_invoice_number) === normCand) {
        add(inv, `Same vendor + invoice # (${inv.vendor_invoice_number || '—'})`, 'certain');
        continue;
      }
      // 3/4) Same amount + same/near date — suspected (catches null/typo invoice#).
      if (totalCents != null && inv.total_cents === totalCents) {
        const dd = daysBetween(invoiceDate, inv.invoice_date);
        if (dd === 0) add(inv, `Same vendor + amount ($${(totalCents / 100).toFixed(2)}) + same date`, 'high');
        else if (dd <= 7) add(inv, `Same vendor + amount ($${(totalCents / 100).toFixed(2)}) + date within ${dd}d`, 'medium');
      }
    }
  }

  const hasCertain = matches.some((m) => m.confidence === 'certain');
  const hasSuspect = matches.some((m) => m.confidence === 'high' || m.confidence === 'medium');
  const verdict = hasCertain ? 'certain' : hasSuspect ? 'suspected' : 'unique';
  return { verdict, matches };
}

module.exports = { findDuplicates, normInvoiceNo };
