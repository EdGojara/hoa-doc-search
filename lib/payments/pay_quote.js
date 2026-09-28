// ============================================================================
// lib/payments/pay_quote.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// The server-side quote a homeowner reviews before authorizing a payment:
//   Assessment/Payment Amount  +  Payment Processing Fee  =  Total Payment
//
// * feeBreakdown() is the ONE fee policy. Browsers never compute it. The
//   Payment Processing Fee is two internal components, configured per payment
//   method (see FEE POLICY below):
//     processor cost recovery  (what the payment processor is expected to take)
//   + Bedrock margin           (technology/convenience margin; default 0)
//   = Payment Processing Fee   (the only fee the homeowner sees)
//   The Association's principal is always the full Assessment/Payment Amount.
// * The homeowner only ever sees the three totals above. The split is internal:
//   checkout stores it on the fee line (payments.processor_metadata.fee_components)
//   for reconciliation; it is never in a quote, a token, or a checkout response.
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

// FEE POLICY. Per payment method, two components, each basis points of the
// charge plus a fixed amount in cents, overridable by env:
//   PAY_FEE_{CARD|ACH}_PROCESSOR_BPS / _PROCESSOR_FIXED_CENTS
//   PAY_FEE_{CARD|ACH}_MARGIN_BPS    / _MARGIN_FIXED_CENTS
// Defaults are the existing economics: card recovers 2.9% + 30c (the processor
// takes it on the TOTAL charged, so the fee is grossed up), bank transfer
// recovers nothing, and the Bedrock margin is disabled (0) for both until Ed
// sets the pricing policy. Margin bps apply to the Assessment/Payment Amount.
const FEE_POLICY_VERSION = 'fee-policy-1';
const METHOD_ENV = { card: 'CARD', us_bank_account: 'ACH' };
const DEFAULTS = {
  card: { processor_bps: 290, processor_fixed_cents: 30, margin_bps: 0, margin_fixed_cents: 0 },
  us_bank_account: { processor_bps: 0, processor_fixed_cents: 0, margin_bps: 0, margin_fixed_cents: 0 },
};
class FeePolicyConfigError extends Error { constructor(m) { super(m); this.code = 'fee_policy_invalid'; } }

function feePolicy(method, env = process.env) {
  const m = method === 'card' ? 'card' : 'us_bank_account';
  const out = { method: m };
  for (const [k, def] of Object.entries(DEFAULTS[m])) {
    const name = `PAY_FEE_${METHOD_ENV[m]}_${k.toUpperCase()}`;
    const raw = env[name];
    const v = raw === undefined || raw === '' ? def : Number(raw);
    if (!Number.isInteger(v) || v < 0) throw new FeePolicyConfigError(`${name} must be a whole number >= 0`);
    out[k] = v;
  }
  if (out.processor_bps >= 10000) throw new FeePolicyConfigError(`PAY_FEE_${METHOD_ENV[m]}_PROCESSOR_BPS must be under 10000`);
  return out;
}

// INTERNAL: the full split. Never send this to a homeowner.
// processor cost is modeled as round(total * bps) + fixed, taken from the total;
// the total is the smallest (rounded) amount that leaves the Association its full
// principal and Bedrock its full margin after that cost.
function feeBreakdown(method, amountCents, env = process.env) {
  const p = feePolicy(method, env);
  const amount = Math.round(Number(amountCents));
  const margin = Math.round((amount * p.margin_bps) / 10000) + p.margin_fixed_cents;
  const hasProcessor = p.processor_bps > 0 || p.processor_fixed_cents > 0;
  const total = hasProcessor ? Math.round((amount + margin + p.processor_fixed_cents) / (1 - p.processor_bps / 10000)) : amount + margin;
  const fee = Math.max(0, total - amount);
  return { method: p.method, amount_cents: amount, processor_cost_cents: fee - margin, bedrock_margin_cents: margin,
    payment_processing_fee_cents: fee, total_cents: amount + fee, policy_version: FEE_POLICY_VERSION, policy: p };
}

// The combined homeowner-facing fee.
const paymentProcessingFee = (method, amountCents) => feeBreakdown(method, amountCents).payment_processing_fee_cents;

// Exactly the fields a homeowner may see. Nothing about processor cost or margin.
function quoteFor(method, amountCents) {
  const b = feeBreakdown(method, amountCents);
  return { method: b.method, amount_cents: b.amount_cents, payment_processing_fee_cents: b.payment_processing_fee_cents, total_cents: b.total_cents, fee_label: FEE_LABEL };
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

module.exports = { paymentProcessingFee, feeBreakdown, feePolicy, FeePolicyConfigError, FEE_POLICY_VERSION, quoteFor, signQuote, verifyQuote, FEE_LABEL, QUOTE_TTL_SECONDS };
