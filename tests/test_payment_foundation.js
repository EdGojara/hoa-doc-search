// tests/test_payment_foundation.js — safe Stripe payment foundation (migration 469).
// Pure: fakes for Supabase, Stripe and the payment store. The SQL state machine the
// fake store mirrors is rehearsed against Postgres in tests/sql/469_payment_rehearsal.mjs.
// Run: node tests/test_payment_foundation.js
const assert = require('assert');
const { stripeMode, requireTestMode } = require('../lib/payments/stripe_mode');
const { authorizeHomeownerPayment } = require('../lib/payments/homeowner_checkout');
const { createAssessmentCheckout, checkoutModeGate } = require('../lib/payments/assessment_checkout');
const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');
const { verifyPaymentToken, signPaymentToken } = require('../lib/payments/payment_link');
const { sandboxException } = require('../lib/payments/payment_sandbox');
const { verifyStripeWebhook } = require('../lib/payments/webhook_auth');

// payment_store posts through lib/accounting/posting; stub it so this file stays offline.
const journal = [];
require.cache[require.resolve('../lib/accounting/posting')] = { id: 'posting-stub', loaded: true, exports: {
  async postJournalEntry(e) { journal.push(e); return { entry: { id: `je-${journal.length}` } }; },
} };
const { createPaymentStore } = require('../lib/payments/payment_store');

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
// sandbox: true -> the lot is THE payment-sandbox lot in a demo community.
function world({ tenureId = SELLER, balance = 25000, trusted = '1004384184', sandbox = false, demo = sandbox } = {}) {
  return fakeSupabase({
    properties: [{ id: P1, community_id: C, street_address: sandbox ? 'DC-45-060' : '4707 Lakes of Pine Forest Ct', trusted_account_number: trusted, vantaca_account_id: '2013059', payment_sandbox: sandbox }],
    communities: [{ id: C, name: demo ? 'Drama Creek Estates' : 'Lakes of Pine Forest', slug: demo ? 'drama-creek' : 'lopf', stripe_connected_account_id: 'acct_test_1', gl_cutover_date: '2026-08-01', is_demo: demo }],
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
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY },
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
  const test = await createAssessmentCheckout({ supabase: world({ sandbox: true }), stripeLib: fakeStripe(), key: TEST_KEY },
    { propertyId: P1, paymentMethod: 'card', initiatedBy: 'staff_test', ...urls, testAmountCents: 100 });
  assert.ok(test.ok && test.amount_cents === 100, JSON.stringify(test));
});

// ---------------------------------------------------------------- identity captured server-side
t('checkout records tenure, property, Trusted #, contact and group, and sends them to Stripe', async () => {
  const sb = world(); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'card', initiatedBy: 'homeowner_portal', ...urls });
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
  assert.strictEqual((await createAssessmentCheckout({ supabase: noOwner, stripeLib: fakeStripe(), key: LIVE_KEY }, { propertyId: P1, ...urls })).error, 'no_current_owner');
  assert.strictEqual((await createAssessmentCheckout({ supabase: world({ trusted: null }), stripeLib: fakeStripe(), key: LIVE_KEY }, { propertyId: P1, ...urls })).error, 'no_trusted_account_number');
});

// ---------------------------------------------------------------- test-mode containment (mode gate)
t('TEST key + real community: homeowner portal checkout refused, no payment rows, no Stripe session', async () => {
  const sb = world(); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: TEST_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'test_mode_sandbox_only'); assert.strictEqual(r.status, 403);
  assert.strictEqual(sb._db.payments.length, 0, 'no payment rows'); assert.strictEqual(st.sessions.length, 0, 'no Stripe session');
});
t('TEST key + real community: pay link and staff $1 test route are refused too', async () => {
  for (const [initiatedBy, extra] of [['payment_link', {}], ['staff_test', { testAmountCents: 100 }]]) {
    const sb = world(); const st = fakeStripe();
    const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: TEST_KEY }, { propertyId: P1, paymentMethod: 'card', initiatedBy, ...urls, ...extra });
    assert.strictEqual(r.error, 'test_mode_sandbox_only', initiatedBy);
    assert.strictEqual(sb._db.payments.length + st.sessions.length, 0, `${initiatedBy}: nothing written, no session`);
  }
});
t('TEST key + the approved sandbox lot (demo community): portal and staff test route allowed', async () => {
  for (const [initiatedBy, extra] of [['homeowner_portal', {}], ['staff_test', { testAmountCents: 100 }]]) {
    const sb = world({ sandbox: true }); const st = fakeStripe();
    const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: TEST_KEY }, { propertyId: P1, paymentMethod: 'card', initiatedBy, ...urls, ...extra });
    assert.ok(r.ok, `${initiatedBy}: ${JSON.stringify(r)}`); assert.strictEqual(st.sessions.length, 1); assert.ok(sb._db.payments.length >= 1);
  }
});
t('TEST key: a sandbox-flagged lot outside a demo community is still refused', async () => {
  const sb = world({ sandbox: true, demo: false }); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: TEST_KEY }, { propertyId: P1, ...urls });
  assert.strictEqual(r.error, 'test_mode_sandbox_only'); assert.strictEqual(st.sessions.length, 0);
});
t('LIVE key + properly enabled real community: allowed by the mode gate (mock Stripe)', async () => {
  const sb = world(); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(st.sessions.length, 1);
  assert.ok(sb._db.payments.every((p) => p.livemode === true), 'rows record livemode');
});
t('LIVE key + the sandbox lot / a demo community: refused, nothing written', async () => {
  const sb = world({ sandbox: true }); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, ...urls });
  assert.strictEqual(r.error, 'sandbox_not_payable_live'); assert.strictEqual(sb._db.payments.length + st.sessions.length, 0);
});
t('mode gate: unconfigured key never opens a session', () => {
  const idn = { property: { payment_sandbox: false }, community: { is_demo: false } };
  assert.strictEqual(checkoutModeGate('unconfigured', idn).error, 'payment_not_configured');
  assert.strictEqual(checkoutModeGate('live', idn).ok, true);
  assert.strictEqual(checkoutModeGate('test', idn).error, 'test_mode_sandbox_only');
  assert.strictEqual(checkoutModeGate('test', { property: { payment_sandbox: true }, community: { is_demo: true } }).ok, true);
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
    async reversePayment(id, { kind, reason }) {
      if (pay.posting === 'reversed') return { action: 'already_reversed' };
      if (pay.posting !== 'posted') { pay.needs_review = true; return { action: 'review' }; }
      pay.posting = 'reversed'; reversals.push({ id, kind, reason }); return { action: 'reversed' };
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
  const sb = world({ tenureId: BUYER }); const r = await createAssessmentCheckout({ supabase: sb, stripeLib: fakeStripe(), key: LIVE_KEY }, { propertyId: P1, ...urls });
  assert.strictEqual(sb._db.payments[0].tenure_id, BUYER, 'a checkout after the sale belongs to the buyer');
  const st = fakeStore({ tenureId: SELLER }); // a checkout the SELLER started before the sale
  await run(st, ev('evt_10', 'checkout.session.completed', sess('unpaid')));
  await run(st, ev('evt_11', 'checkout.session.async_payment_succeeded', sess('paid'))); // settles after the sale
  assert.deepStrictEqual(st.credits.map((c) => c.tenure), [SELLER], 'the seller payment credits the seller, not the buyer');
  assert.ok(r.ok);
});
t('a pay link is bound to the owner it was issued for; old unbound links are refused', () => {
  const prev = process.env.PAYMENT_LINK_SECRET; process.env.PAYMENT_LINK_SECRET = 'x'.repeat(40);
  const tok = signPaymentToken({ community_id: C, property_id: P1, tenure_id: SELLER });
  assert.strictEqual(verifyPaymentToken(tok).tenure_id, SELLER);
  assert.throws(() => signPaymentToken({ community_id: C, property_id: P1 }));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const crypto = require('crypto');
  const body = b64({ c: C, p: P1, iat: 1, exp: 9999999999 });
  const sig = crypto.createHmac('sha256', 'x'.repeat(40)).update(body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(verifyPaymentToken(`${body}.${sig}`).reason, 'pre_tenure_link');
  if (prev === undefined) delete process.env.PAYMENT_LINK_SECRET; else process.env.PAYMENT_LINK_SECRET = prev;
});
t('pay links require a dedicated PAYMENT_LINK_SECRET: no fallback to other credentials', () => {
  const keys = ['PAYMENT_LINK_SECRET', 'STAFF_GATE_SECRET', 'STAFF_PASSWORD', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.PAYMENT_LINK_SECRET;
    process.env.STAFF_GATE_SECRET = 'a'.repeat(40); process.env.STAFF_PASSWORD = 'b'.repeat(40);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_' + 'c'.repeat(40); process.env.SUPABASE_KEY = 'd'.repeat(80);
    let err = null; try { signPaymentToken({ community_id: C, property_id: P1, tenure_id: SELLER }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'payment_link_not_configured', 'minting refused even though other credentials exist');
    assert.strictEqual(verifyPaymentToken('abc.def').reason, 'not_configured', 'verification refused loudly, not reported as a bad link');
    process.env.PAYMENT_LINK_SECRET = 'short-secret';
    err = null; try { signPaymentToken({ community_id: C, property_id: P1, tenure_id: SELLER }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'payment_link_not_configured', 'a short secret is refused');
    process.env.PAYMENT_LINK_SECRET = 'e'.repeat(40);
    const tok = signPaymentToken({ community_id: C, property_id: P1, tenure_id: SELLER });
    process.env.PAYMENT_LINK_SECRET = 'f'.repeat(40);
    assert.strictEqual(verifyPaymentToken(tok).reason, 'bad_signature', 'a link signed with a different secret is refused');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
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
  assert.strictEqual(st.reversals[0].kind, 'refund');
});
t('a full-amount dispute reverses as a chargeback; a partial dispute is flagged', async () => {
  const st = fakeStore();
  await run(st, ev('evt_20', 'checkout.session.completed', sess('paid')));
  await run(st, ev('evt_21', 'charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_1', amount: 5000 }));
  assert.strictEqual(st.reversals.length, 0); assert.strictEqual(st.pay.needs_review, true);
  await run(st, ev('evt_22', 'charge.dispute.created', { id: 'dp_2', payment_intent: 'pi_1', amount: st.pay.amount }));
  assert.deepStrictEqual(st.reversals.map((r) => r.kind), ['chargeback']);
});

// ---------------------------------------------------------------- GL accounts come from account roles
let worldSeq = 0;
function storeWorld({ roles = true } = {}) {
  // Own community per test: the tests run concurrently and share the journal stub.
  const C = `comm-store-${++worldSeq}`;
  const sb = fakeSupabase({
    payments: [{ id: 'pay-1', community_id: C, property_id: P1, amount_cents: 20000, settlement_state: 'settled', posting_state: 'not_posted' }],
    communities: [{ id: C, gl_cutover_date: '2026-08-01' }],
    // Deliberately NOT 1090/1300: code must follow the role, not a number.
    chart_of_accounts: [
      { id: 'acct-clear', community_id: C, account_number: '1095', is_active: true, is_summary: false },
      { id: 'acct-ar', community_id: C, account_number: '1310', is_active: true, is_summary: false },
      { id: 'acct-1090', community_id: C, account_number: '1090', is_active: true, is_summary: false },
      { id: 'acct-1300', community_id: C, account_number: '1300', is_active: true, is_summary: false },
    ],
    community_account_roles: roles ? [
      { community_id: C, role: 'stripe_clearing', account_id: 'acct-clear' },
      { community_id: C, role: 'homeowner_ar', account_id: 'acct-ar' },
    ] : [],
    journal_entries: [],
  });
  const calls = [];
  sb.rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'post_stripe_tenure_payment') return { data: { payment_txn_id: 'txn-1', applied_cents: 20000, unapplied_cents: 0 }, error: null };
    if (fn === 'payment_commit_posting') return { data: { homeowner_txn_id: 'txn-1' }, error: null };
    if (fn === 'reverse_stripe_tenure_payment') return { data: { already_drafted: false, reversal_txn_id: 'rev-1', batch_status: 'draft' }, error: null };
    if (fn === 'payment_commit_reversal') return { data: { reversal_txn_id: 'rev-1', applications_reversed: 1, reopened_cents: 20000 }, error: null };
    return { data: null, error: null };
  };
  const mine = () => journal.filter((e) => e.community_id === C);
  return { sb, calls, mine, store: createPaymentStore({ supabase: sb, log: quiet }) };
}
t('posting uses the community\'s stripe_clearing / homeowner_ar ROLE accounts, never 1090/1300 by number', async () => {
  const { store, calls, mine } = storeWorld();
  const r = await store.postPayment('pay-1', { paymentDate: '2026-09-27' });
  assert.strictEqual(r.posting, 'posted');
  const lines = mine()[0].lines;
  assert.deepStrictEqual(lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents]), [['acct-clear', 20000, 0], ['acct-ar', 0, 20000]]);
  assert.strictEqual(mine()[0].source_reference, 'stripe:pay:pay-1');
  assert.ok(calls.some((c) => c.fn === 'payment_commit_posting'));
});
t('a community with no account roles is BLOCKED for an operator; nothing is credited', async () => {
  const { store, calls, mine } = storeWorld({ roles: false });
  const r = await store.postPayment('pay-1', { paymentDate: '2026-09-27' });
  assert.strictEqual(r.posting, 'blocked'); assert.strictEqual(r.reason, 'missing_account_role');
  assert.strictEqual(mine().length, 0);
  assert.ok(!calls.some((c) => c.fn === 'post_stripe_tenure_payment'), 'no AR row drafted');
  assert.ok(calls.some((c) => c.fn === 'payment_mark_posting' && c.args.p_state === 'blocked'));
});
t('reversal drafts the reversal row, posts Dr AR / Cr clearing by role, then commits (original kept)', async () => {
  const { store, calls, mine } = storeWorld();
  const r = await store.reversePayment('pay-1', { kind: 'refund', reason: 'refund re_1', reversalDate: '2026-10-02' });
  assert.strictEqual(r.action, 'reversed');
  const draft = calls.find((c) => c.fn === 'reverse_stripe_tenure_payment');
  assert.deepStrictEqual(draft.args, { p_payment_id: 'pay-1', p_kind: 'refund', p_reason: 'refund re_1', p_reversal_date: '2026-10-02' });
  assert.deepStrictEqual(mine()[0].lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents]), [['acct-ar', 20000, 0], ['acct-clear', 0, 20000]]);
  assert.strictEqual(mine()[0].source_reference, 'stripe:rev:pay-1');
  assert.ok(calls.findIndex((c) => c.fn === 'payment_commit_reversal') > calls.findIndex((c) => c.fn === 'reverse_stripe_tenure_payment'));
});
t('reversal with no account roles stays a draft and is flagged; the ledger still shows the payment', async () => {
  const { store, calls, mine } = storeWorld({ roles: false });
  const r = await store.reversePayment('pay-1', { kind: 'chargeback', reason: 'dispute dp_1', reversalDate: '2026-10-02' });
  assert.strictEqual(r.action, 'reversal_blocked');
  assert.strictEqual(mine().length, 0);
  assert.ok(!calls.some((c) => c.fn === 'payment_commit_reversal'));
  assert.ok(calls.some((c) => c.fn === 'payment_flag_review'));
});

// ---------------------------------------------------------------- payment sandbox: the one demo exception
const DCX = 'dc-comm', LOTX = 'dc-lot-sandbox', OTHER = 'dc-lot-other';
function sandboxDb({ fail = false } = {}) {
  const sb = fakeSupabase({ properties: [
    { id: LOTX, community_id: DCX, payment_sandbox: true, communities: { is_demo: true } },
    { id: OTHER, community_id: DCX, payment_sandbox: false, communities: { is_demo: true } },
  ] });
  if (fail) sb.from = () => { throw new Error('column properties.payment_sandbox does not exist'); };
  return sb;
}
const sbx = (o) => sandboxException({ channel: 'stripe:checkout', communityId: DCX, sandboxPropertyId: LOTX, reasons: ['demo_community', 'demo_recipient'], key: TEST_KEY, supabase: sandboxDb(), ...o });
t('sandbox: test key + the sandbox lot may reach Stripe checkout', async () => {
  assert.strictEqual((await sbx({})).allowed, true);
});
t('sandbox: a LIVE key is always blocked, even for the sandbox lot', async () => {
  assert.strictEqual((await sbx({ key: LIVE_KEY })).allowed, false);
  assert.strictEqual((await sbx({ key: '' })).allowed, false);
});
t('sandbox: any other Drama Creek lot stays blocked', async () => {
  assert.strictEqual((await sbx({ sandboxPropertyId: OTHER })).allowed, false);
  assert.strictEqual((await sbx({ sandboxPropertyId: null })).allowed, false);
});
t('sandbox: the lot must be in the community being charged', async () => {
  assert.strictEqual((await sbx({ communityId: 'real-community' })).allowed, false);
});
t('sandbox: refunds, off-session charges and running demo workflows stay blocked', async () => {
  assert.strictEqual((await sbx({ channel: 'stripe:refund' })).allowed, false);
  assert.strictEqual((await sbx({ channel: 'stripe:charge' })).allowed, false);
  assert.strictEqual((await sbx({ reasons: ['demo_community', 'demo_context'] })).allowed, false);
});
t('sandbox: connected-account onboarding allowed only for the community holding the sandbox lot (test key)', async () => {
  assert.strictEqual((await sbx({ channel: 'stripe:account', sandboxPropertyId: null })).allowed, true);
  assert.strictEqual((await sbx({ channel: 'stripe:account', sandboxPropertyId: null, communityId: 'other-demo' })).allowed, false);
  assert.strictEqual((await sbx({ channel: 'stripe:account', sandboxPropertyId: null, key: LIVE_KEY })).allowed, false);
});
t('sandbox: a lookup failure (e.g. migration 469 not applied) fails closed', async () => {
  assert.strictEqual((await sbx({ supabase: sandboxDb({ fail: true }) })).allowed, false);
});
t('an event from the wrong Stripe mode is ignored and credits nothing', async () => {
  const st = fakeStore();
  await run(st, ev('evt_16', 'checkout.session.completed', sess('paid'), { livemode: true }));
  assert.strictEqual(st.credits.length, 0); assert.strictEqual(st.events.get('evt_16').status, 'ignored');
});

// ---------------------------------------------------------------- webhook signing: platform vs connected-account secret
const PLATFORM_SECRET = 'whsec_platform_' + 'p'.repeat(24), CONNECT_SECRET = 'whsec_connect_' + 'c'.repeat(24);
const signStripe = (body, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${require('crypto').createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};
const platformEvt = Buffer.from(JSON.stringify({ id: 'evt_p1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_1' } } }));
const connectEvt = Buffer.from(JSON.stringify({ id: 'evt_c1', type: 'account.updated', account: 'acct_123', livemode: false, data: { object: { id: 'acct_123' } } }));
const both = { platformSecret: PLATFORM_SECRET, connectSecret: CONNECT_SECRET };
t('webhook: platform event + platform secret => accepted', () => {
  const r = verifyStripeWebhook(platformEvt, signStripe(platformEvt, PLATFORM_SECRET), both);
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.source, 'platform'); assert.strictEqual(r.event.id, 'evt_p1');
});
t('webhook: platform event signed with the connect secret => refused', () => {
  const r = verifyStripeWebhook(platformEvt, signStripe(platformEvt, CONNECT_SECRET), both);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 400); assert.strictEqual(r.source, 'platform');
});
t('webhook: platform event with only the connect secret configured => refused', () => {
  const r = verifyStripeWebhook(platformEvt, signStripe(platformEvt, CONNECT_SECRET), { platformSecret: undefined, connectSecret: CONNECT_SECRET });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 503); assert.strictEqual(r.error, 'platform_webhook_secret_not_configured');
});
t('webhook: connected-account account.updated + connect secret => accepted', () => {
  const r = verifyStripeWebhook(connectEvt, signStripe(connectEvt, CONNECT_SECRET), both);
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.source, 'connect'); assert.strictEqual(r.event.type, 'account.updated');
});
t('webhook: connected-account account.updated signed with the platform secret => refused', () => {
  const r = verifyStripeWebhook(connectEvt, signStripe(connectEvt, PLATFORM_SECRET), both);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 400); assert.strictEqual(r.source, 'connect');
});
t('webhook: missing connect secret refuses connected-account events (503) while platform payment events keep working', () => {
  const onlyPlatform = { platformSecret: PLATFORM_SECRET, connectSecret: undefined };
  const c = verifyStripeWebhook(connectEvt, signStripe(connectEvt, PLATFORM_SECRET), onlyPlatform);
  assert.strictEqual(c.ok, false); assert.strictEqual(c.status, 503); assert.strictEqual(c.error, 'connect_webhook_secret_not_configured');
  assert.ok(verifyStripeWebhook(platformEvt, signStripe(platformEvt, PLATFORM_SECRET), onlyPlatform).ok);
});
t('webhook: no secrets at all => every delivery refused', () => {
  const none = { platformSecret: undefined, connectSecret: undefined };
  assert.strictEqual(verifyStripeWebhook(platformEvt, signStripe(platformEvt, PLATFORM_SECRET), none).ok, false);
  assert.strictEqual(verifyStripeWebhook(connectEvt, signStripe(connectEvt, CONNECT_SECRET), none).ok, false);
});
t('webhook: unsigned, malformed, stale or tampered deliveries are refused', () => {
  assert.strictEqual(verifyStripeWebhook(platformEvt, undefined, both).error, 'missing_signature');
  assert.strictEqual(verifyStripeWebhook(Buffer.from('not json'), signStripe('not json', PLATFORM_SECRET), both).error, 'malformed_body');
  const old = Math.floor(Date.now() / 1000) - 3600;
  const staleSig = `t=${old},v1=${require('crypto').createHmac('sha256', PLATFORM_SECRET).update(`${old}.${platformEvt}`).digest('hex')}`;
  assert.strictEqual(verifyStripeWebhook(platformEvt, staleSig, both).ok, false, 'replayed old delivery refused');
  // Strip `account` from a genuine connect delivery: it now claims to be platform and fails the platform secret.
  const sig = signStripe(connectEvt, CONNECT_SECRET);
  const stripped = Buffer.from(JSON.stringify({ ...JSON.parse(connectEvt), account: undefined }));
  const r = verifyStripeWebhook(stripped, sig, both);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.source, 'platform');
  // Add `account` to a genuine platform delivery: it now claims connect and fails the connect secret.
  const added = Buffer.from(JSON.stringify({ ...JSON.parse(platformEvt), account: 'acct_evil' }));
  assert.strictEqual(verifyStripeWebhook(added, signStripe(platformEvt, PLATFORM_SECRET), both).ok, false);
});

(async () => {
  await Promise.all(results);
  console.log(failed ? `\n${failed} FAILED` : '\nall payment foundation checks passed');
  process.exitCode = failed ? 1 : 0;
})();
