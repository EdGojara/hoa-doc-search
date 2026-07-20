// ============================================================================
// lib/ap/followup.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// Vendor payment FOLLOW-UPS (a vendor chasing us for payment) — distinct from a
// new bill. Detect the chase, rank its urgency, and match it to the original
// bill in AP so the operator sees at a glance: already paid (when + how much) /
// awaiting approval / on hold for a duplicate / or no record at all (a bill we
// never got). Turns "dig through the inbox" into a one-line answer, and feeds
// Emma's reply so she can say "paid on 7/12" instead of a vague acknowledgment.
//
// Learning loop: recordFollowUpOutcome() writes back what actually happened
// (matched invoice + resolution), so the vendor's chase behavior and the
// invoice link get stronger over time — the platform gets smarter each pass.
// ============================================================================

// A chase, not a fresh invoice. Kept narrow so a normal bill ("invoice
// attached, net 30") does NOT read as a follow-up.
const CHASE = /\b(past[-\s]?due|second notice|final notice|overdue|friendly reminder|payment reminder|following up|follow[-\s]?up|please remit|remit payment|outstanding balance|balance (remains|is still|due)|still (shows|owe|outstanding)|not (yet )?received|no payment (received|on file)|delinquen|account is (past due|delinquent)|amount is now due)\b/i;
// Hotter language → higher urgency (shutoff / final / late-fee threats).
const HOT = /\b(final notice|urgent|immediately|disconnect|shut[-\s]?off|service (interruption|suspension)|suspend|late fee will|collections|turn[-\s]?off|termination)\b/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Is this vendor email a payment follow-up? Returns {is_follow_up, urgency}.
function detectFollowUp({ subject, body } = {}) {
  const t = `${subject || ''}\n${body || ''}`;
  if (!CHASE.test(t)) return { is_follow_up: false };
  return { is_follow_up: true, urgency: HOT.test(t) ? 'high' : 'medium' };
}

// Find the bill being chased and report its live AP status. Narrows by invoice
// number first (most precise), then account number, within the community/vendor.
async function matchChasedInvoice(supabase, { communityId, vendorId, accountNumber, invoiceNumber } = {}) {
  if (!communityId && !vendorId && !accountNumber) return { found: false, reason: 'no_key' };
  let q = supabase.from('ap_invoices')
    .select('id, vendor_invoice_number, account_number, invoice_date, due_date, total_cents, amount_paid_cents, status, dedup_status, received_at, paid_at')
    .order('received_at', { ascending: false }).limit(25);
  if (communityId) q = q.eq('community_id', communityId);
  if (vendorId) q = q.eq('vendor_id', vendorId);
  const { data, error } = await q;
  if (error) return { found: false, reason: 'query_failed', detail: error.message };
  let cands = data || [];
  if (invoiceNumber) { const hit = cands.filter((i) => norm(i.vendor_invoice_number) === norm(invoiceNumber)); if (hit.length) cands = hit; }
  else if (accountNumber) { const hit = cands.filter((i) => norm(i.account_number) === norm(accountNumber)); if (hit.length) cands = hit; }
  const inv = cands[0] || null;
  if (!inv) return { found: false, reason: 'no_match', message: 'No matching bill on file — this may be a bill we never received. Ask the vendor to resend.' };

  const total = Number(inv.total_cents || 0), paidAmt = Number(inv.amount_paid_cents || 0);
  const isPaid = inv.status === 'paid' || (total > 0 && paidAmt >= total);
  const onHold = ['on_hold', 'suspected_duplicate'].includes(inv.dedup_status);
  const status = isPaid ? 'paid' : onHold ? 'on_hold' : inv.status === 'voided' ? 'voided' : 'awaiting_approval';
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const message = isPaid
    ? `Already paid${inv.paid_at ? ` on ${String(inv.paid_at).slice(0, 10)}` : ''} (${money(paidAmt || total)}).`
    : onHold ? 'On hold as a possible duplicate — not yet paid; clear it in Payables first.'
    : status === 'voided' ? 'This bill was voided.'
    : `In Payables awaiting approval (${money(total)}), received ${String(inv.received_at || '').slice(0, 10)}.`;
  return {
    found: true, invoice_id: inv.id, invoice_number: inv.vendor_invoice_number, account_number: inv.account_number,
    status, total_cents: total, amount_paid_cents: paidAmt, invoice_date: inv.invoice_date, paid_at: inv.paid_at,
    received_at: inv.received_at, message,
  };
}

// Learning loop: persist what a follow-up resolved to (matched invoice, action
// taken), so vendor chase behavior + the invoice link strengthen over time.
// Defensive: the log table may not exist yet — never throws into the caller.
async function recordFollowUpOutcome(supabase, { emailId, communityId, vendorId, accountNumber, invoiceId, status, action, byUserId } = {}) {
  try {
    await supabase.from('vendor_followup_log').insert({
      email_message_id: emailId || null, community_id: communityId || null, vendor_id: vendorId || null,
      account_number: accountNumber || null, matched_invoice_id: invoiceId || null,
      matched_status: status || null, action: action || null, by_user_id: byUserId || null,
    });
    return { ok: true };
  } catch (e) { console.warn('[followup] outcome log skipped:', e.message); return { ok: false }; }
}

module.exports = { detectFollowUp, matchChasedInvoice, recordFollowUpOutcome };
