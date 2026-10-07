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
//   5. vendor + total + same date + account # or invoice # within 2 edits
//                                 -> HIGH     (the same statement, a digit misread)
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

// Normalize a utility/vendor account number so "ELB 90142-1426463300" collapses.
function normAccount(s) { return s == null ? '' : String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// Two service periods overlap. Missing bounds -> no overlap claim.
//
// HALF-OPEN on purpose. Utility/MUD service periods are CONTIGUOUS: each bill's
// period starts the very day the previous one ended (June 2–July 2, then
// July 2–Aug 4). With an inclusive `<=` compare, that shared boundary day (July 2)
// read as an overlap, so EVERY month's new MUD bill was flagged a "certain"
// duplicate of the prior month and blocked from filing — the recurring "Emma
// isn't processing the MUD invoices" failure (Ed 2026-09-03). Treat periods as
// [start, end): a boundary touch is not an overlap; a genuine multi-day overlap
// (including two identical periods, start < end) still is.
function periodsOverlap(s1, e1, s2, e2) {
  if (!s1 || !e1 || !s2 || !e2) return false;
  return s1 < e2 && s2 < e1;
}

// Pure: is `inv` the same utility bill as the candidate by account + service
// period? Never when both carry invoice numbers and they differ.
function accountPeriodDuplicate(cand, inv) {
  const a = normAccount(cand.accountNumber);
  if (!a || normAccount(inv.account_number) !== a) return false;
  const c = normInvoiceNo(cand.invoiceNumber), o = normInvoiceNo(inv.vendor_invoice_number);
  if (c && o && c !== o) return false;
  return periodsOverlap(cand.servicePeriodStart, cand.servicePeriodEnd, inv.service_period_start, inv.service_period_end);
}

// Levenshtein distance, capped: returns cap+1 as soon as it is certain to exceed cap.
function editDistance(a, b, cap = 2) {
  a = String(a || ''); b = String(b || '');
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Two identifiers are "nearly the same" when, normalized, they are equal or
// differ by at most 2 edits. Short ids (under 5 characters) must match exactly:
// "12" and "13" are one edit apart and say nothing.
const FUZZY_MIN_LEN = 5;
function nearlySameId(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < FUZZY_MIN_LEN || b.length < FUZZY_MIN_LEN) return false;
  return editDistance(a, b, 2) <= 2;
}

// Pure: is `inv` (an ap_invoices row) the same statement as the candidate, read
// differently? Same total to the cent + same invoice date + the account number
// OR the invoice number nearly the same. This fires even when both bills carry
// DIFFERENT invoice numbers, because the difference may be the misread.
//
// Why (Ed 2026-10-07): Fort Bend County M.U.D. No. 143 statement 30358853
// (account 99693, 9/14/26, $5,562.20) loaded twice at Waterview Estates. The
// second copy was read off page 3 of the same statement as account 99893 /
// statement 300388853, so the exact-match layers saw two different bills and
// both were recorded as ACH-paid. A suspected match is HELD for a person, never
// blocked and never silently loaded.
function nearDuplicateStatement(cand, inv) {
  if (cand.totalCents == null || inv.total_cents !== cand.totalCents) return null;
  if (!cand.invoiceDate || !inv.invoice_date || String(inv.invoice_date).slice(0, 10) !== String(cand.invoiceDate).slice(0, 10)) return null;
  const ca = normAccount(cand.accountNumber), oa = normAccount(inv.account_number);
  const ci = normInvoiceNo(cand.invoiceNumber), oi = normInvoiceNo(inv.vendor_invoice_number);
  const acct = nearlySameId(ca, oa);
  const num = nearlySameId(ci, oi);
  if (!acct && !num) return null;
  const parts = [];
  if (acct) parts.push(ca === oa ? `account ${inv.account_number}` : `account ${cand.accountNumber} vs ${inv.account_number}`);
  if (num) parts.push(ci === oi ? `invoice # ${inv.vendor_invoice_number}` : `invoice # ${cand.invoiceNumber} vs ${inv.vendor_invoice_number}`);
  return `Same vendor + amount ($${(cand.totalCents / 100).toFixed(2)}) + date (${String(cand.invoiceDate).slice(0, 10)}), ${parts.join(', ')}: likely the same statement read twice`;
}

// Returns { verdict: 'unique'|'suspected'|'certain', matches: [{invoice, reason, confidence}] }
// candidate: { communityId, vendorId, invoiceNumber, totalCents, invoiceDate, fileSha256,
//              accountNumber, servicePeriodStart, servicePeriodEnd }
async function findDuplicates(supabase, candidate) {
  const { communityId, vendorId, invoiceNumber, totalCents, invoiceDate, fileSha256,
    accountNumber, servicePeriodStart, servicePeriodEnd } = candidate;
  const matches = [];
  const seen = new Set();
  const add = (inv, reason, confidence) => {
    if (!inv || seen.has(inv.id)) return;
    seen.add(inv.id);
    matches.push({ invoice: inv, reason, confidence });
  };

  const COLS = 'id, vendor_invoice_number, invoice_date, total_cents, status, dedup_status, received_at, source_filename, account_number, service_period_start, service_period_end';

  // 1) Same file, same community — certain.
  if (fileSha256 && communityId) {
    const { data } = await supabase.from('ap_invoices').select(COLS)
      .eq('community_id', communityId).eq('file_sha256', fileSha256)
      .neq('status', 'voided').limit(5);
    for (const inv of (data || [])) add(inv, 'Same file already on file', 'certain');
  }

  const normCand = normInvoiceNo(invoiceNumber);

  // Cross-community: a vendor's invoice number is unique to that VENDOR, not to
  // one community, so the same vendor + invoice # filed under a DIFFERENT
  // community is almost always a misfiled duplicate. Suspected (held for a human
  // to pick the right community), never silently refused. (Ed 2026-08-10 —
  // Superior LawnCare #43444 filed to both Waterview and Quail Ridge; the
  // per-community UNIQUE constraint could not see it.)
  if (vendorId && normCand) {
    const { data } = await supabase.from('ap_invoices')
      .select('id, vendor_invoice_number, invoice_date, total_cents, status, community_id, communities:community_id(name)')
      .eq('vendor_id', vendorId).neq('status', 'voided').limit(400);
    for (const inv of (data || [])) {
      if (communityId && inv.community_id === communityId) continue; // same community handled below
      if (normInvoiceNo(inv.vendor_invoice_number) === normCand) {
        add(inv, `Same vendor + invoice # (${inv.vendor_invoice_number || '—'}) already filed under ${inv.communities ? inv.communities.name : 'another community'}`, 'high');
      }
    }
  }

  // Pull this vendor's recent invoices in this community once; classify in JS.
  if (vendorId && communityId) {
    const { data } = await supabase.from('ap_invoices').select(COLS)
      .eq('community_id', communityId).eq('vendor_id', vendorId)
      .neq('status', 'voided').order('invoice_date', { ascending: false }).limit(400);
    const rows = data || [];

    for (const inv of rows) {
      // 2) Same normalized invoice number — certain.
      if (normCand && normInvoiceNo(inv.vendor_invoice_number) === normCand) {
        add(inv, `Same vendor + invoice # (${inv.vendor_invoice_number || '—'})`, 'certain');
        continue;
      }
      // 2b) Utility bills (no stable invoice #): same account # + OVERLAPPING service
      // period — certain. This is what distinguishes July's MUD from August's.
      // Only when the invoice numbers don't already tell the bills apart: two
      // DIFFERENT, present invoice numbers are two different bills, even when the
      // periods overlap by a few days (Issue #14: NRG Waterview Sept, 8/16-9/15,
      // was blocked as a "certain" duplicate of August, 7/16-8/18, inv 302 008
      // 234 841 vs 302 008 342 079; Fort Bend MUD 143 had the same shape).
      if (accountPeriodDuplicate({ invoiceNumber, accountNumber, servicePeriodStart, servicePeriodEnd }, inv)) {
        add(inv, `Same account ${accountNumber} + service period ${servicePeriodStart}..${servicePeriodEnd}`, 'certain');
        continue;
      }
      // 5) Same amount + same date + nearly the same account # or invoice # —
      // suspected. Runs before the "both numbered" exclusion below on purpose:
      // a misread number is exactly what makes two copies look distinct.
      const near = nearDuplicateStatement({ invoiceNumber, accountNumber, totalCents, invoiceDate }, inv);
      if (near) { add(inv, near, 'high'); continue; }
      // 3/4) Same amount + same/near date — suspected. This exists to catch a
      // MISSING or typo'd invoice number, so it must ONLY fire when the two
      // bills aren't already distinguished by their numbers. Two DIFFERENT,
      // present invoice numbers are proof of two different bills — a recurring
      // vendor that bills the same amount on a cadence (weekly security patrol,
      // monthly landscaping/pool/management) must NOT be flagged as a duplicate
      // of last period's invoice. (Star Protection: $4,277.43 every 7 days.)
      const bothNumbered = !!(normCand && normInvoiceNo(inv.vendor_invoice_number));
      if (!bothNumbered && totalCents != null && inv.total_cents === totalCents) {
        const dd = daysBetween(invoiceDate, inv.invoice_date);
        if (dd === 0) add(inv, `Same vendor + amount ($${(totalCents / 100).toFixed(2)}) + same date, no distinct invoice #`, 'high');
        else if (dd <= 7) add(inv, `Same vendor + amount ($${(totalCents / 100).toFixed(2)}) + date within ${dd}d, no distinct invoice #`, 'medium');
      }
    }
  }

  const hasCertain = matches.some((m) => m.confidence === 'certain');
  const hasSuspect = matches.some((m) => m.confidence === 'high' || m.confidence === 'medium');
  const verdict = hasCertain ? 'certain' : hasSuspect ? 'suspected' : 'unique';
  return { verdict, matches };
}

module.exports = { findDuplicates, normInvoiceNo, periodsOverlap, accountPeriodDuplicate, nearDuplicateStatement, editDistance };
