// ============================================================================
// lib/payments/fee_quote.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// The ONE place a homeowner assessment payment's processing fee is decided.
// Nothing in the browser computes a fee; the portal shows what this returns.
//
// Model (Ed 2026-11-21, benchmarked on Vantaca Pay, the established Texas HOA
// payment platform on Stripe): Bedrock's electronic payment processing fee,
// collected as the Stripe Connect application fee, kept separate from the
// association's assessment proceeds and never posted to the homeowner ledger.
//   card (credit, debit, prepaid)  fee = round(amount * card_fee_bps / 10000);
//                                  debit_card_fee_bps overrides for debit and
//                                  prepaid when set (null = same as card)
//   bank account (ACH)             two flat tiers on the PAYMENT amount:
//                                  amount <= ach_tier_threshold_cents -> ach_fee_cents
//                                  amount >  ach_tier_threshold_cents -> ach_fee_above_cents
//                                  (Ed 2026-11-21: $2.95 up to and including $350,
//                                  $5.95 above). Threshold/above null = one flat fee.
// Disclosed with the amount and total before the homeowner authorizes payment.
//
// Per-association config, FAIL-CLOSED. communities.portal_module_config.payment_fees:
//   { card_fee_bps, debit_card_fee_bps|null, ach_fee_cents,
//     ach_tier_threshold_cents|null, ach_fee_above_cents|null }
// Missing or malformed -> online payment refused with a clear message; never a
// default fee. MAX_FEE_BPS is a typo guard (35 -> 3500), not a pricing decision.
//
// The quote is bound to the payment method, lot, owner tenure and amounts by an
// HMAC-signed token. Confirm re-computes everything and refuses if anything
// moved; the client's numbers are never used.
// ============================================================================
'use strict';
const crypto = require('crypto');

const MAX_FEE_BPS = 1000;
const QUOTE_TTL_SECONDS = 15 * 60;
const NOT_CONFIGURED_HINT = 'Online payment is not available for this association yet (payment fees have not been set up). Please contact management to pay.';

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const bpsOk = (v) => isNonNegInt(v) && v <= MAX_FEE_BPS;

// -> { ok:true, config } | { ok:false, error, detail }
function validateFeeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'payment_fees_not_configured', detail: 'no payment_fees config' };
  const { card_fee_bps: card, ach_fee_cents: ach } = raw;
  const debit = raw.debit_card_fee_bps == null ? null : raw.debit_card_fee_bps;
  const thr = raw.ach_tier_threshold_cents == null ? null : raw.ach_tier_threshold_cents;
  const above = raw.ach_fee_above_cents == null ? null : raw.ach_fee_above_cents;
  if (!bpsOk(card)) return { ok: false, error: 'payment_fees_invalid', detail: `card_fee_bps must be whole basis points from 0 to ${MAX_FEE_BPS}` };
  if (debit !== null && !bpsOk(debit)) return { ok: false, error: 'payment_fees_invalid', detail: `debit_card_fee_bps must be null or whole basis points from 0 to ${MAX_FEE_BPS}` };
  if (!isNonNegInt(ach)) return { ok: false, error: 'payment_fees_invalid', detail: 'ach_fee_cents must be whole cents >= 0' };
  if ((thr === null) !== (above === null)) return { ok: false, error: 'payment_fees_invalid', detail: 'ach_tier_threshold_cents and ach_fee_above_cents must both be set or both be empty' };
  if (thr !== null && (!Number.isInteger(thr) || thr <= 0)) return { ok: false, error: 'payment_fees_invalid', detail: 'ach_tier_threshold_cents must be whole cents > 0' };
  if (above !== null && !isNonNegInt(above)) return { ok: false, error: 'payment_fees_invalid', detail: 'ach_fee_above_cents must be whole cents >= 0' };
  return { ok: true, config: { card_fee_bps: card, debit_card_fee_bps: debit, ach_fee_cents: ach, ach_tier_threshold_cents: thr, ach_fee_above_cents: above } };
}

function feeConfigFromCommunity(community) {
  const cfg = community && community.portal_module_config && typeof community.portal_module_config === 'object' ? community.portal_module_config : {};
  return validateFeeConfig(cfg.payment_fees);
}

const pctText = (bps) => (bps / 100).toFixed(2).replace(/\.?0+$/, '');

// What the payment method is, from Stripe's PaymentMethod object.
// -> { ok:true, method_kind, funding, display } | { ok:false, error }
function classifyPaymentMethod(pm) {
  if (!pm || typeof pm !== 'object' || !pm.id) return { ok: false, error: 'payment_method_not_found' };
  if (pm.type === 'card' && pm.card) {
    const f = String(pm.card.funding || '').toLowerCase();
    const funding = ['credit', 'debit', 'prepaid'].includes(f) ? f : 'unknown';
    const brand = pm.card.display_brand || pm.card.brand || 'card';
    return { ok: true, method_kind: 'card', funding, display: `${brand} ending ${pm.card.last4 || '----'}` };
  }
  if (pm.type === 'us_bank_account' && pm.us_bank_account) {
    return { ok: true, method_kind: 'us_bank_account', funding: null, display: `${pm.us_bank_account.bank_name || 'Bank account'} ending ${pm.us_bank_account.last4 || '----'}` };
  }
  return { ok: false, error: 'unsupported_payment_method' };
}

const usd = (c) => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Bank (ACH) fee on the actual payment amount: two flat tiers, or one flat fee.
function achFeeFor(amountCents, config) {
  if (config.ach_tier_threshold_cents != null && amountCents > config.ach_tier_threshold_cents) return config.ach_fee_above_cents;
  return config.ach_fee_cents;
}
// Plain-language bank fee schedule for disclosures (portal, statement, terms).
function achScheduleText(config) {
  if (config.ach_tier_threshold_cents != null) {
    return `${usd(config.ach_fee_cents)} processing fee on bank account payments up to and including ${usd(config.ach_tier_threshold_cents)}; ${usd(config.ach_fee_above_cents)} above ${usd(config.ach_tier_threshold_cents)}`;
  }
  return config.ach_fee_cents > 0 ? `${usd(config.ach_fee_cents)} processing fee on bank account payments` : 'No processing fee on bank account payments';
}
// The whole plain-language schedule: portal Pay page, autopay enrollment and
// the printed statement announcement all show these same lines.
function feeScheduleLines(config) {
  return {
    card: config.card_fee_bps > 0 ? `${pctText(config.card_fee_bps)}% processing fee on card payments` : 'No processing fee on card payments',
    debit: config.debit_card_fee_bps != null ? (config.debit_card_fee_bps > 0 ? `${pctText(config.debit_card_fee_bps)}% processing fee on debit and prepaid cards` : 'No processing fee on debit or prepaid cards') : null,
    ach: achScheduleText(config),
  };
}

// Pure fee computation. assessmentCents must be a positive integer.
function computeFee({ assessmentCents, config, methodKind, funding }) {
  const a = assessmentCents;
  if (methodKind === 'us_bank_account') {
    const fee = achFeeFor(a, config);
    return { fee_cents: fee, fee_kind: fee > 0 ? 'ach_fee' : 'none', fee_label: fee > 0 ? 'Processing fee (bank account)' : null,
      disclosure: fee > 0 ? `A ${usd(fee)} processing fee is added to bank account payments.` : 'No processing fee for bank account payments.' };
  }
  if (methodKind === 'card') {
    const debitLike = funding === 'debit' || funding === 'prepaid';
    const bps = debitLike && config.debit_card_fee_bps != null ? config.debit_card_fee_bps : config.card_fee_bps;
    const fee = Math.round((a * bps) / 10000);
    return { fee_cents: fee, fee_kind: fee > 0 ? 'card_fee' : 'none', fee_bps: bps,
      fee_label: fee > 0 ? `Processing fee (${pctText(bps)}% card)` : null,
      disclosure: fee > 0 ? `A ${pctText(bps)}% processing fee (${usd(fee)}) is added to card payments.` : 'No processing fee for this card.' };
  }
  throw new Error(`unsupported method kind ${methodKind}`);
}

// ---------------------------------------------------------------- quote token
function signingKey() {
  const base = process.env.PORTAL_COOKIE_SECRET || process.env.STAFF_PASSWORD || process.env.SUPABASE_KEY || '';
  if (!base) return null;
  return crypto.createHmac('sha256', base).update('trusted-pay-quote-v1').digest();
}
const b64 = (s) => Buffer.from(s).toString('base64url');

function signQuote(q, { now = Date.now(), key = signingKey() } = {}) {
  if (!key) throw new Error('quote signing key not configured');
  const body = b64(JSON.stringify({ ...q, exp: Math.floor(now / 1000) + QUOTE_TTL_SECONDS }));
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// -> { ok:true, quote } | { ok:false, error }
function verifyQuote(token, { now = Date.now(), key = signingKey() } = {}) {
  if (!key) return { ok: false, error: 'quote_signing_not_configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'quote_invalid' };
  const expect = crypto.createHmac('sha256', key).update(parts[0]).digest();
  let got;
  try { got = Buffer.from(parts[1], 'base64url'); } catch (_) { return { ok: false, error: 'quote_invalid' }; }
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return { ok: false, error: 'quote_invalid' };
  let q;
  try { q = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { return { ok: false, error: 'quote_invalid' }; }
  if (!q || !(q.exp > Math.floor(now / 1000))) return { ok: false, error: 'quote_expired' };
  return { ok: true, quote: q };
}

module.exports = {
  validateFeeConfig, feeConfigFromCommunity, classifyPaymentMethod, computeFee,
  signQuote, verifyQuote, MAX_FEE_BPS, pctText, achFeeFor, achScheduleText, feeScheduleLines, QUOTE_TTL_SECONDS, NOT_CONFIGURED_HINT,
};
