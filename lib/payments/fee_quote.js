// ============================================================================
// lib/payments/fee_quote.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// The ONE place a homeowner assessment payment's fee is decided. Nothing in the
// browser computes a fee; the portal shows what this module returns.
//
// Why it exists: card-network rules and Texas law allow a surcharge on CREDIT
// cards only, capped at the lower of 3% or the merchant's cost of acceptance,
// disclosed before payment and on the receipt. Debit and prepaid cards are never
// surcharged. ACH may carry a flat fee. Stripe Checkout fixes the amount before
// it knows the card's funding type, so the new flow collects the payment method
// first, reads its funding type here on the server, and only then fixes the
// amount.
//
// Per-association config, FAIL-CLOSED. communities.portal_module_config.payment_fees:
//   { credit_surcharge_bps, debit_fee_cents, prepaid_as: 'debit', ach_fee_cents }
// All three numbers must be present non-negative integers (0 is a valid "no
// fee"). Missing or malformed config -> online payment is refused with a clear
// message; it never falls back to a default fee.
//
// Rules:
//   credit                   fee = round(assessment * min(bps, 300) / 10000),
//                            never above 3% (a half-cent round-up that would
//                            cross the cap is rounded down instead)
//   debit / prepaid / unknown  never surcharged; debit_fee_cents only (0 = none)
//   ACH (us_bank_account)    ach_fee_cents
//
// The quote is bound to the payment method, lot, owner tenure and amounts by an
// HMAC-signed token. Confirm re-computes everything and refuses if anything
// moved; the client's numbers are never used.
// ============================================================================
'use strict';
const crypto = require('crypto');

const MAX_SURCHARGE_BPS = 300;           // 3.00%: card-network and Texas ceiling
const QUOTE_TTL_SECONDS = 15 * 60;
const NOT_CONFIGURED_HINT = 'Online payment is not available for this association yet (payment fees have not been set up). Please contact management to pay.';

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

// -> { ok:true, config } | { ok:false, error, detail }
function validateFeeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'payment_fees_not_configured', detail: 'no payment_fees config' };
  const { credit_surcharge_bps: bps, debit_fee_cents: debit, ach_fee_cents: ach } = raw;
  const prepaidAs = raw.prepaid_as == null ? 'debit' : raw.prepaid_as;
  if (!isNonNegInt(bps)) return { ok: false, error: 'payment_fees_invalid', detail: 'credit_surcharge_bps must be a whole number of basis points >= 0' };
  if (bps > MAX_SURCHARGE_BPS) return { ok: false, error: 'payment_fees_invalid', detail: `credit_surcharge_bps may not exceed ${MAX_SURCHARGE_BPS} (3%)` };
  if (!isNonNegInt(debit)) return { ok: false, error: 'payment_fees_invalid', detail: 'debit_fee_cents must be whole cents >= 0' };
  if (!isNonNegInt(ach)) return { ok: false, error: 'payment_fees_invalid', detail: 'ach_fee_cents must be whole cents >= 0' };
  if (prepaidAs !== 'debit') return { ok: false, error: 'payment_fees_invalid', detail: "prepaid_as must be 'debit' (prepaid cards are never surcharged)" };
  return { ok: true, config: { credit_surcharge_bps: bps, debit_fee_cents: debit, prepaid_as: 'debit', ach_fee_cents: ach } };
}

function feeConfigFromCommunity(community) {
  const cfg = community && community.portal_module_config && typeof community.portal_module_config === 'object' ? community.portal_module_config : {};
  return validateFeeConfig(cfg.payment_fees);
}

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

// Pure fee computation. assessmentCents must be a positive integer.
function computeFee({ assessmentCents, config, methodKind, funding }) {
  const a = assessmentCents;
  if (methodKind === 'us_bank_account') {
    const fee = config.ach_fee_cents;
    return { fee_cents: fee, fee_kind: fee > 0 ? 'ach_fee' : 'none', fee_label: fee > 0 ? 'Bank payment fee' : null,
      disclosure: fee > 0 ? `A flat ${usd(fee)} fee applies to bank (ACH) payments.` : 'No fee for bank (ACH) payments.' };
  }
  if (methodKind === 'card' && funding === 'credit') {
    const bps = Math.min(config.credit_surcharge_bps, MAX_SURCHARGE_BPS);
    let fee = Math.round((a * bps) / 10000);
    if (fee * 10000 > a * MAX_SURCHARGE_BPS) fee = Math.floor((a * MAX_SURCHARGE_BPS) / 10000);
    const pct = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
    return { fee_cents: fee, fee_kind: fee > 0 ? 'credit_surcharge' : 'none', surcharge_bps: bps,
      fee_label: fee > 0 ? `Credit card surcharge (${pct}%)` : null,
      disclosure: fee > 0
        ? `A ${pct}% surcharge (${usd(fee)}) applies to credit card payments. It is not more than our cost of accepting credit cards. Debit cards and bank (ACH) payments are not surcharged.`
        : 'No surcharge applies to this card.' };
  }
  if (methodKind === 'card') {
    // debit, prepaid (treated as debit) and unknown funding are NEVER surcharged.
    const fee = config.debit_fee_cents;
    return { fee_cents: fee, fee_kind: fee > 0 ? 'debit_fee' : 'none', fee_label: fee > 0 ? 'Card processing fee' : null,
      disclosure: fee > 0 ? `A flat ${usd(fee)} processing fee applies to debit and prepaid card payments. No surcharge applies.` : 'No surcharge applies to debit or prepaid cards.' };
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
  signQuote, verifyQuote, MAX_SURCHARGE_BPS, QUOTE_TTL_SECONDS, NOT_CONFIGURED_HINT,
};
