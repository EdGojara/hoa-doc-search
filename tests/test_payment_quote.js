// tests/test_payment_quote.js — funding-aware assessment payments (Ed 2026-11-21).
// lib/payments/fee_quote.js (fee rules), lib/payments/assessment_intent.js
// (setup / quote / confirm) and the PaymentIntent webhook events in
// lib/payments/payment_lifecycle.js. Pure: fakes for Supabase, Stripe and the store.
// Run: node tests/test_payment_quote.js
'use strict';
const assert = require('assert');
process.env.PORTAL_COOKIE_SECRET = 'test-secret-for-quote-tokens';
const FQ = require('../lib/payments/fee_quote');
const AI = require('../lib/payments/assessment_intent');
const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');
const FA = require('../lib/portal/financial_access');

let failed = 0;
const results = [];
const t = (name, fn) => results.push((async () => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.stack || e.message); }
})());

// ---------------------------------------------------------------- fakes
function fakeSupabase(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  db.payments = db.payments || [];
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
      return { data: out, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
      is(c, v) { filters.push((r) => (r[c] == null) === (v == null)); return b; },
      in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { single = 'maybe'; return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(patch) { op = 'update'; payload = patch; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  return { from: builder, _db: db };
}

const P1 = 'prop-1', C = 'comm-1', TEN = 'ten-1';
const FEES = { card_fee_bps: 350, debit_card_fee_bps: null, ach_fee_cents: 295, ach_tier_threshold_cents: 35000, ach_fee_above_cents: 595 };
function world({ balance = 25000, fees = FEES, sandbox = false } = {}) {
  const cfg = { balance: { status: 'live' }, homeowner_financials: { verified_at: '2026-11-01', verified_by: 'owner', payments: true } };
  if (fees) cfg.payment_fees = fees;
  return fakeSupabase({
    properties: [{ id: P1, community_id: C, street_address: '1 Test Ct', trusted_account_number: 'T-TEST-1', payment_sandbox: sandbox }],
    communities: [{ id: C, name: sandbox ? 'Drama Creek Estates' : 'Test Association', slug: 'test', hoa_legal_name: 'Test Association, Inc.',
      stripe_connected_account_id: 'acct_test_1', gl_cutover_date: '2026-08-01', is_demo: sandbox, stripe_onboarding_status: 'enabled', portal_module_config: cfg }],
    ownership_tenures: [{ id: TEN, community_id: C, property_id: P1, kind: 'owner', end_date: null, start_date: '2026-01-01' }],
    property_ownerships: [{ tenure_id: TEN, contact_id: 'contact-1', is_primary: true, start_date: '2026-01-01' }],
    v_current_owner_balance: [{ tenure_id: TEN, balance_cents: balance }],
  });
}
const PMS = {
  pm_credit_visa: { id: 'pm_credit_visa', type: 'card', card: { brand: 'visa', funding: 'credit', last4: '4242' } },
  pm_debit_visa: { id: 'pm_debit_visa', type: 'card', card: { brand: 'visa', funding: 'debit', last4: '5556' } },
  pm_prepaid_mc: { id: 'pm_prepaid_mc', type: 'card', card: { brand: 'mastercard', funding: 'prepaid', last4: '5100' } },
  pm_unknown_card: { id: 'pm_unknown_card', type: 'card', card: { brand: 'visa', funding: 'unknown', last4: '0000' } },
  pm_bank_ach: { id: 'pm_bank_ach', type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } },
  pm_saved_other: { id: 'pm_saved_other', type: 'card', customer: 'cus_someone', card: { brand: 'visa', funding: 'debit', last4: '1111' } },
};
function fakeStripe({ outcome = 'succeeded', intents = {} } = {}) {
  const created = []; const cancelled = [];
  return {
    created, cancelled, intents,
    isConfigured: () => true,
    async retrievePaymentMethod(id) { return PMS[id] ? { ok: true, payment_method: PMS[id] } : { ok: false, error: 'No such PaymentMethod' }; },
    async retrievePaymentIntent(id) { return intents[id] ? { ok: true, payment_intent: intents[id] } : { ok: false, error: 'no such pi' }; },
    async cancelPaymentIntent(id) { cancelled.push(id); if (intents[id]) intents[id].status = 'canceled'; return { ok: true }; },
    async createAssessmentPaymentIntent(opts) {
      created.push(opts);
      const id = `pi_${created.length}`;
      if (outcome === 'declined') return { ok: false, declined: true, error: 'Your card was declined.', payment_intent_id: id };
      const status = outcome;
      intents[id] = { id, status, client_secret: `${id}_secret_x`, metadata: opts.metadata };
      return { ok: true, payment_intent: intents[id] };
    },
  };
}
const LIVE = 'sk_live_x', TEST = 'sk_test_x';
const deps = (sb, st, key = LIVE) => ({ supabase: sb, stripeLib: st, key });
const base = { propertyId: P1, initiatedBy: 'homeowner_portal' };

// ---------------------------------------------------------------- fee rules
const cfg = (o = {}) => ({ ...FEES, ...o });
t('card: processing fee = round(amount * card_fee_bps / 10000), same for credit, debit, prepaid, unknown', () => {
  for (const funding of ['credit', 'debit', 'prepaid', 'unknown']) {
    const f = FQ.computeFee({ assessmentCents: 25000, config: cfg(), methodKind: 'card', funding });
    assert.strictEqual(f.fee_cents, 875, funding); assert.strictEqual(f.fee_kind, 'card_fee');
    assert.match(f.fee_label, /3\.5%/); assert.match(f.disclosure, /3\.5% processing fee \(\$8\.75\)/);
  }
  assert.strictEqual(FQ.computeFee({ assessmentCents: 71900, config: cfg(), methodKind: 'card', funding: 'credit' }).fee_cents, 2517);
  assert.strictEqual(FQ.computeFee({ assessmentCents: 150000, config: cfg(), methodKind: 'card', funding: 'debit' }).fee_cents, 5250);
});
t('card: optional debit override applies to debit and prepaid only', () => {
  const c = cfg({ debit_card_fee_bps: 250 });
  assert.strictEqual(FQ.computeFee({ assessmentCents: 100000, config: c, methodKind: 'card', funding: 'debit' }).fee_cents, 2500);
  assert.strictEqual(FQ.computeFee({ assessmentCents: 100000, config: c, methodKind: 'card', funding: 'prepaid' }).fee_cents, 2500);
  assert.strictEqual(FQ.computeFee({ assessmentCents: 100000, config: c, methodKind: 'card', funding: 'credit' }).fee_cents, 3500);
  assert.strictEqual(FQ.computeFee({ assessmentCents: 100000, config: c, methodKind: 'card', funding: 'unknown' }).fee_cents, 3500);
  assert.strictEqual(FQ.classifyPaymentMethod({ id: 'pm_x', type: 'card', card: { funding: 'weird' } }).funding, 'unknown');
});
t('bank account (ACH): $2.95 up to and including $350, $5.95 above, on the payment amount', () => {
  const cases = [[2500, 295], [10000, 295], [35000, 295], [35001, 595], [71900, 595], [150000, 595]];
  for (const [amt, fee] of cases) {
    const f = FQ.computeFee({ assessmentCents: amt, config: cfg(), methodKind: 'us_bank_account' });
    assert.strictEqual(f.fee_cents, fee, `ACH fee on ${amt}`); assert.strictEqual(f.fee_kind, 'ach_fee');
  }
  assert.match(FQ.computeFee({ assessmentCents: 2500, config: cfg(), methodKind: 'us_bank_account' }).disclosure, /\$2\.95 processing fee/);
  assert.match(FQ.computeFee({ assessmentCents: 150000, config: cfg(), methodKind: 'us_bank_account' }).disclosure, /\$5\.95 processing fee/);
  assert.match(FQ.achScheduleText(cfg()), /\$2\.95 .* up to and including \$350\.00; \$5\.95 above \$350\.00/);
  // One flat fee when no tier is set; threshold and above must come together.
  assert.strictEqual(FQ.computeFee({ assessmentCents: 150000, config: { ...cfg(), ach_tier_threshold_cents: null, ach_fee_above_cents: null }, methodKind: 'us_bank_account' }).fee_cents, 295);
  assert.strictEqual(FQ.validateFeeConfig(cfg({ ach_fee_above_cents: null })).ok, false);
  assert.strictEqual(FQ.validateFeeConfig(cfg({ ach_tier_threshold_cents: 0 })).ok, false);
  assert.strictEqual(FQ.computeFee({ assessmentCents: 25000, config: cfg({ ach_fee_cents: 0 }), methodKind: 'us_bank_account' }).fee_cents, 0);
});
t('typo guard: card fee above 10% refused', () => {
  assert.strictEqual(FQ.validateFeeConfig(cfg({ card_fee_bps: 1001 })).ok, false);
  assert.strictEqual(FQ.validateFeeConfig(cfg({ card_fee_bps: 1000 })).ok, true);
  assert.strictEqual(FQ.validateFeeConfig(cfg({ debit_card_fee_bps: 5000 })).ok, false);
});
t('missing or malformed fee config refuses (never a default fee)', async () => {
  for (const bad of [undefined, null, {}, { card_fee_bps: 350 }, cfg({ debit_card_fee_bps: -1 }), cfg({ ach_fee_cents: 1.5 }),
    cfg({ card_fee_bps: '350' }), cfg({ card_fee_bps: null })]) {
    assert.strictEqual(FQ.validateFeeConfig(bad).ok, false, JSON.stringify(bad));
  }
  const sb = world({ fees: null }); const st = fakeStripe();
  const q = await AI.quoteAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa' });
  assert.strictEqual(q.error, 'payment_fees_not_configured'); assert.match(q.hint, /not available/);
  const s = await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: { STRIPE_PUBLISHABLE_KEY: 'pk_live_x' } });
  assert.strictEqual(s.error, 'payment_fees_not_configured');
  assert.strictEqual(sb._db.payments.length + st.created.length, 0);
});

// ---------------------------------------------------------------- setup + quote
t('setup: publishable key must exist and match the secret key mode', async () => {
  const sb = world(); const st = fakeStripe();
  assert.strictEqual((await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: {} })).error, 'publishable_key_not_configured');
  assert.strictEqual((await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: { STRIPE_PUBLISHABLE_KEY: 'pk_test_x' } })).error, 'publishable_key_mode_mismatch');
  const ok = await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: { STRIPE_PUBLISHABLE_KEY: 'pk_live_x' } });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.strictEqual(ok.elements.paymentMethodCreation, 'manual'); assert.strictEqual(ok.elements.onBehalfOf, 'acct_test_1');
  assert.strictEqual(ok.assessment_cents, 25000); assert.match(ok.fee_schedule.card, /3\.5% processing fee/); assert.match(ok.fee_schedule.ach, /\$2\.95 .*\$5\.95 above/);
  assert.ok(!('payment_fees' in ok) && !JSON.stringify(ok).includes('card_fee_bps'), 'raw fee config never sent to the browser');
});
t('quote: per funding type, server-computed, signed', async () => {
  const sb = world(); const st = fakeStripe();
  const exp = { pm_credit_visa: 875, pm_debit_visa: 875, pm_prepaid_mc: 875, pm_unknown_card: 875, pm_bank_ach: 295 };
  for (const [pm, fee] of Object.entries(exp)) {
    const q = await AI.quoteAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: pm });
    assert.ok(q.ok, `${pm}: ${JSON.stringify(q)}`);
    assert.strictEqual(q.fee_cents, fee, pm); assert.strictEqual(q.total_cents, 25000 + fee, pm);
    assert.ok(FQ.verifyQuote(q.quote_token).ok, pm);
  }
  assert.strictEqual((await AI.quoteAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_saved_other' })).error, 'payment_method_not_usable');
  assert.strictEqual((await AI.quoteAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'not-a-pm' })).error, 'payment_method_id_required');
  assert.strictEqual(sb._db.payments.length + st.created.length, 0, 'a quote writes nothing and charges nothing');
});
t('quote/confirm keep every existing gate (TEST key refuses a real lot; payments switched off refuses)', async () => {
  const st = fakeStripe();
  assert.strictEqual((await AI.quoteAssessmentPayment(deps(world(), st, TEST), { ...base, paymentMethodId: 'pm_credit_visa' })).error, 'test_mode_sandbox_only');
  const off = world(); off._db.communities[0].portal_module_config.homeowner_financials.payments = false;
  assert.strictEqual((await AI.quoteAssessmentPayment(deps(off, st), { ...base, paymentMethodId: 'pm_credit_visa' })).error, 'online_payments_not_enabled');
  const sand = world({ sandbox: true });
  const q = await AI.quoteAssessmentPayment(deps(sand, st, TEST), { ...base, initiatedBy: 'staff_test', paymentMethodId: 'pm_credit_visa', testAmountCents: 100 });
  assert.ok(q.ok && q.assessment_cents === 100 && q.fee_cents === 4, JSON.stringify(q));
});

// ---------------------------------------------------------------- confirm
async function quoted(sb, st, pm = 'pm_credit_visa') {
  const q = await AI.quoteAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: pm });
  assert.ok(q.ok, JSON.stringify(q));
  return q;
}
t('confirm: writes assessment + fee rows, then a destination-charge PI for the server total', async () => {
  const sb = world(); const st = fakeStripe();
  const q = await quoted(sb, st);
  const r = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: q.quote_token,
    total_cents: 1, fee_cents: 0, amountCents: 1 });   // client numbers must be ignored
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.status, 'succeeded');
  const rows = sb._db.payments;
  assert.strictEqual(rows.length, 2);
  const a = rows.find((x) => x.fee_type === 'assessment'); const f = rows.find((x) => x.fee_type === 'card_fee');
  assert.strictEqual(a.amount_cents, 25000); assert.strictEqual(a.payee, 'community_association'); assert.strictEqual(a.connected_account_id, 'acct_test_1');
  assert.strictEqual(f.amount_cents, 875); assert.strictEqual(f.payee, 'management_company');
  for (const x of rows) {
    assert.strictEqual(x.payment_group_id, r.group_id); assert.strictEqual(x.settlement_state, 'awaiting_payment');
    assert.strictEqual(x.tenure_id, TEN); assert.strictEqual(x.product_type, 'assessment_payment');
    assert.strictEqual(x.processor_payment_id, 'pi_1'); assert.strictEqual(x.processor_metadata.flow, 'payment_element');
    assert.strictEqual(x.payment_method_type, 'card'); assert.strictEqual(x.status, 'pending');
  }
  const pi = st.created[0];
  assert.strictEqual(pi.amountCents, 25875); assert.strictEqual(pi.applicationFeeCents, 875);
  assert.strictEqual(pi.connectedAccountId, 'acct_test_1'); assert.strictEqual(pi.methodKind, 'card');
  assert.strictEqual(pi.metadata.payment_group_id, r.group_id); assert.strictEqual(pi.metadata.product_type, 'assessment_payment');
  assert.strictEqual(pi.metadata.payment_flow, 'payment_element'); assert.strictEqual(pi.metadata.tenure_id, TEN);
  assert.strictEqual(pi.metadata.trusted_account_number, 'T-TEST-1'); assert.strictEqual(pi.metadata.initiated_by, 'homeowner_portal');
  assert.match(pi.description, /Processing fee \(3\.5% card\)/);
});
t('confirm: no fee row when the fee is zero', async () => {
  const sb = world({ fees: cfg({ card_fee_bps: 0 }) }); const st = fakeStripe();
  const q = await quoted(sb, st, 'pm_debit_visa');
  const r = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_debit_visa', quoteToken: q.quote_token });
  assert.ok(r.ok); assert.strictEqual(sb._db.payments.length, 1);
  assert.strictEqual(st.created[0].amountCents, 25000); assert.strictEqual(st.created[0].applicationFeeCents, 0);
});
t('confirm recomputes server-side: tampered token, swapped card, changed balance all refused before any charge', async () => {
  const sb = world(); const st = fakeStripe();
  const q = await quoted(sb, st);
  const [body, sig] = q.quote_token.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString()); forged.fee = 0; forged.tot = 25000;
  const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
  assert.strictEqual((await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: tampered })).error, 'quote_invalid');
  // A debit quote used to pay with a credit card (dodging the surcharge).
  const qd = await quoted(sb, st, 'pm_debit_visa');
  assert.strictEqual((await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: qd.quote_token })).error, 'quote_mismatch');
  // Balance moved after review: re-review with a fresh quote.
  sb._db.v_current_owner_balance[0].balance_cents = 30000;
  const ch = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: q.quote_token });
  assert.strictEqual(ch.error, 'quote_changed'); assert.strictEqual(ch.status, 409);
  assert.strictEqual(ch.quote.total_cents, 31050); assert.ok(ch.quote.quote_token);
  // Fee rule changed after review.
  sb._db.v_current_owner_balance[0].balance_cents = 25000;
  sb._db.communities[0].portal_module_config.payment_fees = cfg({ card_fee_bps: 300 });
  assert.strictEqual((await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: q.quote_token })).error, 'quote_changed');
  // Expired quote.
  const old = FQ.signQuote({ p: P1, pm: 'pm_credit_visa' }, { now: Date.now() - 3600 * 1000 });
  assert.strictEqual((await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: old })).error, 'quote_expired');
  assert.strictEqual(sb._db.payments.length + st.created.length, 0, 'nothing written, nothing charged');
});
t('confirm: requires_action returns the client secret for stripe.handleNextAction', async () => {
  const sb = world(); const st = fakeStripe({ outcome: 'requires_action' });
  const q = await quoted(sb, st);
  const r = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: q.quote_token });
  assert.ok(r.ok); assert.strictEqual(r.status, 'requires_action'); assert.strictEqual(r.client_secret, 'pi_1_secret_x');
  assert.ok(sb._db.payments.every((x) => x.settlement_state === 'awaiting_payment'), 'nothing settled');
});
t('confirm: a succeeded/processing card result carries no client secret', async () => {
  const sb = world(); const st = fakeStripe({ outcome: 'processing' });
  const q = await quoted(sb, st, 'pm_bank_ach');
  const r = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_bank_ach', quoteToken: q.quote_token, mandate: { ip: '1.2.3.4', userAgent: 'ua' } });
  assert.ok(r.ok); assert.strictEqual(r.status, 'processing'); assert.ok(!r.client_secret);
  assert.strictEqual(st.created[0].methodKind, 'us_bank_account'); assert.deepStrictEqual(st.created[0].mandate, { ip: '1.2.3.4', userAgent: 'ua' });
});
t('confirm: a decline cancels that PaymentIntent and fails its group (cannot be re-confirmed later)', async () => {
  const sb = world(); const st = fakeStripe({ outcome: 'declined' });
  const q = await quoted(sb, st);
  const r = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: q.quote_token });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 402); assert.strictEqual(r.error, 'payment_declined');
  assert.deepStrictEqual(st.cancelled, ['pi_1']);
  assert.ok(sb._db.payments.every((x) => x.settlement_state === 'failed' && x.status === 'failed'));
});
t('confirm: a payment already processing blocks a second one; an abandoned 3-D Secure attempt is cancelled', async () => {
  // Abandoned attempt first.
  const sb = world(); const st = fakeStripe({ outcome: 'requires_action' });
  const q1 = await quoted(sb, st);
  const r1 = await AI.confirmAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa', quoteToken: q1.quote_token });
  assert.strictEqual(r1.status, 'requires_action');
  const q2 = await quoted(sb, st, 'pm_debit_visa');
  const st2 = Object.assign(fakeStripe({ outcome: 'succeeded', intents: st.intents }), {});
  const r2 = await AI.confirmAssessmentPayment(deps(sb, st2), { ...base, paymentMethodId: 'pm_debit_visa', quoteToken: q2.quote_token });
  assert.ok(r2.ok, JSON.stringify(r2)); assert.deepStrictEqual(st2.cancelled, ['pi_1']);
  assert.ok(sb._db.payments.filter((x) => x.payment_group_id === r1.group_id).every((x) => x.settlement_state === 'failed'));
  // The succeeded attempt (webhook not in yet) blocks a third.
  const q3 = await quoted(sb, st2, 'pm_debit_visa');
  const r3 = await AI.confirmAssessmentPayment(deps(sb, st2), { ...base, paymentMethodId: 'pm_debit_visa', quoteToken: q3.quote_token });
  assert.strictEqual(r3.error, 'payment_in_progress');
  // A processing ACH (any flow, including Checkout) blocks too.
  const sb2 = world(); sb2._db.payments.push({ property_id: P1, product_type: 'assessment_payment', fee_type: 'assessment', settlement_state: 'processing', payment_group_id: 'g-old', processor_session_id: 'cs_1' });
  const st3 = fakeStripe(); const q4 = await quoted(sb2, st3, 'pm_bank_ach');
  assert.strictEqual((await AI.confirmAssessmentPayment(deps(sb2, st3), { ...base, paymentMethodId: 'pm_bank_ach', quoteToken: q4.quote_token })).error, 'payment_in_progress');
  assert.strictEqual(st3.created.length, 0);
});

// ---------------------------------------------------------------- webhook: PaymentIntent events
function fakeStore() {
  const events = new Map(); const credits = [];
  const pay = { id: 'pay-1', group: 'grp-1', state: 'awaiting_payment', posting: 'not_posted', needs_review: false };
  return {
    pay, credits,
    async claimEvent(e) { const c = events.get(e.id); if (!c) { events.set(e.id, { status: 'processing' }); return 'process'; } return c.status === 'processing' ? 'busy' : 'done'; },
    async finishEvent(id, status) { events.get(id).status = status; },
    async settle({ group }) {
      if (group !== pay.group) return { action: 'unknown' };
      if (pay.state === 'awaiting_payment' || pay.state === 'processing') { pay.state = 'settled'; return { action: 'post', payment_id: pay.id }; }
      if (pay.state === 'settled') return pay.posting === 'posted' ? { action: 'done' } : { action: 'post', payment_id: pay.id };
      pay.needs_review = true; return { action: 'review' };
    },
    async markProcessing({ group }) { if (group === pay.group && pay.state === 'awaiting_payment') { pay.state = 'processing'; return { action: 'processing' }; } return { action: 'done' }; },
    async markFailed({ group, terminal }) {
      if (group !== pay.group) return { action: 'unknown' };
      if (pay.state === 'awaiting_payment' || pay.state === 'processing') { pay.state = terminal; return { action: terminal }; }
      if (pay.state === 'settled') { pay.needs_review = true; return { action: 'settled_needs_review' }; }
      return { action: 'done' };
    },
    async postPayment(id) { if (pay.posting === 'posted') return { posting: 'already_posted' }; credits.push(id); pay.posting = 'posted'; return { posting: 'posted' }; },
    async legacyCheckoutCompleted() {}, async legacyPaymentFailed() {},
  };
}
const quiet = { error() {}, warn() {}, log() {} };
const ev = (id, type, obj) => ({ id, type, livemode: false, created: 1790000000, data: { object: obj } });
const directPi = (extra = {}) => ({ id: 'pi_d1', object: 'payment_intent', latest_charge: 'ch_1', payment_method_types: ['card'],
  metadata: { product_type: 'assessment_payment', payment_group_id: 'grp-1', payment_flow: 'payment_element' }, ...extra });
const checkoutPi = () => ({ id: 'pi_c1', object: 'payment_intent', metadata: { product_type: 'assessment_payment', payment_group_id: 'grp-1' } });
const run = (st, e) => processWebhookEvent(e, { store: st, mode: 'test', log: quiet });

t('payment_intent.succeeded (direct flow) settles + posts exactly once', async () => {
  const st = fakeStore();
  assert.strictEqual((await run(st, ev('evt_s1', 'payment_intent.succeeded', directPi()))).http, 200);
  await run(st, ev('evt_s1', 'payment_intent.succeeded', directPi()));        // duplicate delivery
  await run(st, ev('evt_s2', 'payment_intent.succeeded', directPi()));        // a second event for the same PI
  assert.strictEqual(st.credits.length, 1); assert.strictEqual(st.pay.state, 'settled'); assert.strictEqual(st.pay.posting, 'posted');
});
t('a Checkout-created PI never settles on payment_intent.* (no double settle)', async () => {
  const st = fakeStore();
  await run(st, ev('evt_c0', 'payment_intent.succeeded', checkoutPi()));       // arrives before the session event
  assert.strictEqual(st.pay.state, 'awaiting_payment', 'checkout PI event ignored');
  await run(st, ev('evt_c1', 'checkout.session.completed', { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_c1', metadata: checkoutPi().metadata }));
  await run(st, ev('evt_c2', 'payment_intent.succeeded', checkoutPi()));
  await run(st, ev('evt_c3', 'payment_intent.processing', checkoutPi()));
  assert.strictEqual(st.credits.length, 1); assert.strictEqual(st.pay.state, 'settled');
});
t('ACH (direct): processing, then succeeded -> credited once, only on succeeded', async () => {
  const st = fakeStore(); const pi = directPi({ payment_method_types: ['us_bank_account'] });
  await run(st, ev('evt_a1', 'payment_intent.processing', pi));
  assert.strictEqual(st.pay.state, 'processing'); assert.strictEqual(st.credits.length, 0);
  await run(st, ev('evt_a2', 'payment_intent.succeeded', pi));
  assert.strictEqual(st.pay.state, 'settled'); assert.strictEqual(st.credits.length, 1);
});
t('ACH (direct) failure after processing is terminal; nothing credited', async () => {
  const st = fakeStore(); const pi = directPi({ payment_method_types: ['us_bank_account'], last_payment_error: { message: 'insufficient funds', payment_method: { type: 'us_bank_account' } } });
  await run(st, ev('evt_f1', 'payment_intent.processing', pi));
  await run(st, ev('evt_f2', 'payment_intent.payment_failed', pi));
  assert.strictEqual(st.pay.state, 'failed'); assert.strictEqual(st.credits.length, 0);
});
t('card decline (direct) is only an attempt; cancel is terminal', async () => {
  const st = fakeStore();
  const r = await run(st, ev('evt_d1', 'payment_intent.payment_failed', directPi({ last_payment_error: { message: 'declined', payment_method: { type: 'card' } } })));
  assert.strictEqual(r.http, 200); assert.strictEqual(st.pay.state, 'awaiting_payment');
  await run(st, ev('evt_d2', 'payment_intent.canceled', directPi({ cancellation_reason: 'abandoned' })));
  assert.strictEqual(st.pay.state, 'failed');
  // A late success after cancellation goes to review, never credits silently.
  await run(st, ev('evt_d3', 'payment_intent.succeeded', directPi()));
  assert.strictEqual(st.credits.length, 0); assert.strictEqual(st.pay.needs_review, true);
});
t('non-assessment payment_intent.succeeded stays ignored', async () => {
  const st = fakeStore();
  await run(st, ev('evt_n1', 'payment_intent.succeeded', { id: 'pi_x', metadata: { product_type: 'amenity_rental', payment_flow: 'payment_element', payment_group_id: 'grp-1' } }));
  assert.strictEqual(st.pay.state, 'awaiting_payment');
});

// ---------------------------------------------------------------- config safety
t('payment_fees: tile edits cannot wipe or forge it; never presented to the browser', () => {
  const prev = { balance: { status: 'live' }, payment_fees: FEES, homeowner_financials: { verified_at: 'x', verified_by: 'y' } };
  const replaced = FA.carryFinancialStamp(prev, { balance: { status: 'live' }, calendar: { status: 'live' } });
  assert.deepStrictEqual(replaced.payment_fees, FEES, 'full replace keeps it');
  const forged = FA.carryFinancialStamp(prev, { ...prev, payment_fees: { card_fee_bps: 300, debit_card_fee_bps: null, ach_fee_cents: 999 } });
  assert.deepStrictEqual(forged.payment_fees, FEES, 'input cannot change it');
  assert.ok(!('payment_fees' in FA.carryFinancialStamp({}, { payment_fees: FEES })), 'input cannot create it');
  const shown = FA.presentedModuleConfig(prev, { balance: true });
  assert.ok(!('payment_fees' in shown) && !('homeowner_financials' in shown));
});

// ---------------------------------------------------------------- accounts at legal (Ed 2026-11-22)
const LH = require('../lib/payments/legal_hold');
t('legal hold: rule per enforcement state, counsel contact only from the record', () => {
  assert.strictEqual(LH.holdFromState(null), null);
  assert.strictEqual(LH.holdFromState({ state: 'current' }), null);
  assert.strictEqual(LH.holdFromState({ state: 'on_payment_plan' }), null, 'management-run plan is not at legal');
  for (const s of ['at_legal', 'in_collections', 'in_bankruptcy', 'lien_filed', 'judgment']) assert.ok(LH.holdFromState({ state: s }), s);
  const plan = LH.holdFromState({ state: 'on_payment_plan', attorney_firm: 'Firm PC' });
  assert.ok(plan && plan.held, 'counsel-run plan holds');
  const full = LH.holdFromState({ state: 'at_legal', attorney_firm: ' Firm PC ', attorney_phone: '281-555-0100', attorney_email: 'a@firm.test' });
  assert.deepStrictEqual(full.counsel, { firm: 'Firm PC', attorney: null, phone: '281-555-0100', email: 'a@firm.test' });
  assert.strictEqual(full.contact_complete, true);
  assert.strictEqual(full.message, 'Your account is currently being handled by legal counsel. Please contact the law firm listed below regarding your account balance and payment arrangements.');
  const thin = LH.holdFromState({ state: 'at_legal', attorney_firm: 'Firm PC' });
  assert.strictEqual(thin.contact_complete, false); assert.deepStrictEqual(thin.missing, ['phone', 'email']);
  const none = LH.holdFromState({ state: 'in_bankruptcy' });
  assert.strictEqual(none.contact_complete, false); assert.ok(none.missing.includes('law firm'));
  assert.ok(!/undefined|null/.test(LH.counselHtml(thin)), 'no blank fields rendered');
  assert.match(LH.counselHtml({ message: 'm', counsel: { firm: '<b>x</b>' } }), /&lt;b&gt;x&lt;\/b&gt;/);
});
t('legal hold: every payment path refuses on the server; clearing the state restores it', async () => {
  const sb = world(); const st = fakeStripe();
  sb._db.property_enforcement_states = [{ id: 'es1', property_id: P1, state: 'at_legal', attorney_firm: 'Firm PC', attorney_phone: '281-555-0100', ended_at: null }];
  const setup = await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: { STRIPE_PUBLISHABLE_KEY: 'pk_live_x' } });
  assert.strictEqual(setup.error, 'account_with_counsel'); assert.strictEqual(setup.status, 403);
  assert.strictEqual(setup.legal_hold.counsel.firm, 'Firm PC'); assert.strictEqual(setup.legal_hold.counsel.phone, '281-555-0100');
  const q = await AI.quoteAssessmentPayment(deps(sb, st), { ...base, paymentMethodId: 'pm_credit_visa' });
  assert.strictEqual(q.error, 'account_with_counsel');
  const terms = await AI.autopayEnrollmentTerms(deps(sb, st), { propertyId: P1 });
  assert.strictEqual(terms.error, 'account_with_counsel');
  const ap = await AI.autopayQuote(deps(sb, st), { property_id: P1, method_kind: 'card', stripe_payment_method_id: 'pm_x', stripe_customer_id: 'cus_x', tenure_id: TEN, connected_account_id: 'acct_test_1' });
  assert.strictEqual(ap.ok, false); assert.match(ap.detail, /legal counsel/); assert.ok(!ap.cancel, 'never cancels the enrollment');
  const core = require('../lib/payments/assessment_checkout');
  const co = await core.createAssessmentCheckout(deps(sb, st), { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'payment_link', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  assert.strictEqual(co.error, 'account_with_counsel');
  assert.strictEqual(st.created.length, 0, 'nothing created at Stripe');
  // Cleared (ended) -> normal access returns.
  sb._db.property_enforcement_states[0].ended_at = '2026-11-23T00:00:00Z';
  const again = await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: { STRIPE_PUBLISHABLE_KEY: 'pk_live_x' } });
  assert.strictEqual(again.ok, true, again.error);
});
t('legal hold: status lookup failure refuses payment (fail closed)', async () => {
  const sb = world(); const st = fakeStripe();
  const realFrom = sb.from;
  sb.from = (tbl) => (tbl === 'property_enforcement_states'
    ? { select() { return this; }, eq() { return this; }, is() { return this; }, limit() { return Promise.resolve({ data: null, error: { message: 'boom' } }); } }
    : realFrom(tbl));
  const r = await AI.setupAssessmentPayment(deps(sb, st), { ...base, env: { STRIPE_PUBLISHABLE_KEY: 'pk_live_x' } });
  assert.strictEqual(r.error, 'legal_status_unavailable'); assert.strictEqual(r.status, 503);
});

Promise.all(results).then(() => {
  if (failed) { console.log(`\n${failed} payment quote check(s) FAILED`); process.exit(1); }
  console.log('\nall payment quote checks passed');
});
