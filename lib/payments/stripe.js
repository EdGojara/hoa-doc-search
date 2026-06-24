// ============================================================================
// lib/payments/stripe.js — Stripe Connect integration
// ----------------------------------------------------------------------------
// Bedrock-as-platform, each HOA as a connected Express account. Charges split
// at checkout: HOA-portion line items route to the HOA's connected account
// (settle to HOA bank), Bedrock-portion line items stay as platform fee (settle
// to Bedrock's bank). Anti-commingling per project_payment_rails.md — no
// shared float, no manual disbursement, no fiduciary exposure.
//
// Implementation uses raw fetch + crypto (same pattern as lib/notifications/email.js)
// — no npm install needed. If Stripe API surface grows beyond what's wrapped
// here, swap to the official stripe npm package at that point.
//
// Env vars expected:
//   STRIPE_SECRET_KEY       — platform account secret (sk_live_ or sk_test_)
//   STRIPE_WEBHOOK_SECRET   — webhook signing secret (whsec_)
//
// Safe-fallback: if not configured, every function returns {ok:false, skipped:true}.
// Calls are inert until env vars land in Render — same lifecycle pattern as Resend.
// ============================================================================

const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

function isConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

// ----------------------------------------------------------------------------
// Internal — POST to Stripe with optional Stripe-Account header (Connect)
// ----------------------------------------------------------------------------
async function stripePost(path, params, opts = {}) {
  const headers = {
    'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Connect: act AS a connected account. Used for retrieving HOA-account info
  // and refunds that originate from the connected account.
  if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;

  const body = encodeStripeParams(params);
  const r = await fetch(`${STRIPE_API}${path}`, { method: 'POST', headers, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.stripeCode = data?.error?.code;
    err.stripeType = data?.error?.type;
    throw err;
  }
  return data;
}

async function stripeGet(path, opts = {}) {
  const headers = { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` };
  if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
  const r = await fetch(`${STRIPE_API}${path}`, { headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
}

// Stripe wants nested params flattened to form-urlencoded. e.g.,
// { line_items: [{ price_data: { product: 'X' }}] } → line_items[0][price_data][product]=X
function encodeStripeParams(obj, prefix) {
  const parts = [];
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === null || value === undefined) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object' && v !== null) {
          parts.push(encodeStripeParams(v, `${k}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(v)}`);
        }
      });
    } else if (typeof value === 'object') {
      parts.push(encodeStripeParams(value, k));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

// ============================================================================
// createCheckoutSession
// ----------------------------------------------------------------------------
// Builds a Stripe Connect Checkout Session for a multi-fee transaction.
//
// Architecture: "destination charges with application fee."
//   - All line items charge the homeowner's card in ONE transaction
//   - The full amount lands in the HOA's connected account
//   - Bedrock's portion (sum of management_company line items) is automatically
//     transferred back to Bedrock's platform account via application_fee_amount
//   - Net effect: HOA bank gets HOA fees; Bedrock bank gets management fees;
//     no co-mingling at any point
//
// Args:
//   - fees: [{ label, amount_cents, payee, fee_type }]
//   - connectedAccountId: HOA's acct_xxx (required when any fee has payee=community_association)
//   - customer: { email, name }
//   - reference: rental reference number (used as Stripe metadata + descriptor)
//   - productType, productId: for webhook → DB matching
//   - successUrl, cancelUrl: where to redirect after Checkout
//   - communityName, communityId: for metadata
//
// Returns: { ok, session_id, checkout_url, ...} or { ok:false, skipped:true } if not configured
// ============================================================================
async function createCheckoutSession(opts) {
  if (!isConfigured()) {
    return { ok: false, skipped: true, error: 'stripe_not_configured' };
  }
  const {
    fees = [],
    connectedAccountId,
    customer = {},
    reference,
    productType,
    productId,
    successUrl,
    cancelUrl,
    communityName,
    communityId,
    statementDescriptor,
  } = opts;

  if (!fees.length) return { ok: false, error: 'no fees to charge' };
  if (!successUrl || !cancelUrl) return { ok: false, error: 'success_url and cancel_url are required' };

  // Sum the management-company portion → application fee (kept by Bedrock)
  const platformFeeCents = fees
    .filter((f) => f.payee === 'management_company')
    .reduce((sum, f) => sum + f.amount_cents, 0);

  // If any HOA-side fee exists, connectedAccountId must be set
  const hasHoaFee = fees.some((f) => f.payee === 'community_association');
  if (hasHoaFee && !connectedAccountId) {
    return { ok: false, error: 'community has no connected Stripe account configured' };
  }

  // Build line items (one per fee)
  const lineItems = fees.map((f) => ({
    quantity: 1,
    price_data: {
      currency: 'usd',
      unit_amount: f.amount_cents,
      product_data: {
        name: f.label,
        description: f.fee_type === 'security_deposit'
          ? 'Refundable security deposit'
          : f.fee_type === 'av_equipment_deposit'
          ? 'Refundable AV equipment deposit'
          : undefined,
      },
    },
  }));

  // Checkout Session params
  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: lineItems,
    customer_email: customer.email || undefined,
    submit_type: 'pay',
    // Payment rails: default to card (Stripe's default). Callers can pass
    // ['us_bank_account'] for ACH or ['card','us_bank_account'] to offer both —
    // ACH is the low-cost rail for HOA assessments (0.8%, $5 cap).
    ...(opts.paymentMethodTypes && opts.paymentMethodTypes.length
      ? { payment_method_types: opts.paymentMethodTypes }
      : {}),
    payment_intent_data: {
      // Statement descriptor: what shows up on the homeowner's card statement.
      // Stripe limits to 22 chars. Use community name short form.
      statement_descriptor_suffix: (statementDescriptor || communityName || 'Bedrock').slice(0, 22),
      metadata: {
        product_type: productType || '',
        product_id: productId || '',
        reference_number: reference || '',
        community_id: communityId || '',
        community_name: communityName || '',
      },
    },
    metadata: {
      product_type: productType || '',
      product_id: productId || '',
      reference_number: reference || '',
      community_id: communityId || '',
    },
  };

  // Stripe Connect routing: destination charge with application fee
  if (hasHoaFee) {
    params.payment_intent_data.transfer_data = { destination: connectedAccountId };
    if (platformFeeCents > 0) {
      params.payment_intent_data.application_fee_amount = platformFeeCents;
    }
  }
  // If ONLY management-company fees (no HOA portion), don't set transfer_data —
  // the whole amount stays on the platform account.

  try {
    const session = await stripePost('/checkout/sessions', params);
    return {
      ok: true,
      session_id: session.id,
      checkout_url: session.url,
      payment_intent: session.payment_intent || null,
      platform_fee_cents: platformFeeCents,
      destination: hasHoaFee ? connectedAccountId : null,
    };
  } catch (err) {
    return { ok: false, error: err.message, stripeCode: err.stripeCode, stripeType: err.stripeType };
  }
}

// ============================================================================
// createConnectedAccount — one Express account per HOA (the per-association
// "sub-account" so funds route to that HOA's own bank, never pooled).
// Requests card + ACH + transfers capabilities. Returns { ok, account_id }.
// ============================================================================
async function createConnectedAccount(opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const { communityId, communityName, email } = opts;
  const params = {
    type: 'express',
    country: 'US',
    email: email || undefined,
    business_type: 'company',
    'capabilities[card_payments][requested]': 'true',
    'capabilities[transfers][requested]': 'true',
    'capabilities[us_bank_account_ach_payments][requested]': 'true',
    'business_profile[name]': communityName || undefined,
    'business_profile[mcc]': '6513', // real estate agents/managers — closest MCC for HOA dues
    'metadata[community_id]': communityId || '',
    'metadata[community_name]': communityName || '',
  };
  try {
    const acct = await stripePost('/accounts', params);
    return { ok: true, account_id: acct.id, details_submitted: !!acct.details_submitted, charges_enabled: !!acct.charges_enabled };
  } catch (err) {
    return { ok: false, error: err.message, stripeCode: err.stripeCode };
  }
}

// ============================================================================
// createAccountLink — the hosted onboarding URL the HOA board completes (bank +
// KYC). type=account_onboarding. Returns { ok, url } (single-use, expires).
// ============================================================================
async function createAccountLink(opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const { accountId, refreshUrl, returnUrl } = opts;
  if (!accountId || !refreshUrl || !returnUrl) return { ok: false, error: 'accountId, refreshUrl, returnUrl required' };
  try {
    const link = await stripePost('/account_links', {
      account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
    });
    return { ok: true, url: link.url, expires_at: link.expires_at };
  } catch (err) {
    return { ok: false, error: err.message, stripeCode: err.stripeCode };
  }
}

// ============================================================================
// retrieveAccount — current onboarding/capability status of a connected account.
// ============================================================================
async function retrieveAccount(accountId) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const a = await stripeGet(`/accounts/${encodeURIComponent(accountId)}`);
    return {
      ok: true,
      account_id: a.id,
      details_submitted: !!a.details_submitted,
      charges_enabled: !!a.charges_enabled,
      payouts_enabled: !!a.payouts_enabled,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// retrieveSession — used by success_url page to confirm session completed
// ============================================================================
async function retrieveSession(sessionId) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const session = await stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// refund
// ----------------------------------------------------------------------------
// Refund a payment (full or partial). For Stripe Connect destination charges,
// the refund originates from the connected account (where the money lives) —
// we must pass Stripe-Account header so Stripe knows to debit the HOA's balance
// (not Bedrock's platform balance) for that portion.
//
// Args:
//   - paymentIntentId: pi_xxx
//   - amountCents: amount to refund (omit for full refund)
//   - connectedAccountId: HOA acct_xxx (required if the original charge was HOA-side)
//   - reverseTransfer: true → also reverse the application fee back to the connected account
//                      false → Bedrock keeps the platform fee even on refund (default for cancellations)
//   - reason: 'requested_by_customer' | 'duplicate' | 'fraudulent' | string
// ============================================================================
async function refund(opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const { paymentIntentId, amountCents, connectedAccountId, reason, reverseTransfer } = opts;
  if (!paymentIntentId) return { ok: false, error: 'paymentIntentId required' };

  const params = {
    payment_intent: paymentIntentId,
  };
  if (amountCents) params.amount = amountCents;
  if (reason) params.reason = reason;
  if (reverseTransfer) params.reverse_transfer = 'true';

  try {
    const r = await stripePost('/refunds', params, {
      stripeAccount: connectedAccountId || undefined,
    });
    return {
      ok: true,
      refund_id: r.id,
      amount_cents: r.amount,
      status: r.status,
    };
  } catch (err) {
    return { ok: false, error: err.message, stripeCode: err.stripeCode };
  }
}

// ============================================================================
// verifyWebhookSignature
// ----------------------------------------------------------------------------
// Stripe signs every webhook with a timestamped HMAC-SHA256. Standard scheme:
//   header: 'Stripe-Signature: t=1490000000,v1=signature'
//   signed_payload = `${timestamp}.${raw_body}`
//   expected = HMAC-SHA256(STRIPE_WEBHOOK_SECRET, signed_payload)
//   verify v1 == expected
// Reject events older than 5 minutes (Stripe's recommended tolerance).
// ============================================================================
function verifyWebhookSignature(rawBody, sigHeader, secret) {
  if (!rawBody || !sigHeader || !secret) return { ok: false, error: 'missing inputs' };
  const parts = String(sigHeader).split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return { ok: false, error: 'bad signature header' };

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (Number.isNaN(age) || age > 300) {
    return { ok: false, error: `signature timestamp too old (${age}s)` };
  }

  const signedPayload = `${timestamp}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  try {
    const match = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    if (!match) return { ok: false, error: 'signature mismatch' };
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'signature length mismatch' };
  }
}

module.exports = {
  isConfigured,
  createCheckoutSession,
  retrieveSession,
  refund,
  verifyWebhookSignature,
  createConnectedAccount,
  createAccountLink,
  retrieveAccount,
};
