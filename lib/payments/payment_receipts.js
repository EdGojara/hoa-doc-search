// ============================================================================
// lib/payments/payment_receipts.js  (Ed 2026-11-27)
// ----------------------------------------------------------------------------
// The homeowner's emails for an online assessment payment:
//   'submitted'  a bank (ACH) payment started processing. Money has not arrived;
//                the email says so and promises the receipt when it clears.
//   'receipt'    the payment settled (card at once; ACH when the bank confirms).
//
// ONCE PER PAYMENT, NEVER ON REPLAY. Before sending, the notifier takes a
// compare-and-set claim on the assessment payments row (migration 587):
//   UPDATE payments SET <kind>_claimed_at = now()
//    WHERE id = $1 AND <kind>_sent_at IS NULL
//      AND (<kind>_claimed_at IS NULL OR <kind>_claimed_at < now() - 15 min)
// Only the caller that gets the row back sends. A webhook replay, a Stripe retry,
// two deliveries at once, or a staff recover-events all find the claim or the
// sent_at and send nothing. Resend also gets an Idempotency-Key per payment and
// kind as a second guard. A failed send releases the claim and records the
// reason (notice_error) so staff can see it on the payment record.
//
// Refunds and disputes never send from here: payment_lifecycle.js calls this
// only on settle and on ACH processing. A payment already reversed by the time
// its settle is handled gets no receipt.
//
// Nothing here can fail a webhook: every error is caught, logged and recorded.
// The ledger and GL never wait on an email.
//
// Content rules (Ed): a Bedrock confirmation number, never a Stripe id; the
// association, the lot address, the amount applied to the account, the
// processing fee on its own line, the total charged, the method (last 4 only),
// the date. No em-dashes or en-dashes anywhere in homeowner text (a test pins
// this). Sent from the bedrocktx.com sender only.
// ============================================================================
const { newConfirmationNumber } = require('./confirmation_number');

const KINDS = {
  receipt: { claimed: 'receipt_claimed_at', sent: 'receipt_sent_at', message: 'receipt_message_id' },
  submitted: { claimed: 'submitted_notice_claimed_at', sent: 'submitted_notice_sent_at', message: 'submitted_notice_message_id' },
};
const STALE_CLAIM_MS = 15 * 60 * 1000;
const SENDER_DOMAIN_RE = /@bedrocktx\.com>?\s*$/i;
const CONTACT_LINE = 'Questions? Reply to this email or contact Bedrock at info@bedrocktx.com or (832) 588-2485.';

const usd = (c) => '$' + (Math.abs(Number(c) || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Homeowner text never carries an em-dash or en-dash (Ed's rule), whatever a name contains.
const plain = (s) => String(s == null ? '' : s).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

function centralLongDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

// "Visa ending 4242" / "Bank account ending 6789". Only the last 4 digits ever
// appear; anything else in the stored display is dropped.
function methodText({ methodType, display }) {
  const d = String(display || '');
  const last4 = (d.match(/ending\s+(\d{4})\b/i) || [])[1] || null;
  if (methodType === 'us_bank_account') return last4 ? `Bank account ending ${last4}` : 'Bank account';
  const brandRaw = (d.split(/\s+ending\s+/i)[0] || '').replace(/[^A-Za-z ]/g, '').trim();
  const brand = brandRaw && brandRaw.length <= 20 && !/\d/.test(brandRaw)
    ? brandRaw.split(' ').map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ')
    : 'Card';
  return last4 ? `${brand} ending ${last4}` : (methodType === 'card' ? 'Card' : 'Online payment');
}

// PURE: the email for one notice. r = { kind, confirmationNumber, associationName,
// communityName, propertyAddress, appliedCents, feeCents, methodType, methodDisplay, dateIso }
function renderPaymentNotice(r) {
  if (!KINDS[r.kind]) throw new Error(`unknown notice kind ${r.kind}`);
  const submitted = r.kind === 'submitted';
  const assoc = plain(r.associationName || r.communityName || 'your association');
  const short = plain(r.communityName || r.associationName || 'your association');
  const applied = Math.abs(Number(r.appliedCents) || 0);
  const fee = Math.abs(Number(r.feeCents) || 0);
  const total = applied + fee;
  const rows = [
    ['Confirmation number', plain(r.confirmationNumber)],
    ['Association', assoc],
    ['Property', plain(r.propertyAddress || '')],
    [submitted ? 'Amount to be applied to your account' : 'Amount applied to your account', usd(applied)],
    ['Processing fee (not applied to your account)', usd(fee)],
    [submitted ? 'Total to be debited' : 'Total charged', usd(total)],
    ['Payment method', methodText({ methodType: r.methodType, display: r.methodDisplay })],
    [submitted ? 'Date submitted' : 'Date paid', centralLongDate(r.dateIso)],
  ].filter(([, v]) => v !== '');

  const subject = submitted
    ? `Bank payment submitted for ${short}, confirmation ${plain(r.confirmationNumber)}`
    : `Payment receipt for ${short}, confirmation ${plain(r.confirmationNumber)}`;
  const intro = submitted
    ? `Your bank payment to ${assoc} was submitted. Bank payments take a few business days to clear. We will email your receipt when it does. You do not need to do anything else.`
    : `Thank you. Your payment to ${assoc} was received.`;
  const after = submitted
    ? 'Your portal balance updates when the bank confirms the payment.'
    : 'Please keep this email for your records. Your portal balance shows this payment once it is applied, usually right away.';
  const footer = `Paid to ${assoc} with Bedrock Pay. Bedrock Association Management is the association's managing agent. The processing fee is charged for paying online and is not part of your association account.`;

  const text = [intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', after, '', CONTACT_LINE, '', footer].join('\n');
  const tr = rows.map(([k, v], i) => {
    const strong = k.startsWith('Total') || k.startsWith('Confirmation');
    const top = k.startsWith('Total') ? 'border-top:1px solid #d9dde3;' : '';
    return `<tr><td style="padding:6px 12px;color:#6B7280;font-size:13px;${top}">${esc(k)}</td>`
      + `<td style="padding:6px 12px;font-size:13px;text-align:right;${top}${i === 0 ? 'font-family:monospace;' : ''}">${strong ? '<strong>' : ''}${esc(v)}${strong ? '</strong>' : ''}</td></tr>`;
  }).join('');
  const html = `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;color:#0B1D34;max-width:560px;">
<h2 style="font-family:Georgia,serif;color:#0B1D34;font-weight:normal;margin:0 0 12px;">${submitted ? 'Bank payment submitted' : 'Payment receipt'}</h2>
<p style="font-size:14px;line-height:1.5;">${esc(intro)}</p>
<table style="border-collapse:collapse;margin:14px 0;width:100%;">${tr}</table>
<p style="font-size:14px;line-height:1.5;">${esc(after)}</p>
<p style="font-size:13px;line-height:1.5;">${esc(CONTACT_LINE)}</p>
<p style="color:#6B7280;font-size:11px;margin-top:24px;line-height:1.5;">${esc(footer)}</p>
</div>`;
  return { subject, text, html, total_cents: total };
}

// ---------------------------------------------------------------------------
// The notifier: load, guard, claim, send, record. Never throws.
// deps: { supabase, sendEmail, fromAddress?, log?, now? }
// ---------------------------------------------------------------------------
function createPaymentNotifier({ supabase, sendEmail, fromAddress = process.env.RESEND_FROM_EMAIL, log = console, now = () => new Date() }) {
  const SELECT = 'id, community_id, property_id, contact_id, portal_user_id, payment_group_id, product_type, fee_type, amount_cents, payment_method_type, '
    + 'settlement_state, posting_state, settled_at, created_at, confirmation_number, processor_metadata, '
    + 'receipt_claimed_at, receipt_sent_at, submitted_notice_claimed_at, submitted_notice_sent_at';
  async function must(q, what) {
    const { data, error } = await q;
    if (error) throw new Error(`${what}: ${error.message}`);
    return data;
  }
  async function recipientFor(p) {
    if (p.portal_user_id) {
      const u = await must(supabase.from('portal_users').select('email, status').eq('id', p.portal_user_id).maybeSingle(), 'portal user');
      if (u && u.email && u.status !== 'revoked') return String(u.email).trim();
    }
    if (p.contact_id) {
      const c = await must(supabase.from('contacts').select('primary_email').eq('id', p.contact_id).maybeSingle(), 'contact');
      if (c && c.primary_email) return String(c.primary_email).trim();
    }
    return null;
  }
  async function ensureConfirmation(p) {
    if (p.confirmation_number) return p.confirmation_number;
    // A payment created before migration 587 has none: give its group one, once.
    const n = newConfirmationNumber();
    await must(supabase.from('payments').update({ confirmation_number: n }).eq('payment_group_id', p.payment_group_id).is('confirmation_number', null).select('id'), 'assign confirmation number');
    const again = await must(supabase.from('payments').select('confirmation_number').eq('id', p.id).single(), 'confirmation number');
    return again.confirmation_number;
  }
  const release = async (id, k, error) => {
    const { error: e } = await supabase.from('payments').update({ [k.claimed]: null, notice_error: String(error).slice(0, 500) }).eq('id', id);
    if (e) log.error(`[receipts] could not release the claim on payment ${id}: ${e.message}`);
  };

  async function notify(paymentId, kind) {
    const k = KINDS[kind];
    if (!k) return { action: 'error', error: `unknown notice kind ${kind}` };
    let claimed = false;
    try {
      const p = await must(supabase.from('payments').select(SELECT).eq('id', paymentId).maybeSingle(), 'payment');
      if (!p || p.product_type !== 'assessment_payment' || p.fee_type !== 'assessment') return { action: 'skipped', reason: 'not_an_assessment_payment' };
      if (p[k.sent]) return { action: 'already_sent' };
      if (kind === 'receipt') {
        if (p.settlement_state !== 'settled') return { action: 'skipped', reason: `not_settled (${p.settlement_state})` };
        if (p.posting_state === 'reversed') return { action: 'skipped', reason: 'reversed_before_receipt' };
      } else {
        if (p.payment_method_type !== 'us_bank_account') return { action: 'skipped', reason: 'not_a_bank_payment' };
        if (p.settlement_state !== 'processing') return { action: 'skipped', reason: `not_processing (${p.settlement_state})` };
        if (p.receipt_sent_at) return { action: 'skipped', reason: 'receipt_already_sent' };
      }
      if (!SENDER_DOMAIN_RE.test(String(fromAddress || ''))) {
        log.error(`[receipts] payment ${paymentId} ${kind} NOT SENT: the sender is not a bedrocktx.com address`);
        await release(paymentId, k, 'sender_not_bedrocktx');
        return { action: 'not_sent', reason: 'sender_not_bedrocktx' };
      }

      // The claim. Only the caller that gets the row back sends.
      const t = now();
      const stale = new Date(t.getTime() - STALE_CLAIM_MS).toISOString();
      const got = await must(supabase.from('payments').update({ [k.claimed]: t.toISOString() })
        .eq('id', paymentId).is(k.sent, null).or(`${k.claimed}.is.null,${k.claimed}.lt.${stale}`).select('id'), 'claim notice');
      if (!got || !got.length) return { action: 'already_claimed' };
      claimed = true;

      const to = await recipientFor(p);
      if (!to) { await release(paymentId, k, 'no email on file for this payment'); log.warn(`[receipts] payment ${paymentId} ${kind}: no email on file`); return { action: 'no_recipient' }; }
      const confirmation = await ensureConfirmation(p);
      const [fees, community, property] = await Promise.all([
        must(supabase.from('payments').select('id, fee_type, amount_cents').eq('payment_group_id', p.payment_group_id), 'fee rows'),
        must(supabase.from('communities').select('id, name, hoa_legal_name, slug').eq('id', p.community_id).maybeSingle(), 'community'),
        p.property_id ? must(supabase.from('properties').select('id, street_address').eq('id', p.property_id).maybeSingle(), 'property') : null,
      ]);
      const feeCents = (fees || []).filter((r) => r.id !== p.id && r.fee_type !== 'assessment').reduce((s, r) => s + Math.abs(Number(r.amount_cents) || 0), 0);
      const meta = p.processor_metadata || {};
      const msg = renderPaymentNotice({
        kind, confirmationNumber: confirmation,
        associationName: community && (community.hoa_legal_name || community.name), communityName: community && community.name,
        propertyAddress: property && property.street_address, appliedCents: p.amount_cents, feeCents,
        methodType: p.payment_method_type, methodDisplay: meta.method_display || null,
        dateIso: kind === 'receipt' ? (p.settled_at || t.toISOString()) : t.toISOString(),
      });
      const r = await sendEmail({
        to, subject: msg.subject, html: msg.html, text: msg.text, communityId: p.community_id,
        idempotencyKey: `payment-${kind}-${p.id}`,
        tags: [{ name: 'module', value: 'assessment_payment' }, { name: 'event', value: `payment_${kind}` },
          { name: 'community', value: String((community && community.slug) || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') }],
      });
      if (!r || !r.ok) {
        const why = (r && (r.error || r.reason)) || 'send failed';
        await release(paymentId, k, r && r.suppressed ? `suppressed: ${why}` : why);
        log.error(`[receipts] payment ${paymentId} ${kind} NOT SENT: ${why}`);
        return { action: 'not_sent', reason: why };
      }
      const sentAt = now().toISOString();
      const { error: rec } = await supabase.from('payments').update({ [k.sent]: sentAt, [k.message]: r.vendor_message_id || null, receipt_email: to, notice_error: null }).eq('id', paymentId);
      if (rec) log.error(`[receipts] payment ${paymentId} ${kind} SENT but not recorded (${rec.message}); the claim still blocks a resend`);
      // Correspondence on the association's behalf: on the property's interaction history.
      const { error: ie } = await supabase.from('interactions').insert({
        community_id: p.community_id, property_id: p.property_id || null, contact_id: p.contact_id || null,
        type: 'email_outbound', direction: 'outbound', delivery_method: 'email', status: 'sent', sent_at: sentAt,
        subject: msg.subject, content: msg.text, notes: `Sent automatically by Bedrock Pay (payment ${p.id}, ${kind})`,
        original_external_id: r.vendor_message_id || null,
      });
      if (ie) log.warn(`[receipts] payment ${paymentId} ${kind} sent; interaction log failed: ${ie.message}`);
      return { action: 'sent', to, confirmation_number: confirmation, message_id: r.vendor_message_id || null };
    } catch (e) {
      log.error(`[receipts] payment ${paymentId} ${kind} failed: ${e.message}`);
      if (claimed) await release(paymentId, k, e.message).catch(() => {});
      return { action: 'error', error: e.message };
    }
  }
  return { notify };
}

module.exports = { renderPaymentNotice, createPaymentNotifier, methodText, KINDS };
