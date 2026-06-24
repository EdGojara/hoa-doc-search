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
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function dollars(cents) {
  return (Number(cents || 0) / 100).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
  });
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
    await supabase.from('payments').insert(paymentInserts);

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
// POST /api/payments/assessment/create-checkout
// ----------------------------------------------------------------------------
// Homeowner pays their assessment balance. Same Connect rails as amenity
// rentals: the FULL assessment routes to the community's connected account (HOA
// bank), never pooled. Card adds a convenience fee (grossed up to cover Stripe's
// 2.9% + 30c so the association nets the full assessment) routed as the platform
// application fee; ACH (the cheap rail, $5-capped) carries no convenience fee.
//
// The management fee is NEVER skimmed here — it stays contractual/separate.
//
// Body: { community_id, property_id, amount_cents?, payment_method ('ach'|'card'),
//         payer: {email,name}, success_url, cancel_url }
// Inert until STRIPE keys land (503). Posting the completed payment to AR+GL is
// handled in the webhook (handleCheckoutCompleted) and validated with test keys.
// ============================================================================
router.post('/assessment/create-checkout', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(503).json({ error: 'payment_not_configured', hint: 'Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (test mode) to enable.' });
    }
    const b = req.body || {};
    if (!b.community_id || !b.property_id) return res.status(400).json({ error: 'community_id_and_property_id_required' });
    if (!b.success_url || !b.cancel_url) return res.status(400).json({ error: 'success_url_and_cancel_url_required' });
    const method = b.payment_method === 'card' ? 'card' : 'ach'; // default to ACH (low cost)

    const { data: community } = await supabase.from('communities')
      .select('id, name, slug, hoa_legal_name, stripe_connected_account_id')
      .eq('id', b.community_id).maybeSingle();
    if (!community) return res.status(404).json({ error: 'community_not_found' });
    if (!community.stripe_connected_account_id) {
      return res.status(503).json({ error: 'community_stripe_not_onboarded', hint: `${community.hoa_legal_name || community.name} hasn't completed Stripe Connect onboarding.` });
    }

    // Amount = requested, else the homeowner's current balance.
    let amt = Math.round(Number(b.amount_cents) || 0);
    if (!amt) {
      try {
        const { resolveCurrentAR } = require('../lib/ar/resolve_current_ar');
        const ar = await resolveCurrentAR(supabase, { propertyId: b.property_id, communityId: b.community_id });
        amt = ar && ar.balance_cents > 0 ? ar.balance_cents : 0;
      } catch (_) { /* fall through to nothing_due */ }
    }
    if (amt <= 0) return res.status(400).json({ error: 'nothing_due', hint: 'Account balance is zero.' });

    // Card convenience fee: gross-up so the HOA nets the full assessment.
    // POLICY KNOB — Ed confirms the exact %/cap; this default covers card cost.
    const convFeeCents = method === 'card' ? Math.max(0, Math.round((amt + 30) / (1 - 0.029)) - amt) : 0;

    const fees = [{ label: `Assessment payment — ${community.name}`, amount_cents: amt, payee: 'community_association', fee_type: 'assessment' }];
    if (convFeeCents > 0) fees.push({ label: 'Card convenience fee', amount_cents: convFeeCents, payee: 'management_company', fee_type: 'convenience_fee' });

    const session = await stripeLib.createCheckoutSession({
      fees,
      connectedAccountId: community.stripe_connected_account_id,
      customer: { email: (b.payer && b.payer.email) || undefined, name: (b.payer && b.payer.name) || undefined },
      reference: `ASMT-${String(b.property_id).slice(0, 8)}`,
      productType: 'assessment_payment',
      productId: b.property_id,
      successUrl: b.success_url,
      cancelUrl: b.cancel_url,
      communityName: community.name,
      communityId: community.id,
      statementDescriptor: (community.slug || community.name || 'BEDROCK').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 22),
      paymentMethodTypes: method === 'card' ? ['card'] : ['us_bank_account'],
    });
    if (!session.ok) {
      return res.status(session.skipped ? 503 : 500).json({ error: session.error || 'checkout_failed', stripeCode: session.stripeCode });
    }

    const rows = fees.map((f) => ({
      community_id: community.id, product_type: 'assessment_payment', product_id: b.property_id,
      fee_type: f.fee_type, payee: f.payee,
      connected_account_id: f.payee === 'community_association' ? community.stripe_connected_account_id : null,
      amount_cents: f.amount_cents, method: 'stripe_checkout', processor: 'stripe',
      processor_session_id: session.session_id, status: 'pending', initiated_by: 'homeowner_portal',
    }));
    await supabase.from('payments').insert(rows);

    res.json({ ok: true, checkout_url: session.checkout_url, session_id: session.session_id, amount_cents: amt, convenience_fee_cents: convFeeCents, method });
  } catch (err) {
    console.error('[payments] assessment checkout failed:', err.message);
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

    const { data: community } = await supabase.from('communities')
      .select('id, name, hoa_legal_name, stripe_connected_account_id').eq('id', community_id).maybeSingle();
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    let accountId = community.stripe_connected_account_id;
    if (!accountId) {
      const acct = await stripeLib.createConnectedAccount({ communityId: community.id, communityName: community.hoa_legal_name || community.name });
      if (!acct.ok) return res.status(500).json({ error: acct.error || 'account_create_failed', stripeCode: acct.stripeCode });
      accountId = acct.account_id;
      await supabase.from('communities').update({ stripe_connected_account_id: accountId, stripe_onboarding_status: 'started' }).eq('id', community.id);
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
    if (!stripeLib.isConfigured()) return res.json({ ok: true, has_account: true, account_id: community.stripe_connected_account_id, onboarded: community.stripe_onboarding_status === 'complete' });

    const st = await stripeLib.retrieveAccount(community.stripe_connected_account_id);
    const onboarded = !!(st.ok && st.details_submitted && st.charges_enabled);
    if (onboarded && community.stripe_onboarding_status !== 'complete') {
      await supabase.from('communities').update({ stripe_onboarding_status: 'complete' }).eq('id', community.id);
    }
    res.json({ ok: true, has_account: true, account_id: community.stripe_connected_account_id, onboarded, details_submitted: st.details_submitted, charges_enabled: st.charges_enabled, payouts_enabled: st.payouts_enabled });
  } catch (err) {
    console.error('[payments] connect status failed:', err.message);
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
      if (!stripeLib.webhookReady()) {
        // Webhook secret not set yet — can't verify. Don't 500 (Stripe retries).
        return res.status(503).send('webhook secret not configured');
      }

      const sigHeader = req.headers['stripe-signature'];
      const verify = stripeLib.verifyWebhookSignature(req.body, sigHeader, process.env.STRIPE_WEBHOOK_SECRET);
      if (!verify.ok) {
        console.warn('[payments] webhook signature verify failed:', verify.error);
        return res.status(400).send(`signature verify failed: ${verify.error}`);
      }

      const event = JSON.parse(req.body.toString('utf8'));
      const eventId = event.id;
      const eventType = event.type;
      const eventData = event.data?.object || {};

      // Idempotency: skip if we've already processed this event
      const { data: existingEvent } = await supabase
        .from('payments')
        .select('id')
        .contains('processor_metadata', { last_event_id: eventId })
        .limit(1)
        .maybeSingle();
      if (existingEvent) {
        return res.status(200).send('already processed');
      }

      console.log(`[payments] webhook event: ${eventType} (${eventId})`);

      switch (eventType) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(eventData, eventId);
          break;
        case 'payment_intent.payment_failed':
          await handlePaymentFailed(eventData, eventId);
          break;
        case 'charge.refunded':
          await handleChargeRefunded(eventData, eventId);
          break;
        case 'account.updated':
          await handleAccountUpdated(eventData, eventId);
          break;
        default:
          // Lots of events we don't care about — acknowledge to stop retries
          break;
      }

      res.status(200).send('ok');
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

    const refund = await stripeLib.refund({
      paymentIntentId: payment.processor_payment_id,
      amountCents: amount_cents || undefined,
      connectedAccountId: payment.connected_account_id || undefined,
      reason: reason || 'requested_by_customer',
      reverseTransfer: !!reverse_transfer,
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

module.exports = { router };
