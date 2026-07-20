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

// Parse "N days past due" / "N days overdue" from a vendor notice — vendors
// state the age right in the email, so we don't have to have the invoice on file
// to know how late it is. Returns an integer day count or null.
function parseDaysPastDue(text) {
  const m = String(text || '').match(/(\d{1,4})\s*days?\s*(past[-\s]?due|overdue|late)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Whole-picture "where does this vendor bill stand?" for one Emma email —
// computed LIVE (not stamped at ingest), so it's right on old emails too and
// always reflects the CURRENT state of Payables. Answers Ed's ask: is it in
// payables or not, how many days outstanding, and does it need escalation.
// Returns null for non-actionable mail (no money signal). Otherwise:
//   { standing, in_payables, days_outstanding, overdue, escalate, urgency,
//     amount_cents, invoice_ref, banner, action }
// action: 'add_to_payables' | 'review_in_payables' | 'already_paid' | null.
async function invoiceStanding(supabase, m) {
  try {
    const ex = (m && m.extracted) || {};
    const text = `${m.subject || ''}\n${m.ai_summary || ''}\n${m.body_preview || ''}`;
    const chase = detectFollowUp({ subject: m.subject, body: `${m.ai_summary || ''}\n${m.body_preview || ''}` });
    const statedDays = parseDaysPastDue(text);
    const pastDueWord = /\b(past[-\s]?due|overdue|delinquen|final notice|shut[-\s]?off|disconnect|suspend)\b/i.test(text);
    // Only surface standing for actual bill/chase mail — not payment-success
    // confirmations (those want Record-to-GL, handled elsewhere).
    const isConfirmation = /\bpayment (success|confirmation|received|posted)\b/i.test(text) || /\bthank you for your payment\b/i.test(text);
    if (isConfirmation) return null;
    if (!chase.is_follow_up && statedDays == null && !pastDueWord) return null;

    const amountCents = require('../accounting/record_vendor_payment').singleAmountCents(ex.amounts || []);
    const match = await matchChasedInvoice(supabase, {
      communityId: m.community_id || null, vendorId: m.resolved_vendor_id || null,
      accountNumber: ex.account_number || null, invoiceNumber: ex.account_number || null,
    });

    const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const hot = /\b(final notice|shut[-\s]?off|disconnect|service (interruption|suspension|suspend)|suspend|collections|termination|turn[-\s]?off)\b/i.test(text);
    const vendorLabel = ex.vendor_name || (m.resolved_vendor && m.resolved_vendor.name) || m.sender_name || 'this vendor';
    const invRef = ex.account_number ? `#${ex.account_number}` : '';

    if (match.found) {
      // days outstanding from the invoice on file (due_date first, else invoice_date)
      let days = statedDays;
      const base = match.invoice_date;
      if (days == null && base) days = Math.max(0, Math.round((Date.now() - new Date(base).getTime()) / 86400000));
      if (match.status === 'paid') {
        return { standing: 'in_payables_paid', in_payables: true, days_outstanding: days, overdue: false, escalate: false, urgency: null, amount_cents: match.total_cents, invoice_ref: invRef, banner: `✅ In Payables — ${match.message}`, action: null };
      }
      const overdue = statedDays != null || pastDueWord;
      const escalate = overdue || hot;
      const onHold = match.status === 'on_hold';
      return {
        standing: onHold ? 'in_payables_on_hold' : 'in_payables_open', in_payables: true,
        days_outstanding: days, overdue, escalate, urgency: hot ? 'high' : (escalate ? 'medium' : null),
        amount_cents: match.total_cents, invoice_ref: match.invoice_number ? `#${match.invoice_number}` : invRef,
        banner: `${escalate ? '⚠️ ' : ''}In Payables (${match.status.replace(/_/g, ' ')})${days != null ? ` — ${days} days outstanding` : ''}${escalate ? ' — OVERDUE, escalate' : ''}. ${match.message}`,
        action: 'review_in_payables',
      };
    }

    // Not on file — a bill we haven't recorded. This is the one that sits dead.
    const overdue = statedDays != null || pastDueWord;
    const escalate = overdue || hot;
    return {
      standing: 'not_in_payables', in_payables: false,
      days_outstanding: statedDays, overdue, escalate, urgency: hot ? 'high' : (escalate ? 'medium' : null),
      amount_cents: amountCents, invoice_ref: invRef,
      banner: `${escalate ? '⚠️ ' : ''}NOT in Payables — ${vendorLabel} ${invRef}${amountCents ? ` ${money(amountCents)}` : ''}${statedDays != null ? `, ${statedDays} days past due` : ''}${hot ? ' — vendor is threatening service' : ''}. Add it so it isn't missed.`,
      action: 'add_to_payables',
    };
  } catch (e) { console.warn('[followup] standing skipped:', e.message); return null; }
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

// "Did we already pay this?" — for a fresh bill, check whether a PAID invoice on
// the same account for a matching amount posted recently (default 45 days). Guards
// against double-paying a utility that emails the statement AND the auto-pay
// receipt. Returns {already_paid, paid_at, amount_cents, invoice_id} or {already_paid:false}.
async function checkAlreadyPaid(supabase, { communityId, vendorId, accountNumber, amountCents, windowDays = 45 } = {}) {
  if (!amountCents || (!accountNumber && !vendorId)) return { already_paid: false };
  try {
    const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
    let q = supabase.from('ap_invoices')
      .select('id, vendor_invoice_number, total_cents, amount_paid_cents, status, paid_at, account_number')
      .eq('status', 'paid').gte('paid_at', since).order('paid_at', { ascending: false }).limit(50);
    if (communityId) q = q.eq('community_id', communityId);
    if (accountNumber) q = q.eq('account_number', String(accountNumber).trim());
    else if (vendorId) q = q.eq('vendor_id', vendorId);
    const { data, error } = await q;
    if (error) return { already_paid: false };
    // Match on amount within $1 (rounding) — same account + same amount recently = the same bill.
    const hit = (data || []).find((i) => Math.abs(Number(i.total_cents || i.amount_paid_cents || 0) - Number(amountCents)) <= 100);
    if (!hit) return { already_paid: false };
    return { already_paid: true, invoice_id: hit.id, invoice_number: hit.vendor_invoice_number, amount_cents: hit.total_cents, paid_at: hit.paid_at };
  } catch (e) { return { already_paid: false }; }
}

module.exports = { detectFollowUp, matchChasedInvoice, recordFollowUpOutcome, checkAlreadyPaid, invoiceStanding, parseDaysPastDue };
