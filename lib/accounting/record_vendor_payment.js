// ============================================================================
// lib/accounting/record_vendor_payment.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// The single path that records an already-handled vendor payment to the GL:
// Dr the expense account / Cr 1000 Operating Cash, flagged needs_review for
// month-end. ONE implementation shared by Emma's "Record to GL" button and the
// hands-off auto-record at ingest, so a click and an auto-run can never diverge.
// Guarded: returns an { error } instead of posting when it isn't sure.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { suggestClassification } = require('./gl_classifier');
const { postJournalEntry } = require('./posting');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Returns { ok, je_id, gl_account_id } or { error } — never throws for the
// expected guard cases (missing community/amount/account, closed period).
async function recordVendorPaymentToGL({ communityId, amountCents, glAccountId, vendorId, vendorName, description, postingDate, sourceRef, notes }) {
  if (!communityId) return { error: 'no_community' };
  if (!amountCents || !Number.isInteger(amountCents) || amountCents <= 0) return { error: 'no_amount' };

  let acctId = glAccountId || null;
  let reason = 'Learned vendor mapping';
  if (!acctId) {
    const cls = await suggestClassification({ communityId, vendorId: vendorId || null, vendorName: vendorName || null, description: description || '', isPaymentLeg: false });
    acctId = cls.account_id; reason = cls.reason || reason;
    if (!acctId) return { error: 'no_account' };
  }
  const cash = await suggestClassification({ communityId, isPaymentLeg: true });
  if (!cash.account_id) return { error: 'no_cash' };

  try {
    const je = await postJournalEntry({
      community_id: communityId,
      posting_date: postingDate || new Date().toISOString().slice(0, 10),
      description: String(description || 'Vendor payment').slice(0, 120),
      source_module: 'manual', source_reference: sourceRef || null,
      notes: notes || null,
      lines: [
        { account_id: acctId, debit_cents: amountCents, credit_cents: 0 },
        { account_id: cash.account_id, debit_cents: 0, credit_cents: amountCents },
      ],
    });
    const jeId = je && je.entry ? je.entry.id : null;
    if (jeId) { try { await supabase.from('journal_entries').update({ needs_review: true, classification_reason: reason }).eq('id', jeId); } catch (_) {} }
    return { ok: true, je_id: jeId, gl_account_id: acctId };
  } catch (e) {
    if (e.code === 'period_closed') return { error: 'period_closed' };
    throw e;
  }
}

// Pull a single unambiguous dollar amount (in cents) from classifier-extracted
// amount strings. Returns null if zero or more-than-one distinct amount.
function singleAmountCents(amounts) {
  const cents = [...new Set((Array.isArray(amounts) ? amounts : [])
    .map((a) => { const n = parseFloat(String(a).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; })
    .filter((x) => x && x > 0))];
  return cents.length === 1 ? cents[0] : null;
}

module.exports = { recordVendorPaymentToGL, singleAmountCents };
