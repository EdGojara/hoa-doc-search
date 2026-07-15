// ============================================================================
// lib/ap/vendor_credits.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Credits a vendor owes us, surfaced at the moment we're about to pay them.
//
// Ed: "Here's an email for Waterview / Swim Houston — I want to forward this to
// Emma and say please make sure we get credit for this on the Swim Houston
// bill. How does that work?"
//
// It works by turning the promise into a CONTROL. Capturing it is easy; the
// whole value is that openCreditsFor() gets asked on every invoice review, so
// nobody can release a Swim Houston bill while Swim Houston owes Waterview for
// three days of lifeguards nobody got. An expected credit that doesn't block a
// payment is just a note.
//
// Vendor matching reuses vendorSearchTerms — the SAME "is this the same vendor?"
// the GL classifier and the recurrence profiler use. A third definition would
// drift, and the one that drifts is the one that silently finds no credit and
// lets the money out the door.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { vendorSearchTerms } = require('../accounting/gl_classifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/** Record a credit a vendor owes this community. */
async function createExpectedCredit({
  communityId, vendorId = null, vendorName = null, reason,
  expectedCents = null, servicePeriodStart = null, servicePeriodEnd = null,
  sourceEmailId = null, sourceRef = null, sourceQuote = null, requestedBy = null,
} = {}) {
  if (!communityId) return { error: 'community_required' };
  if (!reason || !String(reason).trim()) return { error: 'reason_required' };
  if (!vendorId && !vendorName) return { error: 'vendor_required' };
  const { data, error } = await supabase.from('vendor_credits_expected').insert({
    community_id: communityId, vendor_id: vendorId, vendor_name: vendorName,
    reason: String(reason).slice(0, 1000),
    expected_cents: Number.isInteger(expectedCents) && expectedCents > 0 ? expectedCents : null,
    service_period_start: servicePeriodStart, service_period_end: servicePeriodEnd,
    source_email_id: sourceEmailId, source_ref: sourceRef,
    source_quote: sourceQuote ? String(sourceQuote).slice(0, 1000) : null,
    requested_by: requestedBy, status: 'expected',
  }).select('*').single();
  if (error) return { error: error.message };
  return { ok: true, credit: data };
}

/**
 * Open credits this vendor owes this community. Asked on every invoice review.
 * Matches on vendor_id when we have it, and ALWAYS also by name — a credit is
 * often captured off an email before the vendor is resolved to an id, and a
 * credit we can't find is a credit we don't collect.
 */
async function openCreditsFor({ communityId, vendorId = null, vendorName = null } = {}) {
  if (!communityId) return [];
  const out = new Map();
  try {
    if (vendorId) {
      const { data } = await supabase.from('vendor_credits_expected').select('*')
        .eq('community_id', communityId).eq('vendor_id', vendorId).eq('status', 'expected');
      (data || []).forEach((c) => out.set(c.id, c));
    }
    for (const term of vendorSearchTerms(vendorName || '')) {
      const { data } = await supabase.from('vendor_credits_expected').select('*')
        .eq('community_id', communityId).eq('status', 'expected').ilike('vendor_name', `%${term}%`);
      (data || []).forEach((c) => out.set(c.id, c));
      if (out.size) break;   // most specific term that finds anything wins
    }
  } catch (e) { console.warn('[vendor_credits] lookup failed:', e.message); }
  return [...out.values()];
}

/** Close one out — applied to a bill, waived, or disputed. */
async function resolveCredit({ creditId, status, appliedInvoiceId = null, appliedCents = null, appliedBy = null, notes = null } = {}) {
  if (!creditId || !['applied', 'waived', 'disputed'].includes(status)) return { error: 'invalid_input' };
  const patch = { status, resolution_notes: notes, applied_by: appliedBy, applied_at: new Date().toISOString() };
  if (status === 'applied') {
    patch.applied_invoice_id = appliedInvoiceId || null;
    patch.applied_cents = Number.isInteger(appliedCents) && appliedCents > 0 ? appliedCents : null;
  }
  const { data, error } = await supabase.from('vendor_credits_expected').update(patch).eq('id', creditId).select('*').single();
  if (error) return { error: error.message };
  return { ok: true, credit: data };
}

module.exports = { createExpectedCredit, openCreditsFor, resolveCredit };
