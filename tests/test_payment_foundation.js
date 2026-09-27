// tests/test_payment_foundation.js — safe Stripe payment foundation (migration 469).
// Pure: fakes for Supabase, Stripe and the payment store. The SQL state machine the
// fake store mirrors is rehearsed against Postgres in tests/sql/469_payment_rehearsal.mjs.
// Run: node tests/test_payment_foundation.js
const assert = require('assert');
const { stripeMode, requireTestMode } = require('../lib/payments/stripe_mode');
const { authorizeHomeownerPayment } = require('../lib/payments/homeowner_checkout');
const { createAssessmentCheckout } = require('../lib/payments/assessment_checkout');
const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');
const { verifyPaymentToken, signPaymentToken } = require('../lib/payments/payment_link');

let failed = 0;
const results = [];
const t = (name, fn) => results.push((async () => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
})());

// ---------------------------------------------------------------- fake supabase
function fakeSupabase(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  for (const k of ['payments']) db[k] = db[k] || [];
  let seq = 0;
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let limitN = null; let single = null;
    const run = () => {
      const rows = db[table] || [];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `row${++seq}`, ...r }));
        db[table] = rows.concat(list);
        return { data: list, error: null };
      }
      if (op === 'update') { match.forEach((r) => Object.assign(r, payload)); return { data: match, error: null }; }
      let out = limitN != null ? match.slice(0, limitN) : match;
      if (single === 'maybe') return { data: out[0] || null, error: null };
      if (single === 'one') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not single' } };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
      is(c, v) { filters.push((r) => (r[c] == null) === (v == null)); return b; },
      in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      not(c, _op, _v) { filters.push((r) => r[c] != null); return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { single = 'maybe'; return b; },
      single() { single = 'one'; return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(patch) { op = 'update'; payload = patch; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  return { from: builder, _db: db };
}

const P1 = 'prop-1', P2 = 'prop-2', C = 'comm-1', SELLER = 'ten-seller', BUYER = 'ten-buyer';
function world({ tenureId = SELLER, balance = 25000, trusted = '1004384184' } = {}) {
  return fakeSupabase({
    properties: [{ id: P1, community_id: C, street_address: '4707 Lakes of Pine Forest Ct', trusted_account_number: trusted, vantaca_account_id: '2013059' }],
    communities: [{ id: C, name: 'Lakes of Pine Forest', slug: 'lopf', stripe_connected_account_id: 'acct_test_1', gl_cutover_date: '2026-08-01' }],
    ownership_tenures: [{ id: tenureId, community_id: C, property_id: P1, kind: 'owner', end_date: null, start_date: '2026-08-27' }],
    property_ownerships: [{ tenure_id: tenureId, contact_id: 'contact-owner', is_primary: true, start_date: '2026-08-27' }],
    v_current_owner_balance: [{ tenure_id: tenureId, balance_cents: balance }],
  });
}
function fakeStripe() {
  const sessions = [];
  return {
    sessions,
    isConfigured: () => true,
    async createCheckoutSession(opts) { sessions.push(opts); return { ok: true, session_id: `cs_test_${sessions.length}`, checkout_url: 'https://checkout.stripe.test/x' }; },
  };
}
const TEST_KEY = 'sk_test_x', LIVE_KEY = 'sk_live_x';
const urls = { successUrl: 'https://app/portal?paid=1', cancelUrl: 'https://app/portal' };

// ---------------------------------------------------------------- 1. homeowner cannot pay another property
t('homeowner cannot pay another property (explicit request refused, never redirected)', () => {
  const scoped = { isManager: false, allProperties: [{ id: P1 }] };
  const user = { id: 'u1', role: 'homeowner' };
  assert.deepStrictEqual(authorizeHomeownerPayment({ user, mimic: null, scoped, requestedPropertyId: P2 }).error, 'property_not_yours');
  assert.strictEqual(authorizeHomeownerPayment({ user, mimic: null, scoped, requestedPropertyId: P1 }).propertyId, P1);
  assert.strictEqual(authorizeHomeownerPayment({ user, mimic: null, scoped, requestedPropertyId: null }).propertyId, P1);
});
t('staff view-as, managers and renters cannot start a homeowner payment', () => {
  const scoped = { isManager: false, allProperties: [{ id: P1 }] };
  assert.strictEqual(authorizeHomeownerPayment({ user: { role: 'homeowner' }, mimic: { portal_user_id: 'u1' }, scoped }).error, 'staff_view_cannot_pay');
  assert.strictEqual(authorizeHomeownerPayment({ user: { role: 'manager' }, mimic: null, scoped: { isManager: true } }).error, 'role_cannot_pay');
  assert.strictEqual(authorizeHomeownerPayment({ user: { role: 'renter' }, mimic: null, scoped }).error, 'role_cannot_pay');
  assert.strictEqual(authorizeHomeownerPayment({ user: null }).error, 'not_signed_in');
});

// ---------------------------------------------------------------- 2. amount cannot be altered client-side
t('amount is the owner tenure balance; a caller-supplied amount is ignored', async () => {
  const sb = world({ balance: 25000 }); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: TEST_KEY },
    { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls, amount_cents: 1, amountCents: 1 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.amount_cents, 25000);
  const row = sb._db.payments.find((p) => p.fee_type === 'assessment');
  assert.strictEqual(row.amount_cents, 25000);
  assert.strictEqual(st.sessions[0].fees[0].amount_cents, 25000);
});
t('a fixed test amount is allowed only while Stripe is in test mode', async () => {
  const live = await createAssessmentCheckout({ supabase: world(), stripeLib: fakeStripe(), key: LIVE_KEY },
    { propertyId: P1, paymentMethod: 'card', initiatedBy: 'staff_test', ...urls, testAmountCents: 100 });
  assert.strictEqual(live.error, 'test_amount_requires_test_mode');
  const test = await createAssessmentCheckout({ supabase: world(), stripeLib: fakeStripe(), key: TEST_KEY },
    { propertyId: P1, paymentMethod: 'card', initiatedBy: 'staff_test', ...urls, testAmountCents: 100 });
  assert.ok(test.ok && test.amount_cents === 100);
});

// ---------------------------------------------------------------- identity captured server-side
t('checkout records tenure, property, Trusted #, contact and group, and sends them to Stripe', async () => {
  const sb = world(); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: TEST_KEY }, { propertyId: P1, paymentMethod: 'card', initiatedBy: 'homeowner_portal', ...urls });
  const rows = sb._db.payments;
  assert.strictEqual(rows.length, 2, 'assessment + card convenience fee');
  for (const p of rows) {
    assert.strictEqual(p.tenure_id, SELLER); assert.strictEqual(p.property_id, P1);
    assert.strictEqual(p.trusted_account_number, '1004384184'); assert.strictEqual(p.contact_id, 'contact-owner');
    assert.strictEqual(p.payment_group_id, r.payment_group_id); assert.strictEqual(p.settlement_state, 'awaiting_payment');
    assert.strictEqual(p.processor_session_id, r.session_id);
    assert.ok(!('vantaca_account_id' in p), 'the lot Vantaca # is never used to identify the owner');
  }
  const md = st.sessions[0].extraMetadata;
  assert.strictEqual(md.payment_group_id, r.payment_group_id); assert.strictEqual(md.tenure_id, SELLER);
  assert.strictEqual(md.trusted_account_number, '1004384184');
});
t('checkout refuses a lot with no current owner or no Trusted account number', async () => {
  const noOwner = world(); noOwner._db.ownership_tenures[0].end_date = '2026-09-01';
  assert.strictEqual((await createAssessmentCheckout({ supabase: noOwner, stripeLib: fakeStripe(), key: TEST_KEY }, { propertyId: P1, ...urls })).error, 'no_current_owner');
  assert.strictEqual((await createAssessmentCheckout({ supabase: world({ trusted: null }), stripeLib: fakeStripe(), key: TEST_KEY }, { propertyId: P1, ...urls })).error, 'no_trusted_account_number');
});

// ---------------------------------------------------------------- 9. test-payment route refuses in live mode
t('test-only routes refuse unless Stripe is in test mode', () => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  assert.strictEqual(requireTestMode(res, LIVE_KEY), false); assert.strictEqual(res.code, 403);
  assert.strictEqual(requireTestMode(res, ''), false);
  assert.strictEqual(requireTestMode(res, TEST_KEY), true);
  assert.strictEqual(stripeMode('rk_live_abc'), 'live');
});

// ---------------------------------------------------------------- fake store mirroring migration 469
function fakeStore({ tenureId = SELLER } = {}) {
  const events = new Map(); const credits = []; const reversals = []; let failNextPost = 0;
  const pay = { id: 'pay-1', group: 'grp-1', state: 'awaiting_payment', posting: 'not_posted', tenure: tenureId, amount: 20000, needs_review: false };
  const s = {
    pay, credits, reversals, events,
    failPostOnce() { failNextPost = 1; },
    async claimEvent(e) {
      const cur = events.get(e.id);
      if (!cur) { events.set(e.id, { status: 'processing', attempts: 1 }); return 'process'; }
      if (cur.status === 'processed' || cur.status === 'ignored') return 'done';
      if (cur.status === 'processing') return 'busy';
      cur.status = 'processing'; cur.attempts++; return 'process';
    },
    async finishEvent(id, status) { events.get(id).status = status; },
    async settle({ group }) {
      if (group !== pay.group) return { action: 'unknown' };
      if (pay.state === 'awaiting_payment' || pay.state === 'processing') { pay.state = 'settled'; return { action: 'post', payment_id: pay.id }; }
      if (pay.state === 'settled') return ['posted', 'not_applicable', 'reversed', 'review'].includes(pay.posting) ? { action: 'done' } : { action: 'post', payment_id: pay.id };
      pay.posting = 'review'; pay.needs_review = true; return { action: 'review', payment_id: pay.id };
    },
    async markProcessing({ group }) { if (group === pay.group && pay.state === 'awaiting_payment') { pay.state = 'processing'; return { action: 'processing' }; } return { action: 'done' }; },
    async markFailed({ group, terminal }) {
      if (group !== pay.group) return { action: 'unknown' };
      if (pay.state === 'awaiting_payment' || pay.state === 'processing') { pay.state = terminal; return { action: terminal }; }
      if (pay.state === 'settled') { pay.needs_review = true; return { action: 'settled_needs_review' }; }
      return { action: 'done' };
    },
    async postPayment(id) {
      if (pay.state !== 'settled') throw new Error('not settled');
      if (pay.posting === 'posted') return { posting: 'already_posted' };
      if (failNextPost) { failNextPost = 0; throw new Error('transient database error'); }
      credits.push({ payment: id, tenure: pay.tenure, amount: pay.amount });
      pay.posting = 'posted';
      return { posting: 'posted' };
    },
    async findAssessmentByIntent(pi) { return pi === 'pi_1' ? { id: pay.id, group_total_cents: pay.amount } : null; },
    async reversePayment(id, reason) {
      if (pay.posting === 'reversed') return { action: 'already_reversed' };
      if (pay.posting !== 'posted') { pay.needs_review = true; return { action: 'review' }; }
      pay.posting = 'reversed'; reversals.push({ id, reason }); return { action: 'reversed' };
    },
    async flagReview() { pay.needs_review = true; },
    async legacyCheckoutCompleted() {}, async legacyPaymentFailed() {}, async legacyChargeRefunded() {}, async accountUpdated() {},
  };
  return s;
}
const quiet = { error() {}, warn() {}, log() {} };
const ev = (id, type, obj, extra = {}) => ({ id, type, livemode: false, created: 1790000000, data: { object: obj }, ...extra });
const sess = (payment_status, extra = {}) => ({ id: 'cs_test_1', payment_status, payment_intent: 'pi_1', metadata: { product_type: 'assessment_payment', payment_group_id: 'grp-1' }, ...extra });
const run = (store, e) => processWebhookEvent(e, { store, mode: 'test', log: quiet });

// ---------------------------------------------------------------- 4. duplicate webhook does not double-post
t('duplicate webhook delivery does not double-post', async () => {
  const st = fakeStore();
  const e = ev('evt_1', 'checkout.session.completed', sess('paid'));
  assert.strictEqual((await run(st, e)).http, 200);
  assert.strictEqual((await run(st, e)).body.duplicate, true);
  assert.strictEqual((await run(st, ev('evt_2', 'checkout.session.async_payment_succeeded', sess('paid')))).http, 200);
  assert.strictEqual(st.credits.length, 1, 'credited exactly once across 3 deliveries');
});
t('a delivery that arrives while another is processing gets 409 so Stripe retries later', async () => {
  const st = fakeStore(); st.events.set('evt_busy', { status: 'processing', attempts: 1 });
  assert.strictEqual((await run(st, ev('evt_busy', 'checkout.session.completed', sess('paid')))).http, 409);
  assert.strictEqual(st.credits.length, 0);
});

// ---------------------------------------------------------------- 5. failed webhook retries safely
t('a failed handler returns 500, and the retry credits exactly once', async () => {
  const st = fakeStore(); st.failPostOnce();
  const e = ev('evt_3', 'checkout.session.completed', sess('paid'));
  const first = await run(st, e);
  assert.strictEqual(first.http, 500); assert.strictEqual(st.events.get('evt_3').status, 'failed');
  assert.strictEqual(st.credits.length, 0, 'nothing credited by the failed attempt');
  const retry = await run(st, e);
  assert.strictEqual(retry.http, 200); assert.strictEqual(st.credits.length, 1);
  assert.strictEqual((await run(st, e)).body.duplicate, true);
  assert.strictEqual(st.credits.length, 1);
});

// ---------------------------------------------------------------- 6/7/8. ACH settlement
t('ACH pending (completed but unpaid) does not credit AR', async () => {
  const st = fakeStore();
  await run(st, ev('evt_4', 'checkout.session.completed', sess('unpaid')));
  assert.strictEqual(st.pay.state, 'processing'); assert.strictEqual(st.credits.length, 0);
});
t('ACH success credits once', async () => {
  const st = fakeStore();
  await run(st, ev('evt_5', 'checkout.session.completed', sess('unpaid')));
  await run(st, ev('evt_6', 'checkout.session.async_payment_succeeded', sess('paid')));
  await run(st, ev('evt_6', 'checkout.session.async_payment_succeeded', sess('paid')));
  assert.strictEqual(st.credits.length, 1); assert.strictEqual(st.pay.posting, 'posted');
});
t('ACH failure never leaves a credit, and a late "paid" goes to review instead of crediting', async () => {
  const st = fakeStore();
  await run(st, ev('evt_7', 'checkout.session.completed', sess('unpaid')));
  await run(st, ev('evt_8', 'checkout.session.async_payment_failed', sess('unpaid')));
  assert.strictEqual(st.pay.state, 'failed'); assert.strictEqual(st.credits.length, 0);
  await run(st, ev('evt_9', 'checkout.session.async_payment_succeeded', sess('paid')));
  assert.strictEqual(st.credits.length, 0); assert.strictEqual(st.pay.needs_review, true);
});

// ---------------------------------------------------------------- 3. seller cannot receive buyer payment after transfer
t('after a transfer, a payment credits the tenure captured at checkout, never whoever owns the lot now', async () => {
  const sb = world({ tenureId: BUYER }); const r = await createAssessmentCheckout({ supabase: sb, stripeLib: fakeStripe(), key: TEST_KEY }, { propertyId: P1, ...urls });
  assert.strictEqual(sb._db.payments[0].tenure_id, BUYER, 'a checkout after the sale belongs to the buyer');
  const st = fakeStore({ tenureId: SELLER }); // a checkout the SELLER started before the sale
  await run(st, ev('evt_10', 'checkout.session.completed', sess('unpaid')));
  await run(st, ev('evt_11', 'checkout.session.async_payment_succeeded', sess('paid'))); // settles after the sale
  assert.deepStrictEqual(st.credits.map((c) => c.tenure), [SELLER], 'the seller payment credits the seller, not the buyer');
  assert.ok(r.ok);
});
t('a pay link is bound to the owner it was issued for; old unbound links are refused', () => {
  const prev = process.env.PAYMENT_LINK_SECRET; process.env.PAYMENT_LINK_SECRET = 'test-secret';
  const tok = signPaymentToken({ community_id: C, property_id: P1, tenure_id: SELLER });
  assert.strictEqual(verifyPaymentToken(tok).tenure_id, SELLER);
  assert.throws(() => signPaymentToken({ community_id: C, property_id: P1 }));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const crypto = require('crypto');
  const body = b64({ c: C, p: P1, iat: 1, exp: 9999999999 });
  const sig = crypto.createHmac('sha256', 'test-secret').update(body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(verifyPaymentToken(`${body}.${sig}`).reason, 'pre_tenure_link');
  if (prev === undefined) delete process.env.PAYMENT_LINK_SECRET; else process.env.PAYMENT_LINK_SECRET = prev;
});

// ---------------------------------------------------------------- reversals + mode safety
t('full refund reverses through the controlled path once; partial refund is flagged, not reversed', async () => {
  const st = fakeStore();
  await run(st, ev('evt_12', 'checkout.session.completed', sess('paid')));
  await run(st, ev('evt_13', 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', refunded: false, amount_refunded: 500, amount: 20000 }));
  assert.strictEqual(st.reversals.length, 0); assert.strictEqual(st.pay.needs_review, true);
  await run(st, ev('evt_14', 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', refunded: true, amount_refunded: 20000, amount: 20000 }));
  await run(st, ev('evt_15', 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', refunded: true, amount_refunded: 20000, amount: 20000 }));
  assert.strictEqual(st.reversals.length, 1);
});
t('an event from the wrong Stripe mode is ignored and credits nothing', async () => {
  const st = fakeStore();
  await run(st, ev('evt_16', 'checkout.session.completed', sess('paid'), { livemode: true }));
  assert.strictEqual(st.credits.length, 0); assert.strictEqual(st.events.get('evt_16').status, 'ignored');
});

(async () => {
  await Promise.all(results);
  console.log(failed ? `\n${failed} FAILED` : '\nall payment foundation checks passed');
  process.exitCode = failed ? 1 : 0;
})();
