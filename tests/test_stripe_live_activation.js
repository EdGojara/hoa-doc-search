// tests/test_stripe_live_activation.js — Stripe live activation E1 + E2 (Ed 2026-11-27).
//
// E1: a connected account stored on a community must exist IN THE CURRENT STRIPE
//     MODE before anything treats it as ready. A sandbox account stored as
//     'enabled' does not exist under the live key; the payment gate refuses it,
//     onboarding replaces it (audit-logged), and a lookup that merely fails never
//     counts as "missing".
// E2: the owner's live $1.00 verification: fixed amount, runs before the
//     homeowner payments switch, same gates otherwise (demo refused live; test
//     key = sandbox lot only), and the webhook refunds it through the shared
//     refund path once Stripe confirms it.
// Pure: fakes for Supabase, Stripe and the store. Run: node tests/test_stripe_live_activation.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.PORTAL_COOKIE_SECRET = 'test-secret-for-quote-tokens';
// payment_store posts through lib/accounting/posting; stub it so this file stays offline.
require.cache[require.resolve('../lib/accounting/posting')] = { id: 'posting-stub', loaded: true, exports: {
  async postJournalEntry() { return { entry: { id: 'je-stub' } }; },
} };
const CAC = require('../lib/payments/connected_account_check');
const AI = require('../lib/payments/assessment_intent');
const LV = require('../lib/payments/live_verification');
const { refundPaymentRow } = require('../lib/payments/refund_payment');
const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');
const { createPaymentStore } = require('../lib/payments/payment_store');

let failed = 0;
// Sequential on purpose: some cases set STRIPE_PUBLISHABLE_KEY for their mode.
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
// Tests share the module-level account cache, so each uses its own account id.
let acctSeq = 0;
const freshAcct = () => `acct_case_${++acctSeq}`;

// ---------------------------------------------------------------- fakes
function fakeSupabase(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  db.payments = db.payments || [];
  db.portal_audit_log = db.portal_audit_log || [];
  let seq = 0;
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let limitN = null; let single = null;
    const run = () => {
      const rows = db[table] || [];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `row${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...r }));
        db[table] = rows.concat(list);
        return { data: list, error: null };
      }
      if (op === 'update') { match.forEach((r) => Object.assign(r, payload)); return { data: match, error: null }; }
      const out = limitN != null ? match.slice(0, limitN) : match;
      if (single === 'maybe') return { data: out[0] || null, error: null };
      if (single === 'one') return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
      not(c, op2, v) { filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return b; },
      is(c, v) { filters.push((r) => (r[c] == null) === (v == null)); return b; },
      in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { single = 'maybe'; return b; },
      single() { single = 'one'; return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(patch) { op = 'update'; payload = patch; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  return { from: builder, rpc: async (fn, args) => { (db._rpc = db._rpc || []).push({ fn, args }); return { data: null, error: null }; }, _db: db };
}

const P1 = 'prop-1', C = 'comm-1', TEN = 'ten-1';
const FEES = { card_fee_bps: 350, debit_card_fee_bps: null, ach_fee_cents: 295, ach_tier_threshold_cents: 35000, ach_fee_above_cents: 595 };
function world({ acct, balance = 71900, paymentsOn = true, demo = false, sandbox = false, fees = FEES } = {}) {
  const cfg = { balance: { status: 'live' }, homeowner_financials: { verified_at: '2026-11-01', verified_by: 'owner', payments: paymentsOn } };
  if (!paymentsOn) delete cfg.homeowner_financials;
  if (fees) cfg.payment_fees = fees;
  return fakeSupabase({
    properties: [{ id: P1, community_id: C, street_address: '1 Test Ct', trusted_account_number: 'T-TEST-1', payment_sandbox: sandbox }],
    communities: [{ id: C, name: 'Test Association', slug: 'test', hoa_legal_name: 'Test Association, Inc.',
      stripe_connected_account_id: acct, gl_cutover_date: '2026-08-01', is_demo: demo, stripe_onboarding_status: 'enabled', portal_module_config: cfg }],
    ownership_tenures: [{ id: TEN, community_id: C, property_id: P1, kind: 'owner', end_date: null, start_date: '2026-01-01' }],
    property_ownerships: [{ tenure_id: TEN, contact_id: 'contact-1', is_primary: true, start_date: '2026-01-01' }],
    v_current_owner_balance: [{ tenure_id: TEN, balance_cents: balance }],
  });
}
const PMS = { pm_credit_visa: { id: 'pm_credit_visa', type: 'card', card: { brand: 'visa', funding: 'credit', last4: '4242' } } };
// account: 'enabled' | 'restricted' | 'missing' (not in this mode) | 'error' (lookup failed)
function fakeStripe({ account = 'enabled' } = {}) {
  const created = []; const lookups = []; const refunds = [];
  return {
    created, lookups, refunds,
    isConfigured: () => true,
    async retrieveAccountRequirements(id) {
      lookups.push(id);
      if (account === 'missing') return { ok: false, error: `No such account: '${id}'; a similar object exists in test mode, but a live mode key was used to make this request.`, stripeCode: 'resource_missing', httpStatus: 404, missing: true };
      if (account === 'error') return { ok: false, error: 'socket hang up' };
      return { ok: true, charges_enabled: account === 'enabled', payouts_enabled: account === 'enabled', details_submitted: true, currently_due: [], past_due: [] };
    },
    async retrievePaymentMethod(id) { return PMS[id] ? { ok: true, payment_method: PMS[id] } : { ok: false, error: 'No such PaymentMethod' }; },
    async cancelPaymentIntent() { return { ok: true }; },
    async createAssessmentPaymentIntent(opts) {
      created.push(opts);
      return { ok: true, payment_intent: { id: `pi_${created.length}`, status: 'succeeded', metadata: opts.metadata } };
    },
    async refund(opts) { refunds.push(opts); return { ok: true, refund_id: `re_${refunds.length}`, amount_cents: 104, status: 'succeeded' }; },
  };
}
const LIVE = 'sk_live_x', TEST = 'sk_test_x';
const deps = (sb, st, key = LIVE) => ({ supabase: sb, stripeLib: st, key });
const homeowner = { propertyId: P1, initiatedBy: 'homeowner_portal' };
const verification = { propertyId: P1, initiatedBy: 'live_verification' };

// ---------------------------------------------------------------- E1: the account check
t('E1: only a definite Stripe "no such account" counts as missing', () => {
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, stripeCode: 'resource_missing' }), true);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, stripeCode: 'account_invalid' }), true);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, httpStatus: 404, error: 'x' }), true);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, error: "No such account: 'acct_1'" }), true);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, error: 'a similar object exists in test mode, but a live mode key was used' }), true);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, error: 'socket hang up' }), false);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: false, httpStatus: 500, error: 'api error' }), false);
  assert.strictEqual(CAC.isMissingAccountResult({ ok: true }), false);
  assert.strictEqual(CAC.isMissingAccountResult(null), false);
});
t('E1: check result per mode; failures are ok:false and never cached; clear() drops the entry', async () => {
  const id = freshAcct();
  const missing = fakeStripe({ account: 'missing' });
  const r1 = await CAC.checkConnectedAccount(missing, id, { mode: 'live' });
  assert.deepStrictEqual([r1.ok, r1.exists], [true, false]);
  // Cached per mode: the same id under the test key is a separate question.
  const ok = fakeStripe({ account: 'enabled' });
  const r2 = await CAC.checkConnectedAccount(ok, id, { mode: 'test' });
  assert.deepStrictEqual([r2.ok, r2.exists, r2.charges_enabled], [true, true, true]);
  // Cache hit: no second lookup inside the TTL.
  await CAC.checkConnectedAccount(missing, id, { mode: 'live' });
  assert.strictEqual(missing.lookups.length, 1);
  CAC.clearAccountCheck(id);
  await CAC.checkConnectedAccount(missing, id, { mode: 'live' });
  assert.strictEqual(missing.lookups.length, 2);
  // A failed lookup is not cached and is not "missing".
  const id2 = freshAcct(); const flaky = fakeStripe({ account: 'error' });
  const r3 = await CAC.checkConnectedAccount(flaky, id2, { mode: 'live' });
  assert.strictEqual(r3.ok, false);
  await CAC.checkConnectedAccount(flaky, id2, { mode: 'live' });
  assert.strictEqual(flaky.lookups.length, 2);
  // Expired entries are re-read.
  const id3 = freshAcct(); const st3 = fakeStripe();
  await CAC.checkConnectedAccount(st3, id3, { mode: 'live', now: 0 });
  await CAC.checkConnectedAccount(st3, id3, { mode: 'live', now: CAC.CACHE_TTL_MS + 1 });
  assert.strictEqual(st3.lookups.length, 2);
  // No account / no lookup function.
  assert.strictEqual((await CAC.checkConnectedAccount(st3, null, { mode: 'live' })).exists, false);
  assert.strictEqual((await CAC.checkConnectedAccount({}, 'acct_x', { mode: 'live' })).ok, false);
});
t('E1: payment gate refuses a stored account that does not exist in live mode (no PaymentIntent)', async () => {
  const st = fakeStripe({ account: 'missing' });
  const r = await AI.setupAssessmentPayment(deps(world({ acct: freshAcct() }), st), homeowner);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'community_stripe_not_onboarded');
  const q = await AI.quoteAssessmentPayment(deps(world({ acct: freshAcct() }), st), { ...homeowner, paymentMethodId: 'pm_credit_visa' });
  assert.strictEqual(q.error, 'community_stripe_not_onboarded');
  assert.strictEqual(st.created.length, 0);
});
t('E1: payment gate refuses a restricted account and fails closed when Stripe cannot be read', async () => {
  const r1 = await AI.setupAssessmentPayment(deps(world({ acct: freshAcct() }), fakeStripe({ account: 'restricted' })), homeowner);
  assert.strictEqual(r1.error, 'community_stripe_not_enabled');
  const r2 = await AI.setupAssessmentPayment(deps(world({ acct: freshAcct() }), fakeStripe({ account: 'error' })), homeowner);
  assert.strictEqual(r2.error, 'stripe_account_unavailable'); assert.strictEqual(r2.status, 503);
});
t('E1: an account that exists in this mode and takes charges passes the gate unchanged', async () => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_x';
  const r = await AI.setupAssessmentPayment(deps(world({ acct: freshAcct() }), fakeStripe()), homeowner);
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.assessment_cents, 71900);
});
t('E1: wiring — onboarding replaces only a missing account, audit first; status screens and /me re-check', () => {
  const pay = fs.readFileSync(path.join(__dirname, '..', 'api', 'payments.js'), 'utf8');
  const onboard = pay.slice(pay.indexOf("router.post('/connect/onboard'"), pay.indexOf("router.get('/connect/status'"));
  assert.ok(/checkConnectedAccount\(stripeLib, accountId, \{ mode, useCache: false \}\)/.test(onboard), 'onboard re-reads the stored account uncached');
  assert.ok(/if \(!chk\.ok\) return res\.status\(502\)/.test(onboard), 'a failed lookup refuses, never replaces');
  const auditAt = onboard.indexOf("'stripe_connected_account_replaced'"); const clearAt = onboard.indexOf('accountId = null');
  assert.ok(auditAt > 0 && clearAt > auditAt, 'old id is audit-logged before it is replaced');
  assert.ok(/if \(aErr\)[\s\S]{0,200}return res\.status\(500\)/.test(onboard), 'no replacement without the audit row');
  const status = pay.slice(pay.indexOf("router.get('/connect/status'"), pay.indexOf("router.get('/connect/portfolio-status'"));
  assert.ok(/isMissingAccountResult\(st\)[\s\S]{0,400}not_in_current_mode/.test(status), 'status reports not_in_current_mode');
  const pf = pay.slice(pay.indexOf("router.get('/connect/portfolio-status'"), pay.indexOf("router.post('/connect/test-onboard'"));
  assert.ok(/checkConnectedAccount/.test(pf) && /accountInMode !== false/.test(pf), 'portfolio re-checks mode before "onboarded"');
  assert.ok(/clearAccountCheck\(acctId\)/.test(pay), 'account.updated clears the cached check');
  const portal = fs.readFileSync(path.join(__dirname, '..', 'api', 'portal.js'), 'utf8');
  assert.ok(/financialAccess\.payments && community\.stripe_connected_account_id[\s\S]{0,600}paymentRefusalFor/.test(portal), '/me hides Pay unless the account is usable in this mode');
});

// ---------------------------------------------------------------- E2: live $1 verification
t('E2: fixed $1.00, runs before the homeowner payments switch, real fee applied', async () => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_x';
  const sb = world({ acct: freshAcct(), paymentsOn: false }); const st = fakeStripe();
  // A homeowner cannot pay yet (switch off) ...
  assert.strictEqual((await AI.setupAssessmentPayment(deps(sb, st), homeowner)).error, 'online_payments_not_enabled');
  // ... the owner's verification can, for exactly $1.00 whatever the lot owes.
  const s = await LV.runVerificationStep(deps(sb, st), 'setup', { propertyId: P1, ownerEmail: 'owner@example.test' });
  assert.strictEqual(s.ok, true, JSON.stringify(s)); assert.strictEqual(s.assessment_cents, 100); assert.strictEqual(s.mode, 'live');
  const q = await LV.runVerificationStep(deps(sb, st), 'quote', { propertyId: P1, paymentMethodId: 'pm_credit_visa' });
  assert.strictEqual(q.assessment_cents, 100); assert.strictEqual(q.fee_cents, 4); assert.strictEqual(q.total_cents, 104);
  const c = await LV.runVerificationStep(deps(sb, st), 'confirm', { propertyId: P1, paymentMethodId: 'pm_credit_visa', quoteToken: q.quote_token, ownerEmail: 'owner@example.test' });
  assert.strictEqual(c.ok, true, JSON.stringify(c)); assert.strictEqual(st.created.length, 1);
  assert.strictEqual(st.created[0].amountCents, 104); assert.strictEqual(st.created[0].applicationFeeCents, 4);
  assert.strictEqual(st.created[0].metadata.initiated_by, 'live_verification');
  const rows = sb._db.payments.filter((p) => p.payment_group_id === c.group_id);
  assert.ok(rows.length >= 1 && rows.every((p) => p.initiated_by === 'live_verification'));
  const audits = sb._db.portal_audit_log.map((a) => a.action);
  assert.deepStrictEqual(audits, ['live_verification_setup', 'live_verification_confirm']);
  assert.ok(sb._db.portal_audit_log.every((a) => a.performed_by === 'owner@example.test' && a.resource_id === P1));
});
t('E2: demo lots refused under the live key; test key accepts only the sandbox lot', async () => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_x';
  const demoLive = await LV.runVerificationStep(deps(world({ acct: freshAcct(), demo: true }), fakeStripe()), 'setup', { propertyId: P1 });
  assert.strictEqual(demoLive.error, 'sandbox_not_payable_live');
  const sandboxLive = await LV.runVerificationStep(deps(world({ acct: freshAcct(), demo: true, sandbox: true }), fakeStripe()), 'setup', { propertyId: P1 });
  assert.strictEqual(sandboxLive.error, 'sandbox_not_payable_live');
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_x';
  const realTest = await LV.runVerificationStep(deps(world({ acct: freshAcct() }), fakeStripe(), TEST), 'setup', { propertyId: P1 });
  assert.strictEqual(realTest.error, 'test_mode_sandbox_only');
  const sandboxTest = await LV.runVerificationStep(deps(world({ acct: freshAcct(), demo: true, sandbox: true }), fakeStripe(), TEST), 'setup', { propertyId: P1 });
  assert.strictEqual(sandboxTest.ok, true, JSON.stringify(sandboxTest)); assert.strictEqual(sandboxTest.assessment_cents, 100);
});
t('E2: the verification still needs a usable account, the fee schedule and a valid step', async () => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_x';
  assert.strictEqual((await LV.runVerificationStep(deps(world({ acct: freshAcct() }), fakeStripe({ account: 'missing' })), 'setup', { propertyId: P1 })).error, 'community_stripe_not_onboarded');
  assert.strictEqual((await LV.runVerificationStep(deps(world({ acct: freshAcct(), fees: null }), fakeStripe()), 'setup', { propertyId: P1 })).error, 'payment_fees_not_configured');
  assert.strictEqual((await LV.runVerificationStep(deps(world({ acct: freshAcct() }), fakeStripe()), 'refund', { propertyId: P1 })).error, 'unknown_step');
  assert.strictEqual((await LV.runVerificationStep(deps(world({ acct: freshAcct() }), fakeStripe()), 'setup', {})).error, 'property_id_required');
  // A test amount can never ride along with a verification.
  const AC = require('../lib/payments/assessment_checkout');
  const r = await AC.resolvePayableAssessment(deps(world({ acct: freshAcct() }), fakeStripe(), TEST), { ...verification, testAmountCents: 5000 });
  assert.strictEqual(r.error, 'verification_amount_is_fixed');
});
t('E2: the route is owner-only', () => {
  const pay = fs.readFileSync(path.join(__dirname, '..', 'api', 'payments.js'), 'utf8');
  const route = pay.slice(pay.indexOf("router.post('/live-verification/:step'"));
  assert.ok(route.length > 0, 'route exists');
  assert.ok(/requireOwner\(req, res\);\s*if \(!owner\) return;/.test(route.slice(0, 600)), 'requireOwner before anything else');
});

// ---------------------------------------------------------------- E2: refund on settlement
const quiet = { error() {}, warn() {}, log() {} };
const ev = (id, type, obj) => ({ id, type, livemode: true, created: 1790000000, data: { object: obj } });
const verifyPi = (initiated = 'live_verification') => ({ id: 'pi_v1', object: 'payment_intent', latest_charge: 'ch_v1', payment_method_types: ['card'],
  metadata: { product_type: 'assessment_payment', payment_group_id: 'grp-v', payment_flow: 'payment_element', initiated_by: initiated } });
function lifecycleStore() {
  const events = new Map(); const refunds = []; const credits = [];
  const pay = { state: 'awaiting_payment', posting: 'not_posted' };
  return {
    refunds, credits, pay,
    async claimEvent(e) { const c = events.get(e.id); if (!c) { events.set(e.id, { status: 'processing' }); return 'process'; } return c.status === 'processing' ? 'busy' : 'done'; },
    async finishEvent(id, status) { events.get(id).status = status; },
    async settle() { if (pay.state !== 'settled') { pay.state = 'settled'; return { action: 'post', payment_id: 'pay-v' }; } return pay.posting === 'posted' ? { action: 'done' } : { action: 'post', payment_id: 'pay-v' }; },
    async postPayment(id) { if (pay.posting === 'posted') return { posting: 'already_posted' }; credits.push(id); pay.posting = 'posted'; return { posting: 'posted' }; },
    async refundLiveVerification(a) { refunds.push(a); return { action: refunds.length === 1 ? 'refunded' : 'already_refunded' }; },
  };
}
t('E2: webhook settles + posts the verification, then refunds it; a redelivery never posts twice', async () => {
  const st = lifecycleStore();
  const r = await processWebhookEvent(ev('evt_v1', 'payment_intent.succeeded', verifyPi()), { store: st, mode: 'live', log: quiet });
  assert.strictEqual(r.http, 200);
  assert.strictEqual(st.credits.length, 1, 'posted like any payment');
  assert.deepStrictEqual(st.refunds, [{ group: 'grp-v', paymentIntent: 'pi_v1' }], 'refunded after posting');
  await processWebhookEvent(ev('evt_v2', 'payment_intent.succeeded', verifyPi()), { store: st, mode: 'live', log: quiet });
  assert.strictEqual(st.credits.length, 1, 'never posted twice');
  // An ordinary homeowner payment is never refunded by this path.
  const st2 = lifecycleStore();
  await processWebhookEvent(ev('evt_h1', 'payment_intent.succeeded', verifyPi('homeowner_portal')), { store: st2, mode: 'live', log: quiet });
  assert.strictEqual(st2.refunds.length, 0); assert.strictEqual(st2.credits.length, 1);
});
function storeWorld(rows) {
  return fakeSupabase({ payments: rows });
}
const vRow = (over = {}) => ({ id: 'pay-a', payment_group_id: 'grp-v', product_type: 'assessment_payment', fee_type: 'assessment', initiated_by: 'live_verification',
  status: 'succeeded', amount_cents: 100, processor_payment_id: 'pi_v1', connected_account_id: 'acct_live_1', community_id: C, property_id: P1, ...over });
t('E2: store refunds through the shared path (fee refunded, idempotency key), once', async () => {
  const sb = storeWorld([vRow(), vRow({ id: 'pay-f', fee_type: 'card_fee', payee: 'management_company', amount_cents: 4 })]);
  const stripe = fakeStripe();
  const store = createPaymentStore({ supabase: sb, stripeLib: stripe, log: quiet });
  const r = await store.refundLiveVerification({ group: 'grp-v' });
  assert.strictEqual(r.action, 'refunded');
  assert.strictEqual(stripe.refunds.length, 1);
  const call = stripe.refunds[0];
  assert.strictEqual(call.paymentIntentId, 'pi_v1'); assert.strictEqual(call.refundApplicationFee, true);
  assert.strictEqual(call.connectedAccountId, 'acct_live_1'); assert.strictEqual(call.idempotencyKey, 'live-verify-refund-grp-v');
  assert.strictEqual(sb._db.payments.find((p) => p.id === 'pay-a').status, 'refunded');
  assert.ok(sb._db.portal_audit_log.some((a) => a.action === 'live_verification_refund' && /refund re_1/.test(a.notes)));
  const again = await store.refundLiveVerification({ group: 'grp-v' });
  assert.strictEqual(again.action, 'already_refunded'); assert.strictEqual(stripe.refunds.length, 1);
});
t('E2: store never refunds a homeowner payment or an unsettled one; a failed refund is flagged, not thrown', async () => {
  const stripe = fakeStripe();
  const homeownerStore = createPaymentStore({ supabase: storeWorld([vRow({ initiated_by: 'homeowner_portal' })]), stripeLib: stripe, log: quiet });
  assert.strictEqual((await homeownerStore.refundLiveVerification({ group: 'grp-v' })).action, 'not_a_verification');
  const pendingStore = createPaymentStore({ supabase: storeWorld([vRow({ status: 'pending' })]), stripeLib: stripe, log: quiet });
  assert.strictEqual((await pendingStore.refundLiveVerification({ group: 'grp-v' })).action, 'not_settled');
  assert.strictEqual(stripe.refunds.length, 0);
  const sb = storeWorld([vRow()]);
  const broken = { refund: async () => ({ ok: false, error: 'insufficient funds' }) };
  const failing = createPaymentStore({ supabase: sb, stripeLib: broken, log: quiet });
  const r = await failing.refundLiveVerification({ group: 'grp-v' });
  assert.strictEqual(r.action, 'refund_failed');
  assert.ok((sb._db._rpc || []).some((c) => c.fn === 'payment_flag_review' && /automatic refund failed/.test(c.args.p_reason)));
  assert.strictEqual(sb._db.payments[0].status, 'succeeded', 'row untouched when Stripe refused');
});
t('shared refund path refuses what the route always refused', async () => {
  const st = fakeStripe(); const sb = storeWorld([]);
  assert.strictEqual((await refundPaymentRow({ supabase: sb, stripeLib: st }, null)).status, 404);
  assert.strictEqual((await refundPaymentRow({ supabase: sb, stripeLib: st }, vRow({ status: 'pending' }))).status, 409);
  assert.strictEqual((await refundPaymentRow({ supabase: sb, stripeLib: st }, vRow({ processor_payment_id: null }))).status, 400);
  // Non-assessment payments keep the caller's fee choice (default: keep the fee).
  await refundPaymentRow({ supabase: sb, stripeLib: st }, vRow({ product_type: 'amenity_rental' }));
  assert.strictEqual(st.refunds[0].refundApplicationFee, false);
  assert.strictEqual(st.refunds.length, 1);
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.stack || e.message); }
  }
})().then(() => {
  console.log(failed ? `\n${failed} FAILED` : '\nAll Stripe live activation (E1/E2) tests passed.');
  process.exit(failed ? 1 : 0);
});
