// ============================================================================
// lib/payments/pay_quote.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// The server-side quote a homeowner reviews before authorizing a payment:
//   Assessment/Payment Amount  +  Payment Processing Fee  =  Total Payment
//
// * paymentProcessingFee() is the ONE fee policy. Browsers never compute it.
// * The homeowner only ever sees the three totals above. How the fee splits
//   between processor cost and Bedrock's margin is internal (payments rows keep
//   the fee as its own line, and payments.processor_fee_cents holds processor
//   cost when known); none of that is in a quote or a checkout response.
// * A quote is returned with a short-lived signed token binding who, which lot
//   and owner tenure, which method, the exact amounts, and the terms version and
//   hash. Checkout accepts only a valid token, re-derives the amounts, and
//   refuses if anything material changed (so an acceptance cannot be reused for
//   a different amount, method, lot, payer or terms).
//
// Token key: derived from the dedicated PAYMENT_LINK_SECRET with a purpose label
// (HMAC-SHA256(secret, 'trusted-pay-quote-v1')), so it is never the raw secret
// and a pay-link token can never be replayed as a quote or vice versa.
// ============================================================================
const crypto = require('crypto');

const QUOTE_TTL_SECONDS = 15 * 60;
const FEE_LABEL = 'Payment Processing Fee';

// POLICY KNOB (unchanged economics): card payments are grossed up so the
// Association nets the full amount (covers 2.9% + 30c); bank transfers carry no fee.
function paymentProcessingFee(method, amountCents) {
  if (method !== 'card') return 0;
  return Math.max(0, Math.round((amountCents + 30) / (1 - 0.029)) - amountCents);
}

// Exactly the fields a homeowner may see. Nothing about processor cost or margin.
function quoteFor(method, amountCents) {
  const m = method === 'card' ? 'card' : 'us_bank_account';
  const fee = paymentProcessingFee(m, amountCents);
  return { method: m, amount_cents: amountCents, payment_processing_fee_cents: fee, total_cents: amountCents + fee, fee_label: FEE_LABEL };
}

function quoteKey() {
  const s = process.env.PAYMENT_LINK_SECRET || '';
  if (s.length < 32) { const e = new Error('PAYMENT_LINK_SECRET is not set; payment quotes are disabled'); e.code = 'payment_link_not_configured'; throw e; }
  return crypto.createHmac('sha256', s).update('trusted-pay-quote-v1').digest();
}
const b64 = (b) => Buffer.from(b).toString('base64url');

// ctx: { actor, propertyId, tenureId, quote, terms: {version, sha256}, now? }
function signQuote({ actor, propertyId, tenureId, quote, terms, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const payload = { v: 1, a: actor, p: propertyId, t: tenureId, m: quote.method, amt: quote.amount_cents, fee: quote.payment_processing_fee_cents,
    tot: quote.total_cents, tv: terms.version, ts: terms.sha256, iat, exp: iat + QUOTE_TTL_SECONDS, n: crypto.randomBytes(9).toString('base64url') };
  const body = b64(JSON.stringify(payload));
  return { token: `${body}.${b64(crypto.createHmac('sha256', quoteKey()).update(body).digest())}`, expires_at: new Date(payload.exp * 1000).toISOString() };
}

// -> { ok:true, payload } | { ok:false, error }
function verifyQuote(token, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return { ok: false, error: 'quote_missing' };
  const want = b64(crypto.createHmac('sha256', quoteKey()).update(body).digest());
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, error: 'quote_invalid' };
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return { ok: false, error: 'quote_invalid' }; }
  if (p.v !== 1) return { ok: false, error: 'quote_invalid' };
  if (!(p.exp > Math.floor(now / 1000))) return { ok: false, error: 'quote_expired' };
  return { ok: true, payload: p };
}

module.exports = { paymentProcessingFee, quoteFor, signQuote, verifyQuote, FEE_LABEL, QUOTE_TTL_SECONDS };
