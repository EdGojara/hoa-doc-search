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
// Is there already a posted entry to this account, for this exact amount, within
// `windowDays` of `postingDate`? That's the fingerprint of the same payment
// described by a second notification email. Returns the existing entry or null.
async function findSamePayment({ communityId, acctId, amountCents, postingDate, windowDays = 14 }) {
  try {
    const base = postingDate ? new Date(postingDate) : new Date();
    if (isNaN(base.getTime())) return null;
    const lo = new Date(base.getTime() - windowDays * 86400000).toISOString().slice(0, 10);
    const hi = new Date(base.getTime() + windowDays * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supabase.from('journal_entry_lines')
      .select('journal_entry_id, journal_entries!inner(id, community_id, posting_date, status, description)')
      .eq('account_id', acctId)
      .eq('debit_cents', amountCents)
      .eq('journal_entries.community_id', communityId)
      .eq('journal_entries.status', 'posted')
      .gte('journal_entries.posting_date', lo)
      .lte('journal_entries.posting_date', hi)
      .limit(1);
    if (error || !data || !data.length) return null;
    const je = data[0].journal_entries;
    return { je_id: je.id, posting_date: je.posting_date, description: je.description };
  } catch (_) { return null; }
}

async function recordVendorPaymentToGL({ communityId, amountCents, glAccountId, vendorId, vendorName, description, postingDate, sourceRef, notes, allowDuplicate = false }) {
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

  // IDEMPOTENCY — never post the same source document twice. Emma's "Record to
  // GL" button and the hands-off auto-record share this path, and a vendor email
  // can arrive or ingest more than once (duplicate delivery, a re-pull, a double
  // click). Without this, one bill could hit the GL two or three times. If a JE
  // already carries this source_reference for this community, return it instead
  // of posting again. (Real-money guard — Ed 2026-07-13.)
  if (sourceRef) {
    const { data: existing } = await supabase.from('journal_entries')
      .select('id').eq('community_id', communityId).eq('source_reference', sourceRef).limit(1);
    if (existing && existing.length) return { ok: true, je_id: existing[0].id, gl_account_id: acctId, duplicate: true };
  }

  // SAME-PAYMENT detection across DIFFERENT emails. source_ref catches the same
  // email twice; it does NOT catch two different emails describing one payment —
  // and utilities send exactly that (a North Mission Glen MUD auto-pay arrives as
  // "Auto-Pay Status" then "Auto-Pay Successfully Submitted", 3 days apart, same
  // amount). Both would post and double-count the water bill. So look for a
  // posted entry to the SAME account, SAME amount, within 14 days — long enough
  // to span the two notifications, short enough to never flag next month's
  // (identical, flat) utility bill. DETECT + confirm, never silent-block: a real
  // second identical payment must still be possible. (Ed 2026-07-16.)
  if (!allowDuplicate) {
    const dup = await findSamePayment({ communityId, acctId, amountCents, postingDate, windowDays: 14 });
    if (dup) return { error: 'suspected_duplicate', existing: dup, gl_account_id: acctId };
  }

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

module.exports = { recordVendorPaymentToGL, singleAmountCents, findSamePayment };
