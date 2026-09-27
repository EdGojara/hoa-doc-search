// ============================================================================
// Universal Payments API
// ----------------------------------------------------------------------------
// Mounted at /api/payments.
//
// Routes through ANY revenue surface (amenity rentals today; ARC fees,
// builder fees, key fobs tomorrow). Per project_payment_rails.md:
//   - Vantaca = assessments (separate rail)
//   - Stripe Connect = non-assessment revenue (this file)
//   - One `payments` table for the whole platform
//   - Anti-commingling: HOA fees route to HOA Connect account; Bedrock fees
//     stay on platform; never share an account
//
// Endpoints:
//   POST /api/payments/create-checkout-session    create Stripe Checkout for a product
//   POST /api/payments/webhook                    Stripe webhook (raw body, signature-verified)
//   GET  /api/payments/by-session/:session_id     used by success page (no PII surface)
//   POST /api/payments/:id/refund                 admin refund action
//   GET  /api/payments/:id                        admin view of a single payment row
//
// Stripe gracefully degrades when env vars aren't set — returns 503 with a clear
// "not configured" message instead of 500.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const stripeLib = require('../lib/payments/stripe');
const { sendEmail } = require('../lib/notifications/email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function dollars(cents) {
  return (Number(cents || 0) / 100).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
  });
}

// SANDBOX-ONLY webhook signature diagnostic. Returns enough to distinguish a
// wrong/whitespace-laden secret from an altered body, WITHOUT leaking the full
// secret or signatures (prefixes only). Computes the expected signature with
// both the raw and trimmed secret so a trailing-newline env var is obvious.
function _webhookSigDiag(rawBody, sigHeader, secret) {
  const crypto = require('crypto');
  const parts = String(sigHeader || '').split(',').reduce((a, p) => {
    const [k, v] = p.split('='); if (k && v) a[k.trim()] = v.trim(); return a;
  }, {});
  const t = parts.t, v1 = parts.v1 || '';
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const sec = secret || '';
  const sign = (s) => (t ? crypto.createHmac('sha256', s).update(`${t}.${bodyStr}`).digest('hex') : '');
  const expRaw = sign(sec), expTrim = sign(sec.trim());
  return {
    body_len: bodyStr.length,
    body_is_buffer: Buffer.isBuffer(rawBody),
    body_head: bodyStr.slice(0, 24),
    body_tail: bodyStr.slice(-24),
    secret_present: !!secret,
    secret_len: sec.length,
    secret_prefix: sec.slice(0, 8),
    secret_has_whitespace: sec !== sec.trim(),
    ts: t || null,
    recv_v1_head: v1.slice(0, 12),
    expected_raw_head: expRaw.slice(0, 12),
    expected_trim_head: expTrim.slice(0, 12),
    matches_raw: !!v1 && v1 === expRaw,
    matches_trimmed: !!v1 && v1 === expTrim,
  };
}

async function fetchActiveFees(amenityId) {
  const { data, error } = await supabase
    .from('amenity_fee_schedule')
    .select('*')
    .eq('amenity_id', amenityId)
    .is('effective_to', null)
    .order('display_order');
  if (error) throw error;
  return data || [];
}

// Resolve the amenity + community + connected account for a rental
async function loadRentalContext(rentalId) {
  const { data: rental, error } = await supabase
    .from('amenity_rentals')
    .select(`
      *,
      amenity:amenities(id, name, amenity_type, community_id),
      community:communities(id, name, slug, hoa_legal_name, stripe_connected_account_id, amenity_bookings_active)
    `)
    .eq('id', rentalId)
    .maybeSingle();
  if (error) throw error;
  return rental;
}

// Can a real charge happen for THIS rental, right now?
//
// The preview's original gate was "are Stripe keys configured", which was wrong
// and made the whole thing dead on arrival in production: the keys ARE set on
// Render, so `stripeLib.isConfigured()` is true and the preview refused itself
// on the only environment Ed actually uses. (Found 2026-08-21 by walking the
// live site: stripe_configured true, stripe_ready false.)
//
// Keys are not the question. The question is whether this ASSOCIATION can be
// paid. Waterview has no connected account, so the live path 503s with
// community_stripe_not_onboarded no matter how good the keys are — there is no
// real checkout for the preview to shadow.
//
// That makes this gate safe by construction: the moment a community finishes
// Connect onboarding, a real charge becomes possible and the preview refuses.
async function chargeIsImpossible(body) {
  if (!stripeLib.isConfigured()) return true;
  const rental = await loadRentalContext(body.product_id);
  if (!rental) return false;                        // let the live path 404 properly
  return !rental.community.stripe_connected_account_id;
}

// Work out what checkout WOULD charge, without charging anything.
//
// Deliberately shares loadRentalContext / fetchActiveFees with the live path
// rather than reimplementing the arithmetic. A preview computed by different
// code is a preview of a different system, and the whole point is to see the
// real numbers and the real payee split before the money is switched on.
async function buildCheckoutPreview(body) {
  const { product_type, product_id, selected_addons } = body;
  if (product_type !== 'amenity_rental') return { error: 'unsupported product_type for v0 (only amenity_rental)', status: 400 };
  if (!product_id) return { error: 'product_id is required', status: 400 };

  const rental = await loadRentalContext(product_id);
  if (!rental) return { error: 'rental not found', status: 404 };

  const fees = await fetchActiveFees(rental.amenity_id);
  if (!fees.length) return { error: 'no active fee schedule for this amenity', status: 500 };

  const addons = selected_addons || rental.optional_addons || {};
  const applicable = fees.filter((f) => f.required || (f.fee_type === 'av_equipment_deposit' && addons.av_equipment === true));
  const chargeFees = applicable.filter((f) => f.amount_cents > 0 && f.payee_display_name);
  if (!chargeFees.length) return { error: 'no chargeable fees on schedule', status: 500 };

  const qs = new URLSearchParams({ rental: rental.id });
  if (addons.av_equipment === true) qs.set('av', '1');
  return { url: `/clubhouse/${rental.community.slug}/preview-checkout?${qs.toString()}` };
}

// ============================================================================
// GET /api/payments/preview/:rentalId — the numbers behind the preview page.
//
// Same loaders as the live path. Returns the line items, the payee split, and
// the exact argument object that would be handed to Stripe, because "show me
// where the Stripe payment goes" is answered by the payload, not by a mockup.
// Refuses once Stripe is configured — after that the real thing exists.
// ============================================================================
router.get('/preview/:rentalId', async (req, res) => {
  try {
    const rental = await loadRentalContext(req.params.rentalId);
    if (!rental) return res.status(404).json({ error: 'rental not found' });
    // Refuse only when a REAL charge is possible for this association — see
    // chargeIsImpossible. Gating on "are keys configured" killed the preview in
    // production, where the keys are set but no community is onboarded yet.
    if (stripeLib.isConfigured() && rental.community.stripe_connected_account_id) {
      return res.status(409).json({
        error: 'preview_disabled',
        hint: `${rental.community.name} can take real payments now, so checkout is live. The preview only exists before a community is onboarded.`,
      });
    }

    const fees = await fetchActiveFees(rental.amenity_id);
    const wantsAv = req.query.av === '1';
    const applicable = fees.filter((f) => f.required || (f.fee_type === 'av_equipment_deposit' && wantsAv));
    const chargeFees = applicable.filter((f) => f.amount_cents > 0 && f.payee_display_name);

    const totalCents = chargeFees.reduce((s, f) => s + f.amount_cents, 0);
    const split = {};
    for (const f of chargeFees) {
      const k = f.payee_display_name;
      split[k] = (split[k] || 0) + f.amount_cents;
    }

    const needsConnect = chargeFees.some((f) => f.payee === 'community_association');
    res.json({
      ok: true,
      preview: true,
      reference: rental.reference_number,
      community: { name: rental.community.name, slug: rental.community.slug },
      amenity: rental.amenity ? rental.amenity.name : null,
      event_date: rental.event_date,
      renter: { name: rental.renter_name },
      line_items: chargeFees.map((f) => ({
        label: f.label, amount_cents: f.amount_cents,
        fee_type: f.fee_type, payee: f.payee, payee_display_name: f.payee_display_name,
        refundable: !!f.refundable,
      })),
      total_cents: totalCents,
      payee_split: Object.entries(split).map(([name, cents]) => ({ payee_display_name: name, amount_cents: cents })),
      // What the live path would hand to Stripe. Shown so the hand-off is
      // inspectable before any key is set, rather than taken on trust.
      would_send_to_stripe: {
        mode: 'payment',
        connected_account: rental.community.stripe_connected_account_id || null,
        connect_ready: !!rental.community.stripe_connected_account_id,
        statement_descriptor: rental.community.slug?.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 22) || 'BEDROCK',
        customer_email: rental.renter_email ? '(the renter\'s email)' : null,
        line_items: chargeFees.map((f) => ({ name: f.label, amount_cents: f.amount_cents })),
        metadata: { product_type: 'amenity_rental', product_id: rental.id, reference: rental.reference_number },
      },
      blockers: [
        ...(stripeLib.isConfigured() ? [] : ['STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not set.']),
        ...(needsConnect && !rental.community.stripe_connected_account_id
          ? [`${rental.community.hoa_legal_name || rental.community.name} has not completed Stripe Connect onboarding, and ${dollars(split[chargeFees.find((f) => f.payee === 'community_association').payee_display_name] || 0)} of this is owed to the association.`]
          : []),
      ],
    });
  } catch (err) {
    console.error('[payments] preview failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/payments/create-checkout-session
// Body: {
//   product_type: 'amenity_rental',
//   product_id: <amenity_rentals.id>,
//   selected_addons?: { av_equipment: true },
//   success_url, cancel_url
// }
// Returns: { ok, checkout_url, session_id }
// ============================================================================
router.post('/create-checkout-session', express.json({ limit: '128kb' }), async (req, res) => {
  try {
    // PREVIEW. Ed 2026-08-21: "i want to be able to see everything including the
    // payment processing and stripe link, we will wire it after."
    //
    // Waterview stops at "Online payments coming soon" and demo mode pauses at
    // submit, so there has been no way to walk the checkout step at all — the
    // one part of the flow nobody has ever seen. This runs every piece of the
    // real logic (the rental, the active fee schedule, the payee split, the
    // Connect requirement) and stops exactly where the Stripe call would go,
    // handing back a page that shows what would have been sent.
    //
    // Three things keep it from ever being mistaken for money:
    //   - it ONLY exists while Stripe is unconfigured. The moment real keys are
    //     set this branch is unreachable, so it can never shadow a live payment.
    //   - it writes NO payment rows. Nothing lands in the payments table, so
    //     nothing can reach the GL or an AR balance.
    //   - the page it returns has no card field of any kind. A card-shaped box
    //     on a non-PCI page is an invitation to type a real card number into it.
    const wantsPreview = (req.body || {}).preview === true;
    if (wantsPreview && await chargeIsImpossible(req.body || {})) {
      const preview = await buildCheckoutPreview(req.body || {});
      if (preview.error) return res.status(preview.status || 400).json({ error: preview.error, hint: preview.hint });
      return res.json({ ok: true, preview: true, checkout_url: preview.url });
    }

    if (!stripeLib.isConfigured()) {
      return res.status(503).json({
        error: 'payment_not_configured',
        hint: 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Render env to enable online payments.',
      });
    }

    const { product_type, product_id, selected_addons, success_url, cancel_url } = req.body || {};
    if (product_type !== 'amenity_rental') {
      return res.status(400).json({ error: 'unsupported product_type for v0 (only amenity_rental)' });
    }
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    if (!success_url || !cancel_url) return res.status(400).json({ error: 'success_url and cancel_url are required' });

    const rental = await loadRentalContext(product_id);
    if (!rental) return res.status(404).json({ error: 'rental not found' });
    if (!rental.community.amenity_bookings_active) {
      return res.status(403).json({ error: 'amenity bookings are not active for this community' });
    }
    // Never take money for a community we have stopped managing, or one whose
    // payments are switched off. The association would have to refund it, and
    // taking a homeowner's money on behalf of an association we no longer act
    // for is the kind of mistake that outlives the engagement. (Ed 2026-08-21.)
    {
      const { canDo } = require('../lib/community/lifecycle');
      const gate = await canDo('payments', rental.community.id);
      if (!gate.allowed) {
        return res.status(409).json({ error: 'community_not_taking_payments', detail: gate.reason });
      }
    }
    if (rental.status !== 'draft' && rental.status !== 'pending_payment') {
      return res.status(409).json({ error: `rental status is ${rental.status}; checkout no longer applies` });
    }

    // Load active fee schedule for the amenity
    const fees = await fetchActiveFees(rental.amenity_id);
    if (!fees.length) return res.status(500).json({ error: 'no active fee schedule for this amenity' });

    // Apply selected addons (currently just av_equipment_deposit)
    const addons = selected_addons || rental.optional_addons || {};
    const applicableFees = fees.filter((f) =>
      f.required || (f.fee_type === 'av_equipment_deposit' && addons.av_equipment === true)
    );

    // Cull any fee that has zero amount or no payee_display_name
    const chargeFees = applicableFees.filter((f) => f.amount_cents > 0 && f.payee_display_name);

    if (!chargeFees.length) return res.status(500).json({ error: 'no chargeable fees on schedule' });

    // Pre-flight: HOA-side fees require a connected account
    const needsConnect = chargeFees.some((f) => f.payee === 'community_association');
    if (needsConnect && !rental.community.stripe_connected_account_id) {
      return res.status(503).json({
        error: 'community_stripe_not_onboarded',
        hint: `${rental.community.hoa_legal_name || rental.community.name} has not completed Stripe Connect onboarding yet. Run Connect Express onboarding before accepting online payments.`,
      });
    }

    // Create Stripe Checkout Session
    const session = await stripeLib.createCheckoutSession({
      fees: chargeFees.map((f) => ({
        label: f.label,
        amount_cents: f.amount_cents,
        payee: f.payee,
        fee_type: f.fee_type,
      })),
      connectedAccountId: rental.community.stripe_connected_account_id,
      customer: {
        email: rental.renter_email,
        name: rental.renter_name,
      },
      reference: rental.reference_number,
      productType: 'amenity_rental',
      productId: rental.id,
      successUrl: success_url,
      cancelUrl: cancel_url,
      communityName: rental.community.name,
      communityId: rental.community.id,
      statementDescriptor: rental.community.slug?.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 22) || 'BEDROCK',
    });

    if (!session.ok) {
      return res.status(session.skipped ? 503 : 500).json({
        error: session.error || 'checkout session creation failed',
        stripeCode: session.stripeCode,
      });
    }

    // Insert one pending payment row per fee, all linked to the same checkout session
    const paymentInserts = chargeFees.map((f) => ({
      community_id: rental.community.id,
      product_type: 'amenity_rental',
      product_id: rental.id,
      fee_type: f.fee_type,
      payee: f.payee,
      payee_display_name: f.payee_display_name,
      connected_account_id: f.payee === 'community_association'
        ? rental.community.stripe_connected_account_id
        : null,
      amount_cents: f.amount_cents,
      refundable: f.refundable,
      method: 'stripe_checkout',
      processor: 'stripe',
      processor_session_id: session.session_id,
      status: 'pending',
      initiated_by: 'homeowner_portal',
    }));
    const { error: rentalLedgerErr } = await supabase.from('payments').insert(paymentInserts);
    if (rentalLedgerErr) {
      // Same class of bug as the assessment path — never swallow a ledger write.
      console.error('[payments] amenity ledger insert failed:', rentalLedgerErr.message);
      return res.status(500).json({ error: 'payment_ledger_insert_failed', detail: safeErrorMessage(rentalLedgerErr) });
    }

    // Bump rental status to pending_payment so we know they're at checkout
    await supabase
      .from('amenity_rentals')
      .update({
        status: 'pending_payment',
        optional_addons: addons,
      })
      .eq('id', rental.id);

    res.json({
      ok: true,
      checkout_url: session.checkout_url,
      session_id: session.session_id,
      reference_number: rental.reference_number,
    });
  } catch (err) {
    console.error('[payments] create-checkout-session failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// Assessment checkout (homeowner portal, signed pay link, staff test route)
// ----------------------------------------------------------------------------
// Homeowner pays their assessment balance on the same Connect rails as amenity
// rentals: the FULL assessment routes to the community's connected account (HOA
// bank), never pooled. Card adds a grossed-up convenience fee routed as the
// platform application fee; ACH carries none. The management fee is never
// skimmed here. Crediting happens only in the webhook, after Stripe confirms the
// money (lib/payments/payment_lifecycle.js).
// ============================================================================
// Callers pass ONLY a property they have already authorized (portal session,
// signed pay link, test route). Owner, tenure, amount and identity are decided
// server-side in lib/payments/assessment_checkout.js; nothing from the browser
// is trusted beyond the payment-method choice.
// Checkout requires an explicit acceptance of the current Trusted Pay terms plus
// the signed quote the payer reviewed (lib/payments/assessment_checkout.js).
async function createAssessmentCheckout({ property_id, payment_method, initiated_by, success_url, cancel_url, payer, portal_user_id = null, test_amount_cents = null, acceptance = null }) {
  const core = require('../lib/payments/assessment_checkout');
  return core.createAssessmentCheckout({ supabase, stripeLib }, {
    propertyId: property_id, paymentMethod: payment_method, initiatedBy: initiated_by,
    successUrl: success_url, cancelUrl: cancel_url, payer: payer || {}, portalUserId: portal_user_id,
    testAmountCents: test_amount_cents, acceptance,
  });
}
// Read-only review quote (Amount, Payment Processing Fee, Total) for both methods.
async function quoteAssessmentPayment({ property_id, actor, initiated_by, test_amount_cents = null }) {
  const core = require('../lib/payments/assessment_checkout');
  return core.quoteAssessmentPayment({ supabase, stripeLib }, { propertyId: property_id, actor, initiatedBy: initiated_by, testAmountCents: test_amount_cents });
}

// Retired 2026-09-27: it trusted community/property/amount from the request body.
// Homeowners pay via POST /api/portal/pay/checkout (portal session); staff test
// via POST /api/payments/test/assessment-checkout (test mode only).
router.post('/assessment/create-checkout', (req, res) => {
  res.status(410).json({ error: 'endpoint_retired', detail: 'Homeowners pay from the portal; staff tests use /api/payments/test/assessment-checkout.' });
});

// POST /api/payments/test/assessment-checkout  (staff, TEST MODE ONLY)
// A $1.00 sandbox checkout, with the same review + terms step homeowners get:
//   1. { property_id }                                    -> quote (Amount, Payment Processing Fee, Total) + quote tokens
//   2. { property_id, payment_method, quote_token, accept_terms: true } -> checkout
// Refuses unless the server's Stripe key is a test key, so it can never become a
// real charge (and the mode gate limits it to the payment-sandbox lot).
router.post('/test/assessment-checkout', express.json({ limit: '8kb' }), async (req, res) => {
  const { requireTestMode } = require('../lib/payments/stripe_mode');
  if (!requireTestMode(res)) return;
  try {
    const b = req.body || {};
    if (!b.property_id) return res.status(400).json({ error: 'property_id_required' });
    const actor = 'staff:test-route';
    if (!b.quote_token) {
      const q = await quoteAssessmentPayment({ property_id: String(b.property_id), actor, initiated_by: 'staff_test', test_amount_cents: 100 });
      if (!q.ok) return res.status(q.status || 500).json({ error: q.error, hint: q.hint });
      return res.json({ ok: true, step: 'review', ...q });
    }
    const origin = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const r = await createAssessmentCheckout({
      property_id: String(b.property_id), payment_method: b.payment_method, initiated_by: 'staff_test',
      success_url: `${origin}/accounting?test_payment=success`, cancel_url: `${origin}/accounting?test_payment=cancelled`,
      test_amount_cents: 100,
      acceptance: { accepted: b.accept_terms === true, quoteToken: String(b.quote_token), actor, actorLabel: 'staff test route', source: 'staff_test' },
    });
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error, hint: r.hint, detail: r.detail });
    res.json(r);
  } catch (err) {
    console.error('[payments] test checkout failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/payments/test/payment-sandbox  { action: plan | apply | plan_remove | remove }
// (admin, TEST MODE ONLY). Provisions or removes the Drama Creek payment-sandbox
// lot, in one transaction; the plan actions run everything and roll back.
// See lib/payments/payment_sandbox_provision.js for every row it touches.
router.post('/test/payment-sandbox', express.json({ limit: '4kb' }), async (req, res) => {
  const { requireTestMode } = require('../lib/payments/stripe_mode');
  if (!requireTestMode(res)) return;
  let client = null;
  try {
    const { resolveUserRole } = require('./users');
    const ctx = await resolveUserRole(req);
    if (!ctx.supabaseUserId || ctx.role !== 'admin') return res.status(403).json({ error: 'admin role required' });
    const action = String((req.body && req.body.action) || 'plan');
    if (!['plan', 'apply', 'plan_remove', 'remove'].includes(action)) return res.status(400).json({ error: 'action must be plan, apply, plan_remove or remove' });
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'DATABASE_URL not set on the server' });
    const { Client } = require('pg');
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    const { runPaymentSandbox } = require('../lib/payments/payment_sandbox_provision');
    const r = await runPaymentSandbox(client, { action });
    console.log('[payments] payment sandbox', action, 'by', ctx.user && ctx.user.email, 'committed:', r.committed);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[payments] payment sandbox failed:', err.message);
    res.status(/^refused/.test(err.message) ? 409 : 500).json({ error: /^refused|migration 469/.test(err.message) ? err.message : safeErrorMessage(err) });
  } finally {
    if (client) client.end().catch(() => {});
  }
});

// POST /api/payments/:id/retry-posting  (staff)
// Re-runs posting for a SETTLED payment that was blocked (closed period, missing
// account). Idempotent: it resumes where it stopped and can never post twice.
router.post('/:id/retry-posting', async (req, res) => {
  try {
    const { createPaymentStore } = require('../lib/payments/payment_store');
    const { centralDate } = require('../lib/payments/payment_lifecycle');
    const { data: p, error } = await supabase.from('payments').select('id, settlement_state, posting_state, settled_at, fee_type').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!p || p.fee_type !== 'assessment') return res.status(404).json({ error: 'assessment_payment_not_found' });
    if (p.settlement_state !== 'settled') return res.status(409).json({ error: 'not_settled', settlement_state: p.settlement_state });
    const store = createPaymentStore({ supabase });
    const date = centralDate(p.settled_at ? Math.floor(new Date(p.settled_at).getTime() / 1000) : null);
    res.json({ ok: true, result: await store.postPayment(p.id, { paymentDate: date }) });
  } catch (err) {
    console.error('[payments] retry-posting failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/payments/payment-link  { community_id, property_id }  (staff)
// Mint a STABLE, emailable pay link for a homeowner's balance. Does NOT require
// Stripe to be live to mint (staff can prepare), but reports readiness. The link
// resolves the balance + mints a fresh checkout only when clicked (/pay/:token).
router.post('/payment-link', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id || !b.property_id) return res.status(400).json({ error: 'community_id_and_property_id_required' });
    // Verify the property actually belongs to the community (never mint a link
    // that crosses communities).
    const { data: prop, error: pErr } = await supabase.from('properties')
      .select('id, community_id, street_address').eq('id', b.property_id).maybeSingle();
    if (pErr) throw pErr;
    if (!prop || prop.community_id !== b.community_id) return res.status(404).json({ error: 'property_not_in_community' });

    const { resolvePaymentIdentity } = require('../lib/payments/payment_identity');
    const idr = await resolvePaymentIdentity(supabase, b.property_id);
    if (!idr.ok) return res.status(idr.status || 409).json({ error: idr.error, hint: idr.hint });
    const { signPaymentToken, paymentLinkUrl } = require('../lib/payments/payment_link');
    const token = signPaymentToken({ community_id: b.community_id, property_id: b.property_id, tenure_id: idr.identity.tenure.id });
    // An emailed link MUST be absolute — fall back to the request origin when
    // APP_BASE_URL isn't set (dev), so staff never copy a relative /pay/... URL.
    const base = process.env.APP_BASE_URL || (req.protocol + '://' + req.get('host'));
    const url = paymentLinkUrl(token, base);
    res.json({
      ok: true, url, token,
      property_address: prop.street_address,
      stripe_ready: stripeLib.isConfigured(),
      note: stripeLib.isConfigured() ? null : 'Link is generated but Stripe is not configured yet — it will not charge until keys + Connect onboarding are live.',
    });
  } catch (err) {
    console.error('[payments] payment-link mint failed:', err.message);
    if (err.code === 'payment_link_not_configured') {
      return res.status(503).json({ error: 'payment_link_not_configured', hint: 'Payment links are disabled until PAYMENT_LINK_SECRET is set on the server.' });
    }
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/payments/connect/onboard   { community_id, return_url? }   (staff)
// Ensure the community has a connected account; return the hosted onboarding URL
// for the board to complete (bank + KYC). Idempotent — reuses an existing account.
// ============================================================================
router.post('/connect/onboard', express.json(), async (req, res) => {
  try {
    if (!stripeLib.isConfigured()) return res.status(503).json({ error: 'payment_not_configured', hint: 'Set STRIPE_SECRET_KEY first.' });
    const { community_id, return_url } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });

    // Don't onboard a community we are winding down.
    //
    // Ed 2026-08-21: "we aren't going to onboard eaglewood, we are losing them
    // as a client." Connect onboarding creates a real Stripe account in the
    // ASSOCIATION's name and asks a board officer for their identity documents.
    // Starting that for a client we stop managing on 9/30 wastes their time and
    // leaves an orphaned account nobody closes.
    //
    // Enforced here rather than only in the UI, because the UI lists every
    // community and one wrong click is all it takes.
    const { canDo } = require('../lib/community/lifecycle');
    const gate = await canDo('payments', community_id);
    if (!gate.allowed) {
      return res.status(409).json({ error: 'community_not_taking_payments', detail: gate.reason });
    }

    const { data: community } = await supabase.from('communities')
      .select('id, name, hoa_legal_name, stripe_connected_account_id').eq('id', community_id).maybeSingle();
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    let accountId = community.stripe_connected_account_id;
    if (!accountId) {
      // Recover an account we already created for this community (DB link may
      // have been lost on an earlier store failure) before making a new one.
      const existing = await stripeLib.findConnectedAccountByCommunity(community.id);
      if (existing.ok && existing.account_id) {
        accountId = existing.account_id;
      } else {
        const acct = await stripeLib.createConnectedAccount({ communityId: community.id, communityName: community.hoa_legal_name || community.name });
        if (!acct.ok) return res.status(500).json({ error: acct.error || 'account_create_failed', stripeCode: acct.stripeCode });
        accountId = acct.account_id;
      }
      await supabase.from('communities').update({ stripe_connected_account_id: accountId, stripe_onboarding_status: 'in_progress' }).eq('id', community.id);
    }
    const base = return_url || `${req.protocol}://${req.get('host')}/admin/accounting`;
    const link = await stripeLib.createAccountLink({
      accountId, refreshUrl: base,
      returnUrl: base + (base.includes('?') ? '&' : '?') + 'stripe_onboarded=1',
    });
    if (!link.ok) return res.status(500).json({ error: link.error || 'link_create_failed' });
    res.json({ ok: true, account_id: accountId, onboarding_url: link.url });
  } catch (err) {
    console.error('[payments] connect onboard failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/payments/connect/status?community_id   (staff) — onboarding status
router.get('/connect/status', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data: community } = await supabase.from('communities')
      .select('id, name, stripe_connected_account_id, stripe_onboarding_status').eq('id', community_id).maybeSingle();
    if (!community) return res.status(404).json({ error: 'community_not_found' });
    if (!community.stripe_connected_account_id) return res.json({ ok: true, has_account: false, onboarded: false });
    if (!stripeLib.isConfigured()) return res.json({ ok: true, has_account: true, account_id: community.stripe_connected_account_id, onboarded: community.stripe_onboarding_status === 'enabled' });

    const st = await stripeLib.retrieveAccount(community.stripe_connected_account_id);
    const onboarded = !!(st.ok && st.details_submitted && st.charges_enabled);
    const newStatus = onboarded ? 'enabled' : (st.details_submitted ? 'restricted' : 'in_progress');
    if (community.stripe_onboarding_status !== newStatus) {
      await supabase.from('communities').update({
        stripe_onboarding_status: newStatus,
        ...(onboarded ? { stripe_onboarded_at: new Date().toISOString() } : {}),
      }).eq('id', community.id);
    }
    res.json({ ok: true, has_account: true, account_id: community.stripe_connected_account_id, onboarded, details_submitted: st.details_submitted, charges_enabled: st.charges_enabled, payouts_enabled: st.payouts_enabled });
  } catch (err) {
    console.error('[payments] connect status failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/payments/connect/portfolio-status   (staff)
// One row per community so onboarding the whole book is a single screen. Uses
// STORED status (no per-community Stripe call) so it loads instantly; the
// per-community detail view refreshes live on open. Also reports the Stripe
// MODE (test vs live) so "we're still in sandbox" is impossible to miss.
// ============================================================================
router.get('/connect/portfolio-status', async (req, res) => {
  try {
    const key = process.env.STRIPE_SECRET_KEY || '';
    const mode = /^sk_live_/.test(key) ? 'live' : (/^sk_test_/.test(key) ? 'test' : 'unconfigured');
    const { data, error } = await supabase.from('communities')
      .select('id, name, stripe_connected_account_id, stripe_onboarding_status, portal_active, portal_module_config, is_demo, management_status, financials_active')
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    const communities = (data || []).map((c) => {
      const hasAccount = !!c.stripe_connected_account_id;
      const balanceTile = ((c.portal_module_config || {}).balance || {}).status === 'live';
      const portalLive = c.portal_active === true;
      return {
        id: c.id,
        name: c.name,
        has_account: hasAccount,
        onboarded: c.stripe_onboarding_status === 'enabled',
        status: c.stripe_onboarding_status || (hasAccount ? 'in_progress' : 'not_started'),
        portal_active: portalLive,
        balance_tile_live: balanceTile,
        // Cross-check, per the CLAUDE.md "preview must verify against truth"
        // rule: a community showing homeowners a balance while it cannot accept
        // a payment is a dead end the operator would otherwise never see. The
        // portal now hides the Pay-now button in this state, so without this
        // flag the gap is SILENT — owners simply have no way to pay and nobody
        // is told why.
        // Demo communities and communities we are winding down are excluded on
        // purpose. Drama Creek is fictional and will never have a Stripe
        // account, and Eaglewood's payments are switched off deliberately —
        // both would sit in this banner forever. An alert that is permanently
        // on is an alert nobody reads, and this one has to still mean something
        // the day a REAL community quietly loses its ability to take payment.
        // (Ed 2026-08-21, seeing Drama Creek flagged on the Online Payments
        // screen.)
        portal_live_without_payments: portalLive && balanceTile && !hasAccount
          && c.is_demo !== true
          && c.financials_active !== false
          && !['terminating', 'terminated'].includes(c.management_status || 'active'),
      };
    });
    const summary = {
      total: communities.length,
      enabled: communities.filter((c) => c.onboarded).length,
      in_progress: communities.filter((c) => c.has_account && !c.onboarded).length,
      not_started: communities.filter((c) => !c.has_account).length,
      portal_live_without_payments: communities.filter((c) => c.portal_live_without_payments).length,
    };
    res.json({ ok: true, mode, summary, communities });
  } catch (err) {
    console.error('[payments] portfolio status failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/payments/connect/test-onboard   { community_id }   (SANDBOX ONLY)
// Prefills the connected account with Stripe's documented test KYC via the API
// (which accepts test values the hosted form's validation rejects, e.g. SSN
// 000000000) so the operator never has to click through the onboarding form.
// Refuses unless the key is sk_test_. Returns what's still needed, if anything.
// ============================================================================
router.post('/connect/test-onboard', express.json(), async (req, res) => {
  try {
    if (!stripeLib.isConfigured()) return res.status(503).json({ error: 'payment_not_configured' });
    if (!/^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '')) {
      return res.status(403).json({ error: 'test_mode_only', hint: 'This shortcut only runs with a sk_test_ key.' });
    }
    const { community_id } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data: community } = await supabase.from('communities')
      .select('id, name, hoa_legal_name, stripe_connected_account_id').eq('id', community_id).maybeSingle();
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    let accountId = community.stripe_connected_account_id;
    if (!accountId) {
      const existing = await stripeLib.findConnectedAccountByCommunity(community.id);
      accountId = existing.account_id;
      if (!accountId) {
        const acct = await stripeLib.createConnectedAccount({ communityId: community.id, communityName: community.hoa_legal_name || community.name });
        if (!acct.ok) return res.status(500).json({ error: acct.error || 'account_create_failed' });
        accountId = acct.account_id;
      }
      await supabase.from('communities').update({ stripe_connected_account_id: accountId, stripe_onboarding_status: 'in_progress' }).eq('id', community.id);
    }

    const name = community.hoa_legal_name || community.name || 'Test HOA';
    const addr = { line1: '123 Main St', city: 'Houston', state: 'TX', postal_code: '77001', country: 'US' };

    const u = await stripeLib.updateAccount(accountId, {
      business_profile: { mcc: '6513', url: 'https://bedrocktx.com', product_description: 'HOA assessment collection' },
      company: { name, tax_id: '000000000', phone: '+15125551234', address: addr, owners_provided: 'true', directors_provided: 'true', executives_provided: 'true' },
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '8.8.8.8' },
    });
    if (!u.ok) return res.status(500).json({ error: 'company_update_failed', detail: u.error });

    const p = await stripeLib.createPerson(accountId, {
      first_name: 'Jordan', last_name: 'Tester', email: 'test@bedrocktx.com', phone: '+15125551234',
      dob: { day: 1, month: 1, year: 1990 }, id_number: '000000000', ssn_last_4: '0000', address: addr,
      relationship: { representative: 'true', title: 'Manager', owner: 'true', percent_ownership: 100, executive: 'true', director: 'true' },
    });
    if (!p.ok) console.warn('[connect test-onboard] person:', p.error); // may already exist

    const e = await stripeLib.createExternalAccount(accountId, {
      external_account: { object: 'bank_account', country: 'US', currency: 'usd', routing_number: '110000000', account_number: '000123456789' },
    });
    if (!e.ok && !/already|external account/i.test(e.error || '')) console.warn('[connect test-onboard] bank:', e.error);

    const reqs = await stripeLib.retrieveAccountRequirements(accountId);
    const enabled = !!(reqs.ok && reqs.charges_enabled);
    await supabase.from('communities').update({
      stripe_onboarding_status: enabled ? 'enabled' : 'restricted',
      ...(enabled ? { stripe_onboarded_at: new Date().toISOString() } : {}),
    }).eq('id', community.id);

    res.json({ ok: true, account_id: accountId, charges_enabled: !!reqs.charges_enabled, payouts_enabled: !!reqs.payouts_enabled, still_needed: reqs.currently_due || [], disabled_reason: reqs.disabled_reason || null });
  } catch (err) {
    console.error('[payments] test-onboard failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/payments/webhook  (raw body required for signature verification)
// Stripe sends events here. We handle:
//   checkout.session.completed       → mark payments succeeded, confirm rental
//   payment_intent.payment_failed    → mark payments failed
//   charge.refunded                  → mark payments refunded
//
// Stripe Connect: webhook events include `account` (the connected account id)
// when the event originated from a connected account. We log it but use
// metadata to find OUR row (we control metadata so it's reliable).
//
// Idempotency: each event has an id; we no-op if we've already processed it.
// ============================================================================
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // Platform deliveries verify with STRIPE_WEBHOOK_SECRET; connected-account
      // deliveries (top-level `account`) with STRIPE_CONNECT_WEBHOOK_SECRET.
      // Exactly one secret per delivery, no fallback, no unsigned path
      // (lib/payments/webhook_auth.js). A missing secret refuses only that
      // source, with 503 so Stripe retries once it is set.
      const sigHeader = req.headers['stripe-signature'];
      const { verifyStripeWebhook } = require('../lib/payments/webhook_auth');
      const verify = verifyStripeWebhook(req.body, sigHeader);
      if (!verify.ok) {
        console.warn(`[payments] webhook refused (${verify.source || 'unknown'} source): ${verify.error}`);
        if (verify.status === 503) return res.status(503).send(verify.error);
        // SANDBOX-ONLY diagnostic (visible in Stripe's delivery response view) to
        // pinpoint secret-vs-body. Never runs with a live key; leaks only prefixes.
        if (/^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '') && verify.source) {
          const diagSecret = verify.source === 'connect' ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
          return res.status(400).json({ error: verify.error, source: verify.source, diag: _webhookSigDiag(req.body, sigHeader, diagSecret) });
        }
        return res.status(400).send(`signature verify failed: ${verify.error}`);
      }

      const event = verify.event;
      console.log(`[payments] webhook event: ${event.type} (${event.id})`);
      const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');
      const { createPaymentStore } = require('../lib/payments/payment_store');
      const { stripeMode } = require('../lib/payments/stripe_mode');
      const store = createPaymentStore({
        supabase,
        legacy: {
          checkoutCompleted: handleCheckoutCompleted,
          paymentFailed: handlePaymentFailed,
          chargeRefunded: handleChargeRefunded,
          accountUpdated: (acct) => handleAccountUpdated(acct, event.id),
        },
      });
      const out = await processWebhookEvent(event, { store, mode: stripeMode() });
      return res.status(out.http).json(out.body);
    } catch (err) {
      // Return 500 so Stripe retries (rate-limited by Stripe itself)
      console.error('[payments] webhook handler failed:', err.message);
      res.status(500).send(safeErrorMessage(err));
    }
  }
);

async function handleCheckoutCompleted(session, eventId) {
  const sessionId = session.id;
  const paymentIntentId = session.payment_intent;

  // Mark all pending payments tied to this session as succeeded
  const { data: payments } = await supabase
    .from('payments')
    .update({
      status: 'succeeded',
      processor_payment_id: paymentIntentId,
      processor_metadata: { last_event_id: eventId, session_completed: true },
      paid_at: new Date().toISOString(),
    })
    .eq('processor_session_id', sessionId)
    .eq('status', 'pending')
    .select('id, product_id, product_type');

  if (!payments || !payments.length) return;

  // Find the rental tied to these payments + confirm it
  const rentalId = payments[0].product_id;
  const productType = payments[0].product_type;

  if (productType === 'amenity_rental') {
    await supabase
      .from('amenity_rentals')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', rentalId)
      .eq('status', 'pending_payment');

    // Fire confirmation email (best-effort; non-fatal on failure)
    try { await sendRentalConfirmationEmail(rentalId); }
    catch (e) { console.warn('[payments] confirmation email failed:', e.message); }
  }
  // Assessment payments never reach here: lib/payments/payment_lifecycle.js owns them.
}

async function handlePaymentFailed(intent, eventId) {
  const piId = intent.id;
  await supabase
    .from('payments')
    .update({
      status: 'failed',
      failure_reason: intent.last_payment_error?.message || 'payment failed',
      processor_metadata: { last_event_id: eventId },
    })
    .eq('processor_payment_id', piId)
    .eq('status', 'pending');
}

async function handleChargeRefunded(charge, eventId) {
  const piId = charge.payment_intent;
  // Update each related payment row's refunded total
  const refundedTotal = charge.amount_refunded || 0;
  const refundComplete = charge.refunded === true;

  await supabase
    .from('payments')
    .update({
      status: refundComplete ? 'refunded' : 'partially_refunded',
      refunded_amount_cents: refundedTotal,
      refunded_at: new Date().toISOString(),
      processor_metadata: { last_event_id: eventId, charge_id: charge.id },
    })
    .eq('processor_payment_id', piId);
}

async function handleAccountUpdated(account, eventId) {
  // A connected account's status changed (e.g., onboarding completed, requirements due).
  // Surface to communities table so admin UI can show the current state.
  const acctId = account.id;
  if (!acctId) return;
  const newStatus = account.charges_enabled
    ? 'enabled'
    : account.requirements?.disabled_reason
      ? 'restricted'
      : 'in_progress';
  await supabase
    .from('communities')
    .update({
      stripe_onboarding_status: newStatus,
      stripe_onboarded_at: account.charges_enabled ? new Date().toISOString() : null,
    })
    .eq('stripe_connected_account_id', acctId);
}

// ============================================================================
// GET /api/payments/by-session/:session_id
// Used by the rental confirmation page (post-redirect from Stripe). Returns
// a thin status payload — reference number, status, no card details.
// ============================================================================
router.get('/by-session/:session_id', async (req, res) => {
  try {
    const { data: payments, error } = await supabase
      .from('payments')
      .select('id, product_type, product_id, status, amount_cents, fee_type')
      .eq('processor_session_id', req.params.session_id);
    if (error) throw error;
    if (!payments.length) return res.status(404).json({ error: 'session not recognized' });

    const productId = payments[0].product_id;
    const status = payments.every((p) => p.status === 'succeeded') ? 'succeeded'
                 : payments.some((p) => p.status === 'failed')     ? 'failed'
                 : 'pending';

    const { data: rental } = await supabase
      .from('amenity_rentals')
      .select('reference_number, status, event_date, arrival_time, departure_time, renter_name, community:communities(name)')
      .eq('id', productId)
      .maybeSingle();

    res.json({
      session_status: status,
      reference_number: rental?.reference_number,
      rental_status: rental?.status,
      community: rental?.community?.name,
      event_date: rental?.event_date,
      arrival_time: rental?.arrival_time,
      departure_time: rental?.departure_time,
      renter_name: rental?.renter_name,
      total_amount_cents: payments.reduce((s, p) => s + p.amount_cents, 0),
    });
  } catch (err) {
    console.error('[payments] by-session lookup failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/payments/:id/refund
// Admin action. Body: { amount_cents?, reason, reverse_transfer? }
// Default refunds the full amount. amount_cents=N for partial.
// For HOA-side payments, the refund debits the HOA's Stripe Connect balance.
// For Bedrock-side payments (management fees), refund debits Bedrock's platform.
// ============================================================================
router.post('/:id/refund', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const { amount_cents, reason, reverse_transfer } = req.body || {};

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    if (!payment) return res.status(404).json({ error: 'payment not found' });
    if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
      return res.status(409).json({ error: `cannot refund payment in status ${payment.status}` });
    }
    if (!payment.processor_payment_id) {
      return res.status(400).json({ error: 'no processor_payment_id on record (was this a paper payment?)' });
    }

    // Whether Bedrock gives back its management fee is a judgement about
    // whether the service happened, so the operator states it rather than the
    // code assuming. A cancelled booking refunds it (nothing was delivered);
    // returning a deposit after the event does not (the rental happened).
    // Default false — keeping a fee you earned is recoverable; silently
    // handing back revenue on every deposit return is not obvious to anyone.
    const refund = await stripeLib.refund({
      paymentIntentId: payment.processor_payment_id,
      amountCents: amount_cents || undefined,
      connectedAccountId: payment.connected_account_id || undefined,
      reason: reason || 'requested_by_customer',
      reverseTransfer: !!reverse_transfer,
      refundApplicationFee: req.body.refund_application_fee === true,
    });

    if (!refund.ok) {
      return res.status(refund.skipped ? 503 : 500).json({ error: refund.error });
    }

    // Webhook will fire charge.refunded shortly and reconcile, but reflect right away
    // so admin UI doesn't show stale state.
    const newRefundedTotal = (payment.refunded_amount_cents || 0) + (refund.amount_cents || payment.amount_cents);
    await supabase
      .from('payments')
      .update({
        status: newRefundedTotal >= payment.amount_cents ? 'refunded' : 'partially_refunded',
        refunded_amount_cents: newRefundedTotal,
        refunded_at: new Date().toISOString(),
        refund_reason: reason || null,
      })
      .eq('id', payment.id);

    res.json({
      ok: true,
      refund_id: refund.refund_id,
      amount_cents: refund.amount_cents,
      status: refund.status,
    });
  } catch (err) {
    console.error('[payments] refund failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/payments/verify/:sessionId  (staff) — VERIFICATION HARNESS
// ----------------------------------------------------------------------------
// Prove the whole chain end-to-end for one payment, READ-ONLY: the ledger rows
// succeeded, the AR subledger recorded the payment, and the GL posted
// Dr Cash (1000) / Cr AR (1300), balanced to the amount. Run it after the first
// test payment so the money-hits-the-books chain isn't a leap of faith. Reports
// each link as pass/fail and explains expected non-posts (not-live-GL). (Ed 2026-08-08.)
// ============================================================================
router.get('/verify/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const { data: pays } = await supabase.from('payments')
      .select('fee_type, payee, amount_cents, status, paid_at, community_id, product_id, product_type')
      .eq('processor_session_id', sessionId);
    const payments = pays || [];
    const assessment = payments.find((p) => p.fee_type === 'assessment' && p.product_type === 'assessment_payment');
    const all_succeeded = payments.length > 0 && payments.every((p) => p.status === 'succeeded');

    let community = null, glEntry = null, subledger = null;
    const amt = assessment ? Math.abs(Number(assessment.amount_cents) || 0) : 0;

    if (assessment) {
      const { data: comm } = await supabase.from('communities')
        .select('id, name, gl_cutover_date').eq('id', assessment.community_id).maybeSingle();
      community = comm || null;

      // GL journal entry — keyed to source_module='payment_intake' + source_reference=<session>.
      const { data: je } = await supabase.from('journal_entries')
        .select('id, posting_date, reference, total_debits_cents, total_credits_cents, status')
        .eq('community_id', assessment.community_id).eq('source_module', 'payment_intake')
        .eq('source_reference', sessionId).maybeSingle();
      if (je) {
        const { data: lines } = await supabase.from('journal_entry_lines')
          .select('debit_cents, credit_cents, account_id').eq('journal_entry_id', je.id);
        const acctIds = [...new Set((lines || []).map((l) => l.account_id))];
        const { data: accts } = acctIds.length
          ? await supabase.from('chart_of_accounts').select('id, account_number, account_name').in('id', acctIds)
          : { data: [] };
        const byId = Object.fromEntries((accts || []).map((a) => [a.id, a]));
        glEntry = {
          id: je.id, posting_date: je.posting_date, reference: je.reference, status: je.status,
          total_debits_cents: je.total_debits_cents, total_credits_cents: je.total_credits_cents,
          lines: (lines || []).map((l) => ({
            account_number: byId[l.account_id] ? byId[l.account_id].account_number : null,
            account_name: byId[l.account_id] ? byId[l.account_id].account_name : null,
            debit_cents: l.debit_cents, credit_cents: l.credit_cents,
          })),
        };
      }

      // AR subledger — homeowner_transactions payment row keyed to the session.
      const { data: sub } = await supabase.from('homeowner_transactions')
        .select('id, transaction_date, amount_cents, description, txn_type')
        .contains('raw_row_jsonb', { stripe_session_id: sessionId }).limit(1).maybeSingle();
      subledger = sub || null;
    }

    const cutover = community && community.gl_cutover_date;
    const isLiveGL = !!cutover && String(cutover).slice(0, 10) <= new Date().toISOString().slice(0, 10);
    const drCash = glEntry && glEntry.lines.find((l) => l.account_number === '1000' && Number(l.debit_cents) > 0);
    const crAR = glEntry && glEntry.lines.find((l) => l.account_number === '1300' && Number(l.credit_cents) > 0);

    res.json({
      session_id: sessionId,
      found: payments.length > 0,
      amount_cents: amt,
      payments,
      checks: {
        payment_succeeded: all_succeeded,
        live_gl_community: isLiveGL,
        gl_posted: !!glEntry,
        gl_dr_cash_cr_ar: !!(drCash && crAR),
        gl_balanced: glEntry ? (Number(glEntry.total_debits_cents) === Number(glEntry.total_credits_cents) && Number(glEntry.total_debits_cents) === amt) : false,
        ar_subledger_posted: !!subledger,
      },
      gl_entry: glEntry,
      ar_subledger: subledger,
      community: community ? { id: community.id, name: community.name, gl_cutover_date: community.gl_cutover_date, is_live_gl: isLiveGL } : null,
      note: !assessment
        ? 'No assessment payment found for this session id.'
        : (!isLiveGL ? 'Community is not on live GL — the GL post is intentionally skipped (AR subledger still records it). This is expected, not a failure.' : null),
    });
  } catch (err) {
    console.error('[payments] verify failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/payments/:id  (admin)
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// Internal — confirmation email sender (called from webhook on payment success)
// ============================================================================
async function sendRentalConfirmationEmail(rentalId) {
  const { data: rental } = await supabase
    .from('amenity_rentals')
    .select(`
      *,
      amenity:amenities(name, amenity_type, street_address, rules_url),
      community:communities(name, slug, hoa_legal_name)
    `)
    .eq('id', rentalId)
    .maybeSingle();
  if (!rental) return;

  const { data: payments } = await supabase
    .from('payments')
    .select('fee_type, amount_cents, refundable, payee_display_name, status')
    .eq('product_type', 'amenity_rental')
    .eq('product_id', rentalId)
    .eq('status', 'succeeded');

  const totalPaid = (payments || []).reduce((s, p) => s + p.amount_cents, 0);
  const refundableTotal = (payments || []).filter((p) => p.refundable)
    .reduce((s, p) => s + p.amount_cents, 0);

  const feeRows = (payments || []).map((p) => `
    <tr>
      <td style="padding:6px 12px; font-size:13px;">${p.fee_type.replace(/_/g, ' ')}${p.refundable ? ' (refundable)' : ''}</td>
      <td style="padding:6px 12px; font-size:13px; text-align:right;">${dollars(p.amount_cents)}</td>
    </tr>`).join('');

  const html = `
    <p>Dear ${escapeHtml(rental.renter_name)},</p>
    <p>Your ${escapeHtml(rental.amenity.name)} rental at ${escapeHtml(rental.community.name)} is confirmed.</p>
    <table style="border-collapse:collapse; margin: 14px 0; font-family: Georgia, serif;">
      <tr><td style="padding:4px 12px; color:#666;">Reference</td><td style="padding:4px 12px; font-family: monospace;">${escapeHtml(rental.reference_number)}</td></tr>
      <tr><td style="padding:4px 12px; color:#666;">Date</td><td style="padding:4px 12px;">${escapeHtml(rental.event_date)}</td></tr>
      <tr><td style="padding:4px 12px; color:#666;">Time</td><td style="padding:4px 12px;">${escapeHtml(rental.arrival_time)} – ${escapeHtml(rental.departure_time)}</td></tr>
      <tr><td style="padding:4px 12px; color:#666;">Address</td><td style="padding:4px 12px;">${escapeHtml(rental.amenity.street_address || '')}</td></tr>
    </table>
    <h3 style="font-family: Georgia, serif; color: #1A3050;">Payment</h3>
    <table style="border-collapse:collapse;">${feeRows}
      <tr><td style="padding:6px 12px; border-top:1px solid #ccc;"><strong>Total paid</strong></td><td style="padding:6px 12px; text-align:right; border-top:1px solid #ccc;"><strong>${dollars(totalPaid)}</strong></td></tr>
      ${refundableTotal ? `<tr><td style="padding:4px 12px; color:#666; font-size:12px;">Refundable on successful inspection</td><td style="padding:4px 12px; text-align:right; color:#666; font-size:12px;">${dollars(refundableTotal)}</td></tr>` : ''}
    </table>
    <p style="margin-top:18px;">Please review the rental agreement you signed for the full list of expectations (cleaning, hours, prohibited activities). A reminder will be sent the day before your event.</p>
    <p>Questions: reply to this email or contact us at <a href="mailto:info@bedrocktx.com">info@bedrocktx.com</a> · (832) 588-2485.</p>
    <p style="color:#555; font-size:11px; margin-top:24px;">
      Sent on behalf of ${escapeHtml(rental.community.hoa_legal_name || rental.community.name)} by Bedrock Association Management.
    </p>
  `;

  await sendEmail({
    to: rental.renter_email,
    subject: `${rental.community.name} ${rental.amenity.name} — Reservation Confirmed (${rental.reference_number})`,
    html,
    tags: [
      { name: 'module', value: 'amenity_rental' },
      { name: 'community', value: rental.community.slug || 'unknown' },
      { name: 'amenity_type', value: rental.amenity.amenity_type || 'unknown' },
    ],
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { router, createAssessmentCheckout, quoteAssessmentPayment };
