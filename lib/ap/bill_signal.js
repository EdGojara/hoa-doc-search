// ============================================================================
// lib/ap/bill_signal.js  (Issue #14 follow-up): a bill the labels missed
// ----------------------------------------------------------------------------
// The 9/29 Waterview MUD bill ("MUD Invoice WV", attachment "MUD $150.80.pdf",
// a Fort Bend MUD 143 invoice) was labeled `internal` by the email classifier
// and never asked for payment, so the straggler check did not count it as a
// bill. Two signals that do not depend on the email's label:
//   1. the FILE: the reader extracted a vendor we already pay plus an invoice
//      number / amount / account number, even if it called the file "not an
//      invoice" (live intake turns that into a Payables exception);
//   2. the WORDS: for an email with no recorded outcome (older mail), its
//      subject or attachment names read like a bill.
// ============================================================================

// Pure: the bill-ish fields the reader pulled out of one file.
function billSignalFrom(extracted) {
  const x = extracted || {};
  return {
    vendor_name: x.vendor_name || null,
    invoice_number: x.invoice_number || null,
    total_cents: Number.isInteger(x.total_cents) && x.total_cents > 0 ? x.total_cents : null,
    account_number: x.account_number || null,
    looks_like_invoice: !!x.looks_like_invoice,
  };
}

// Pure: a file the reader called "not an invoice" that is plainly a bill from a
// vendor we already pay (a known vendor AND an invoice #, amount or account #).
function isSuspectedMissedBill(result) {
  if (!result || result.outcome !== 'not_an_invoice') return false;
  const s = result.bill_signal;
  return !!(s && s.known_vendor_id && (s.invoice_number || s.total_cents || s.account_number));
}

function suspectedBillReason(result) {
  const s = result.bill_signal || {};
  const bits = [s.invoice_number ? `invoice ${s.invoice_number}` : null, s.total_cents ? `$${(s.total_cents / 100).toFixed(2)}` : null, s.account_number ? `account ${s.account_number}` : null].filter(Boolean).join(', ');
  return `reads like a bill from ${s.known_vendor_name || s.vendor_name || 'a known vendor'}${bits ? ` (${bits})` : ''} although the reader called it not a bill: open it and enter it if it is one`;
}

// Pure: subject or attachment names that read like a bill. Used only for Emma
// attachment emails with no recorded outcome, as a visibility signal.
const BILL_WORDS = /\b(invoice|invoices|inv\s*#|bill|billing\s+statement|statement|amount\s+due|past\s+due|payment\s+due|balance\s+due|remittance)\b/i;
function looksLikeBillText(subject, attachmentNames = []) {
  return BILL_WORDS.test(String(subject || '')) || (attachmentNames || []).some((n) => BILL_WORDS.test(String(n || '').replace(/[_.-]+/g, ' ')));
}

const normAcct = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
const normName = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|co|corp|ltd|the|company)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// A vendor we already pay, by service account number (from posted bills) or by
// name. Bounded reads; returns { id, name, via } or null. Throws on a query error
// (a broken query must not read as "unknown vendor").
async function matchKnownVendor(supabase, sig) {
  if (!sig) return null;
  const acct = normAcct(sig.account_number);
  if (acct.length >= 5) {
    // Stored account numbers carry spaces/dashes ("24 035 567 - 7"), so match the
    // last 4 characters with gaps allowed, then compare normalized.
    const tail = acct.slice(-4).split('').join('%');
    const { data, error } = await supabase.from('ap_invoices').select('vendor_id, account_number, vendors(name)').ilike('account_number', `%${tail}%`).not('vendor_id', 'is', null).limit(500);
    if (error) throw new Error(`known-vendor lookup (account) failed: ${error.message}`);
    const hit = (data || []).find((r) => normAcct(r.account_number) === acct);
    if (hit) return { id: hit.vendor_id, name: (hit.vendors && hit.vendors.name) || null, via: 'account_number' };
  }
  const n = normName(sig.vendor_name);
  const first = n.split(' ').find((t) => t.length >= 3);
  if (first) {
    const { data, error } = await supabase.from('vendors').select('id, name, dba').or(`name.ilike.%${first}%,dba.ilike.%${first}%`).limit(50);
    if (error) throw new Error(`known-vendor lookup (name) failed: ${error.message}`);
    const hit = (data || []).find((v) => [v.name, v.dba].some((x) => x && normName(x) === n));
    if (hit) return { id: hit.id, name: hit.name, via: 'name' };
  }
  return null;
}

// Annotate "not an invoice" results with their bill signal + known vendor, in
// place. Never throws (a lookup failure leaves the result un-annotated and logs).
async function annotateNotInvoiceResults(supabase, results) {
  for (const r of results || []) {
    if (r.outcome !== 'not_an_invoice' || !r._out) continue;
    const sig = billSignalFrom(r._out.extracted);
    try {
      const v = await matchKnownVendor(supabase, sig);
      r.bill_signal = { ...sig, known_vendor_id: v ? v.id : null, known_vendor_name: v ? v.name : null, via: v ? v.via : null };
    } catch (e) { console.warn('[bill_signal] known-vendor lookup skipped:', e.message); r.bill_signal = { ...sig, known_vendor_id: null }; }
  }
  return results;
}

module.exports = { billSignalFrom, isSuspectedMissedBill, suspectedBillReason, looksLikeBillText, matchKnownVendor, annotateNotInvoiceResults, BILL_WORDS };
