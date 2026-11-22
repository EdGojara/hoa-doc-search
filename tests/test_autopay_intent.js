// tests/test_autopay_intent.js — automatic payments on the one-time payment path (Ed 2026-11-21).
// Enrollment on the platform (on_behalf_of the association), the off-session
// destination charge in lib/payments/assessment_intent.js, the Reg E notice with
// fee + total, the AUTOPAY_CHARGES_ENABLED switch, idempotency per cycle, and the
// in-flight guard in both directions. Pure: fakes for Supabase and Stripe.
// Run: node tests/test_autopay_intent.js
'use strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
process.env.PORTAL_COOKIE_SECRET = 'test-secret-for-quote-tokens';
const assert = require('assert');
const path = require('path');
const AI = require('../lib/payments/assessment_intent');
const AP = require('../lib/payments/autopay');
const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');

let failed = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

// ---------------------------------------------------------------- fakes
function fakeSupabase(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  for (const k of ['payments', 'assessment_autopay', 'assessment_autopay_runs']) db[k] = db[k] || [];
  let seq = 0;
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let limitN = null; let single = null;
    const run = () => {
      const rows = db[table] || [];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      let out;
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `row${++seq}`, created_at: new Date().toISOString(), ...r }));
        db[table] = rows.concat(list); out = list;
      } else if (op === 'update') { match.forEach((r) => Object.assign(r, payload)); out = match; }
      else out = limitN != null ? match.slice(0, limitN) : match;
      if (single) return { data: out[0] || null, error: single === 'one' && !out[0] ? { message: 'no row' } : null };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; }, not() { return b; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
      lte(c, v) { filters.push((r) => r[c] != null && String(r[c]) <= String(v)); return b; },
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
  return { from: builder, _db: db };
}

const P1 = 'prop-1', C = 'comm-1', TEN = 'ten-1', ACCT = 'acct_test_1', AP1 = 'ap-1';
const FEES = { card_fee_bps: 350, debit_card_fee_bps: null, ach_fee_cents: 295, ach_tier_threshold_cents: 35000, ach_fee_above_cents: 595 };
const TODAY = '2026-12-15';
const NOTICED_AT = '2026-12-03T13:00:00Z';  // 12 days before
function world({ balance = 71900, fees = FEES, payments = true, autopay = null, extraPayments = [] } = {}) {
  const cfg = { balance: { status: 'live' }, homeowner_financials: { verified_at: '2026-11-01', verified_by: 'owner', payments } };
  if (fees) cfg.payment_fees = fees;
  return fakeSupabase({
    properties: [{ id: P1, community_id: C, street_address: '1 Test Ct', trusted_account_number: 'T-TEST-1', payment_sandbox: false }],
    communities: [{ id: C, name: 'Test Association', slug: 'test', hoa_legal_name: 'Test Association, Inc.',
      stripe_connected_account_id: ACCT, gl_cutover_date: '2026-08-01', is_demo: false, stripe_onboarding_status: 'enabled', portal_module_config: cfg }],
    ownership_tenures: [{ id: TEN, community_id: C, property_id: P1, kind: 'owner', end_date: null, start_date: '2026-01-01' }],
    property_ownerships: [{ tenure_id: TEN, contact_id: 'contact-1', is_primary: true, start_date: '2026-01-01' }],
    v_current_owner_balance: [{ tenure_id: TEN, balance_cents: balance }],
    assessment_autopay: autopay ? [autopay] : [],
    payments: extraPayments,
  });
}
// An active enrollment, noticed for `noticed` (assessment) with the fee today's rules give.
function enrollment({ kind = 'card', funding = 'credit', noticed = 71900, noticedFee, cap = null, over = {} } = {}) {
  const fee = noticedFee != null ? noticedFee
    : (kind === 'card' ? Math.round(noticed * 350 / 10000) : (noticed > 35000 ? 595 : 295));
  return { id: AP1, community_id: C, property_id: P1, tenure_id: TEN, portal_user_id: 'pu-1', payer_email: 'owner@example.com',
    stripe_customer_id: 'cus_platform_1', stripe_payment_method_id: kind === 'card' ? 'pm_saved_card' : 'pm_saved_bank',
    connected_account_id: ACCT, mandate_reference: kind === 'card' ? null : 'mandate_1', method_kind: kind,
    card_funding: kind === 'card' ? funding : null, amount_mode: 'full_balance', max_amount_cents: cap, frequency: 'monthly',
    status: 'active', next_charge_at: TODAY, next_notice_at: '2026-12-03', notice_sent_at: NOTICED_AT,
    noticed_amount_cents: noticed, noticed_fee_cents: fee, noticed_total_cents: noticed + fee, consecutive_failures: 0, ...over };
}
function fakeStripe({ outcome = 'succeeded', intents = {}, setup = null } = {}) {
  const created = []; const cancelled = []; const customers = []; const sessions = [];
  const byKey = new Map();
  return {
    created, cancelled, customers, sessions, intents,
    isConfigured: () => true,
    async createCustomer(o) { customers.push(o); return { ok: true, id: `cus_platform_${customers.length}` }; },
    async createSetupSession(o) { sessions.push(o); return { ok: true, id: `cs_setup_${sessions.length}`, url: 'https://checkout.stripe.test/setup' }; },
    async retrieveSetupSession() { return setup || { ok: false, error: 'no session' }; },
    async retrievePaymentIntent(id) { return intents[id] ? { ok: true, payment_intent: intents[id] } : { ok: false, error: 'no such pi' }; },
    async cancelPaymentIntent(id) { cancelled.push(id); if (intents[id]) intents[id].status = 'canceled'; return { ok: true }; },
    async createAssessmentPaymentIntent(opts) {
      // Stripe idempotency: the same key returns the same PaymentIntent.
      if (opts.idempotencyKey && byKey.has(opts.idempotencyKey)) return { ok: true, payment_intent: byKey.get(opts.idempotencyKey) };
      created.push(opts);
      const id = `pi_${created.length}`;
      if (outcome === 'declined') return { ok: false, declined: true, error: 'Your card was declined.', payment_intent_id: id };
      if (outcome === 'auth_required') return { ok: false, declined: true, stripeCode: 'authentication_required', error: 'This payment requires authentication.', payment_intent_id: id };
      intents[id] = { id, status: outcome, metadata: opts.metadata };
      if (opts.idempotencyKey) byKey.set(opts.idempotencyKey, intents[id]);
      return { ok: true, payment_intent: intents[id] };
    },
  };
}
const LIVE = 'sk_live_x';
const ON = { AUTOPAY_CHARGES_ENABLED: 'true' };
const OFF = {};
const deps = (sb, st) => ({ supabase: sb, stripeLib: st, key: LIVE, excludeDemo: async (q) => q });
const quiet = { warn() {}, error() {}, log() {} };
const runs = (sb) => sb._db.assessment_autopay_runs.map((r) => r.outcome);

// ---------------------------------------------------------------- the switch
t('switch OFF (default): no enrollment, no notice, nothing charged', async () => {
  assert.strictEqual(AI.autopayChargesEnabled({}), false);
  assert.strictEqual(AI.autopayChargesEnabled({ AUTOPAY_CHARGES_ENABLED: '1' }), false, 'only the word true turns it on');
  assert.strictEqual(AI.autopayChargesEnabled(ON), true);
  const sb = world({ autopay: enrollment() }); const st = fakeStripe();
  const c = await AP.chargeDue({ today: TODAY, log: quiet, env: OFF }, deps(sb, st));
  assert.strictEqual(c.disabled, true);
  const n = await AP.sendDueNotices({ today: TODAY, log: quiet, env: OFF, sendEmail: async () => { throw new Error('must not send'); } }, deps(sb, st));
  assert.strictEqual(n.disabled, true);
  const b = await AP.beginEnrollment({ propertyId: P1, env: OFF }, deps(sb, st));
  assert.strictEqual(b.error, 'autopay_unavailable');
  const q = await AI.autopayQuote(deps(sb, st), enrollment());
  const direct = await AI.chargeAutopayAssessment(deps(sb, st), { autopay: enrollment(), pr: q.pr, quote: q.quote, env: OFF });
  assert.strictEqual(direct.outcome, 'disabled');
  assert.strictEqual(st.created.length, 0); assert.strictEqual(sb._db.payments.length, 0);
});

// ---------------------------------------------------------------- enrollment
t('enrollment: platform customer, setup session on_behalf_of the association, disclosure accepted first', async () => {
  const sb = world({ balance: 0 }); const st = fakeStripe();
  const terms = (await AI.autopayEnrollmentTerms(deps(sb, st), { propertyId: P1 })).terms;
  assert.ok(terms.disclosure.some((l) => /calculated on that payment's actual amount at the time of the charge/.test(l)));
  assert.ok(terms.disclosure.some((l) => /3\.5% processing fee on card payments/.test(l) && /\$2\.95 .* up to \$350\.00; \$5\.95 above/.test(l)));
  assert.ok(terms.disclosure.some((l) => /info@bedrocktx\.com, at least 3 business days before the scheduled payment date/.test(l)));
  assert.ok(terms.disclosure.some((l) => /10 days before each payment/.test(l) && /total that will be debited/.test(l)));
  assert.ok(!terms.disclosure.join(' ').includes('—'), 'no em dashes in homeowner text');
  const opts = { propertyId: P1, payer: { name: 'Owner', email: 'owner@example.com' }, successUrl: 'https://x/portal?autopay=1&session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/portal/autopay', env: ON };
  const stale = await AP.beginEnrollment({ ...opts, acceptedTermsVersion: 'not-what-they-saw' }, deps(sb, st));
  assert.strictEqual(stale.status, 409); assert.strictEqual(stale.error, 'terms_changed'); assert.strictEqual(st.customers.length, 0);
  const r = await AP.beginEnrollment({ ...opts, acceptedTermsVersion: terms.version, maxAmountCents: 100000 }, deps(sb, st));
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(st.customers[0].connectedAccountId, undefined, 'customer on the platform, never the connected account');
  assert.strictEqual(st.sessions[0].onBehalfOf, ACCT);
  assert.deepStrictEqual(st.sessions[0].paymentMethodTypes, ['card', 'us_bank_account']);
  assert.strictEqual(st.sessions[0].connectedAccountId, undefined);
  const row = sb._db.assessment_autopay[0];
  assert.strictEqual(row.status, 'pending_setup'); assert.strictEqual(row.stripe_customer_id, 'cus_platform_1');
  assert.strictEqual(row.connected_account_id, ACCT); assert.strictEqual(row.setup_session_id, 'cs_setup_1');
  assert.strictEqual(row.authorized_terms_version, terms.version); assert.ok(/at the time of the charge/.test(row.authorized_terms));
  assert.strictEqual(row.tenure_id, TEN); assert.strictEqual(row.max_amount_cents, 100000);
});
t('enrollment refused when the association has payments switched off', async () => {
  const sb = world({ payments: false }); const st = fakeStripe();
  const r = await AP.beginEnrollment({ propertyId: P1, acceptedTermsVersion: 'x', successUrl: 'a', cancelUrl: 'b', env: ON }, deps(sb, st));
  assert.strictEqual(r.error, 'online_payments_not_enabled'); assert.strictEqual(st.customers.length, 0);
});
t('complete: records method kind and card funding from the saved PaymentMethod; wrong on_behalf_of refused', async () => {
  const pending = { id: AP1, property_id: P1, status: 'pending_setup', stripe_customer_id: 'cus_platform_1', connected_account_id: ACCT, setup_session_id: 'cs_setup_1' };
  const pm = { id: 'pm_saved_card', type: 'card', card: { brand: 'visa', funding: 'debit', last4: '5556' } };
  const good = { ok: true, session: { id: 'cs_setup_1', customer: 'cus_platform_1' }, setup_intent: { id: 'seti_1', status: 'succeeded', on_behalf_of: ACCT, mandate: null }, payment_method: pm };
  let sb = world({ autopay: pending });
  const bad = await AP.completeEnrollment({ autopayId: AP1, sessionId: 'cs_setup_1' }, deps(sb, fakeStripe({ setup: { ...good, setup_intent: { ...good.setup_intent, on_behalf_of: 'acct_other' } } })));
  assert.strictEqual(bad.error, 'setup_not_on_behalf_of_association');
  assert.strictEqual((await AP.completeEnrollment({ autopayId: AP1, sessionId: 'cs_other' }, deps(sb, fakeStripe({ setup: good })))).error, 'session_mismatch');
  const r = await AP.completeEnrollment({ autopayId: AP1, sessionId: 'cs_setup_1' }, deps(sb, fakeStripe({ setup: good })));
  assert.ok(r.ok, JSON.stringify(r));
  const row = sb._db.assessment_autopay[0];
  assert.strictEqual(row.status, 'active'); assert.strictEqual(row.method_kind, 'card'); assert.strictEqual(row.card_funding, 'debit');
  assert.strictEqual(row.stripe_payment_method_id, 'pm_saved_card'); assert.ok(row.next_notice_at < row.next_charge_at);
  // Bank account: kind + mandate, no funding.
  sb = world({ autopay: { ...pending } });
  const bank = { ...good, setup_intent: { ...good.setup_intent, mandate: 'mandate_1' }, payment_method: { id: 'pm_saved_bank', type: 'us_bank_account', us_bank_account: { bank_name: 'TEST BANK', last4: '6789' } } };
  assert.ok((await AP.completeEnrollment({ autopayId: AP1, sessionId: 'cs_setup_1' }, deps(sb, fakeStripe({ setup: bank })))).ok);
  assert.strictEqual(sb._db.assessment_autopay[0].method_kind, 'us_bank_account'); assert.strictEqual(sb._db.assessment_autopay[0].card_funding, null);
  assert.strictEqual(sb._db.assessment_autopay[0].mandate_reference, 'mandate_1');
});

// ---------------------------------------------------------------- the charge
async function chargeOnce({ kind, funding, balance }) {
  const sb = world({ balance, autopay: enrollment({ kind, funding, noticed: balance }) }); const st = fakeStripe({ outcome: kind === 'card' ? 'succeeded' : 'processing' });
  const r = await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  return { sb, st, r };
}
t('charge: card 3.5% on 71900 = 2517; destination PI, application fee = fee, off-session, autopay metadata', async () => {
  const { sb, st, r } = await chargeOnce({ kind: 'card', funding: 'credit', balance: 71900 });
  assert.strictEqual(r.charged, 1, JSON.stringify(runs(sb)));
  const pi = st.created[0];
  assert.strictEqual(pi.amountCents, 74417); assert.strictEqual(pi.applicationFeeCents, 2517);
  assert.strictEqual(pi.connectedAccountId, ACCT); assert.strictEqual(pi.offSession, true);
  assert.strictEqual(pi.customerId, 'cus_platform_1'); assert.strictEqual(pi.paymentMethodId, 'pm_saved_card'); assert.strictEqual(pi.methodKind, 'card');
  const cycle = `autopay-${AP1}-${TODAY}`;
  assert.strictEqual(pi.idempotencyKey, cycle);
  const m = pi.metadata;
  assert.strictEqual(m.payment_flow, 'autopay'); assert.strictEqual(m.initiated_by, 'autopay'); assert.strictEqual(m.autopay_id, AP1);
  assert.strictEqual(m.tenure_id, TEN); assert.strictEqual(m.payment_group_id, AI.groupIdForCycle(cycle)); assert.strictEqual(m.fee_cents, '2517');
  // Same payments rows as a one-time payment.
  const rows = sb._db.payments;
  assert.strictEqual(rows.length, 2);
  const a = rows.find((x) => x.fee_type === 'assessment'), f = rows.find((x) => x.fee_type === 'card_fee');
  assert.strictEqual(a.payee, 'community_association'); assert.strictEqual(a.amount_cents, 71900); assert.strictEqual(a.connected_account_id, ACCT);
  assert.strictEqual(f.payee, 'management_company'); assert.strictEqual(f.amount_cents, 2517);
  assert.ok(rows.every((x) => x.payment_group_id === m.payment_group_id && x.initiated_by === 'autopay' && x.processor_metadata.flow === 'autopay' && x.processor_payment_id === 'pi_1'));
  assert.ok(rows.every((x) => x.posting_state === 'not_posted'), 'the job never posts; the webhook does');
  assert.deepStrictEqual(runs(sb), ['charged']);
  const ap = sb._db.assessment_autopay[0];
  assert.strictEqual(ap.last_charge_amount_cents, 74417); assert.ok(ap.next_charge_at > TODAY, 'advanced to the next cycle');
});
t('charge: ACH 35000 -> $2.95, 35001 -> $5.95, saved mandate used', async () => {
  let { st } = await chargeOnce({ kind: 'us_bank_account', balance: 35000 });
  assert.strictEqual(st.created[0].applicationFeeCents, 295); assert.strictEqual(st.created[0].amountCents, 35295);
  assert.strictEqual(st.created[0].mandateId, 'mandate_1'); assert.strictEqual(st.created[0].methodKind, 'us_bank_account');
  ({ st } = await chargeOnce({ kind: 'us_bank_account', balance: 35001 }));
  assert.strictEqual(st.created[0].applicationFeeCents, 595); assert.strictEqual(st.created[0].amountCents, 35596);
});
t('the webhook settles and posts an autopay PaymentIntent like a one-time one', async () => {
  const pay = { id: 'pay-1', group: 'grp-a', state: 'awaiting_payment', posting: 'not_posted' }; const credits = []; const events = new Map();
  const store = {
    async claimEvent(e) { if (events.has(e.id)) return 'done'; events.set(e.id, 1); return 'process'; }, async finishEvent() {},
    async settle({ group }) { if (group !== pay.group) return { action: 'unknown' }; if (pay.state !== 'settled') { pay.state = 'settled'; return { action: 'post', payment_id: pay.id }; } return { action: 'done' }; },
    async markProcessing() { return { action: 'processing' }; }, async markFailed() { return { action: 'failed' }; },
    async postPayment(id) { credits.push(id); pay.posting = 'posted'; return { posting: 'posted' }; },
    async legacyCheckoutCompleted() {}, async legacyPaymentFailed() {},
  };
  const pi = { id: 'pi_auto', latest_charge: 'ch_1', payment_method_types: ['card'], metadata: { product_type: 'assessment_payment', payment_group_id: 'grp-a', payment_flow: 'autopay' } };
  await processWebhookEvent({ id: 'evt_1', type: 'payment_intent.succeeded', livemode: false, created: 1790000000, data: { object: pi } }, { store, mode: 'test', log: quiet });
  assert.strictEqual(pay.state, 'settled'); assert.deepStrictEqual(credits, ['pay-1']);
});
t('payments switched off: refused and logged, nothing charged', async () => {
  const sb = world({ payments: false, autopay: enrollment() }); const st = fakeStripe();
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  assert.strictEqual(st.created.length, 0); assert.strictEqual(sb._db.payments.length, 0);
  assert.deepStrictEqual(runs(sb), ['skipped_not_payable']);
});
t('idempotency: one key per cycle; a re-run of the same cycle never charges twice', async () => {
  assert.strictEqual(AI.autopayCycleKey(enrollment()), `autopay-${AP1}-${TODAY}`);
  assert.strictEqual(AI.autopayCycleKey(enrollment()), AI.autopayCycleKey({ ...enrollment(), noticed_amount_cents: 1 }), 'stable within a cycle');
  assert.notStrictEqual(AI.autopayCycleKey(enrollment()), AI.autopayCycleKey(enrollment({ over: { next_charge_at: '2027-01-14' } })));
  assert.match(AI.groupIdForCycle('autopay-x-2026-12-15'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const sb = world({ autopay: enrollment() }); const st = fakeStripe(); const d = deps(sb, st);
  const q = await AI.autopayQuote(d, enrollment());
  const a = await AI.chargeAutopayAssessment(d, { autopay: enrollment(), pr: q.pr, quote: q.quote, env: ON });
  const b = await AI.chargeAutopayAssessment(d, { autopay: enrollment(), pr: q.pr, quote: q.quote, env: ON });
  assert.ok(a.ok && b.ok); assert.strictEqual(b.replayed, true); assert.strictEqual(b.payment_intent_id, a.payment_intent_id);
  assert.strictEqual(st.created.length, 1); assert.strictEqual(sb._db.payments.length, 2);
  // Crash between the rows and the PaymentIntent: the retry reuses the rows and the key.
  const sb2 = world({ autopay: enrollment() }); const st2 = fakeStripe(); const d2 = deps(sb2, st2);
  const q2 = await AI.autopayQuote(d2, enrollment());
  sb2._db.payments.push(...[{ fee_type: 'assessment', amount_cents: 71900 }, { fee_type: 'card_fee', amount_cents: 2517 }].map((x) => ({
    ...x, payment_group_id: AI.groupIdForCycle(AI.autopayCycleKey(enrollment())), property_id: P1, product_type: 'assessment_payment',
    settlement_state: 'awaiting_payment', processor_metadata: { flow: 'autopay' }, created_at: new Date().toISOString() })));
  const c = await AI.chargeAutopayAssessment(d2, { autopay: enrollment(), pr: q2.pr, quote: q2.quote, env: ON });
  assert.ok(c.ok, JSON.stringify(c)); assert.strictEqual(sb2._db.payments.length, 2, 'no second set of rows');
});
t('card authentication_required / decline: run failed with the reason, PI cancelled, three strikes kept', async () => {
  const sb = world({ autopay: enrollment() }); const st = fakeStripe({ outcome: 'auth_required' });
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  const run = sb._db.assessment_autopay_runs[0];
  assert.strictEqual(run.outcome, 'failed'); assert.match(run.detail, /authentication_required/);
  assert.deepStrictEqual(st.cancelled, ['pi_1']);
  assert.ok(sb._db.payments.every((x) => x.settlement_state === 'failed'));
  const ap = sb._db.assessment_autopay[0];
  assert.strictEqual(ap.consecutive_failures, 1); assert.strictEqual(ap.status, 'active'); assert.strictEqual(ap.next_charge_at, '2026-12-18');
  const sb3 = world({ autopay: enrollment({ over: { consecutive_failures: 2 } }) });
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb3, fakeStripe({ outcome: 'declined' })));
  assert.strictEqual(sb3._db.assessment_autopay[0].status, 'failed'); assert.strictEqual(sb3._db.assessment_autopay[0].next_charge_at, null);
});

// ---------------------------------------------------------------- Reg E notice
t('notice names the assessment, the fee for the saved method and the total; records all three', async () => {
  const sb = world({ balance: 35001, autopay: enrollment({ kind: 'us_bank_account', over: { notice_sent_at: null, noticed_amount_cents: null, noticed_fee_cents: null, next_notice_at: TODAY } }) });
  const sent = [];
  const r = await AP.sendDueNotices({ today: TODAY, log: quiet, env: ON, sendEmail: async (o) => sent.push(o) }, deps(sb, fakeStripe()));
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(sent[0].amountCents, 35001); assert.strictEqual(sent[0].feeCents, 595); assert.strictEqual(sent[0].totalCents, 35596);
  assert.match(sent[0].subject, /\$355\.96/);
  const ap = sb._db.assessment_autopay[0];
  assert.strictEqual(ap.noticed_amount_cents, 35001); assert.strictEqual(ap.noticed_fee_cents, 595); assert.strictEqual(ap.noticed_total_cents, 35596);
  // The email body itself.
  const emailPath = require.resolve('../lib/notifications/email');
  let mail = null;
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: { sendEmail: async (o) => { mail = o; return { ok: true }; } } };
  const { sendNotice } = require('../lib/payments/autopay_jobs');
  await sendNotice({ to: 'owner@example.com', subject: 's', autopay: { ...ap, method_label: 'TEST BANK', method_last4: '6789' }, amountCents: 35001, feeCents: 595, totalCents: 35596, feeLabel: 'Processing fee (bank account)', associationName: 'Test Association, Inc.' });
  assert.match(mail.text, /Assessment:\s+\$350\.01/); assert.match(mail.text, /Processing fee:\s+\$5\.95/); assert.match(mail.text, /Total debited:\s+\$355\.96/);
  assert.match(mail.text, /Date:\s+Tuesday, December 15, 2026/); assert.match(mail.text, /info@bedrocktx\.com/);
  await assert.rejects(sendNotice({ to: 'x@example.com', subject: 's', autopay: ap, amountCents: 100, feeCents: 5, totalCents: 104, associationName: 'A' }), /total does not equal/);
});
t('fee rules changed since the notice: re-noticed, not charged', async () => {
  const sb = world({ fees: { ...FEES, card_fee_bps: 300 }, autopay: enrollment() }); const st = fakeStripe();
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  assert.strictEqual(st.created.length, 0); assert.deepStrictEqual(runs(sb), ['skipped_fee_changed']);
  const ap = sb._db.assessment_autopay[0];
  assert.strictEqual(ap.notice_sent_at, null); assert.strictEqual(ap.noticed_fee_cents, null); assert.strictEqual(ap.next_notice_at, TODAY);
});
t('noticed amount comparison stays on the assessment; a changed balance re-notices', async () => {
  const sb = world({ balance: 80000, autopay: enrollment({ noticed: 71900 }) }); const st = fakeStripe();
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  assert.strictEqual(st.created.length, 0); assert.deepStrictEqual(runs(sb), ['skipped_no_notice']);
});
t('cap applies to the total debited and stops, never clamps', async () => {
  const sb = world({ autopay: enrollment({ cap: 72000 }) }); const st = fakeStripe();   // 71900 + 2517 = 74417 > 72000
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  assert.strictEqual(st.created.length, 0); assert.deepStrictEqual(runs(sb), ['skipped_over_cap']);
  assert.strictEqual(sb._db.assessment_autopay[0].status, 'paused');
});
t('owner changed (tenure) or association account changed: refused, never charged', async () => {
  let sb = world({ autopay: enrollment({ over: { tenure_id: 'ten-old' } }) }); let st = fakeStripe();
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  assert.strictEqual(st.created.length, 0); assert.strictEqual(sb._db.assessment_autopay[0].status, 'cancelled');
  sb = world({ autopay: enrollment({ over: { connected_account_id: 'acct_old' } }) }); st = fakeStripe();
  await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
  assert.strictEqual(st.created.length, 0); assert.deepStrictEqual(runs(sb), ['skipped_not_payable']);
});

// ---------------------------------------------------------------- in-flight, both directions
const oneTime = (state, pi, extra = {}) => ({ property_id: P1, product_type: 'assessment_payment', fee_type: 'assessment', settlement_state: state,
  payment_group_id: `g-${state}-${pi || 'x'}`, processor_payment_id: pi || null, processor_metadata: { flow: 'payment_element' }, created_at: new Date().toISOString(), ...extra });
t('autopay refuses while a one-time payment is processing, paid-not-settled, or mid 3-D Secure (and does not cancel it)', async () => {
  for (const [row, intents] of [
    [oneTime('processing', 'pi_ot'), {}],
    [oneTime('awaiting_payment', 'pi_ot'), { pi_ot: { id: 'pi_ot', status: 'succeeded' } }],
    [oneTime('awaiting_payment', 'pi_ot'), { pi_ot: { id: 'pi_ot', status: 'requires_action' } }],
    [oneTime('awaiting_payment', null, { processor_metadata: {}, processor_session_id: 'cs_open' }), {}],
  ]) {
    const sb = world({ autopay: enrollment(), extraPayments: [row] }); const st = fakeStripe({ intents });
    await AP.chargeDue({ today: TODAY, log: quiet, env: ON }, deps(sb, st));
    assert.strictEqual(st.created.length, 0, JSON.stringify(row));
    assert.deepStrictEqual(runs(sb), ['skipped_in_flight']);
    assert.deepStrictEqual(st.cancelled, [], 'never cancels the homeowner\'s own attempt');
    assert.strictEqual(sb._db.assessment_autopay[0].consecutive_failures, 0, 'not a failure strike');
  }
});
t('a one-time payment refuses while an autopay charge is processing or paid-not-settled', async () => {
  const auto = (state, pi) => oneTime(state, pi, { processor_metadata: { flow: 'autopay' }, payment_group_id: 'g-auto' });
  let sb = world({ extraPayments: [auto('processing', 'pi_auto')] });
  let r = await AI.clearInFlight(deps(sb, fakeStripe()), P1);
  assert.strictEqual(r.error, 'payment_in_progress'); assert.match(r.hint, /automatic payment/);
  sb = world({ extraPayments: [auto('awaiting_payment', 'pi_auto')] });
  const st = fakeStripe({ intents: { pi_auto: { id: 'pi_auto', status: 'succeeded' } } });
  r = await AI.clearInFlight(deps(sb, st), P1);
  assert.strictEqual(r.error, 'payment_in_progress'); assert.deepStrictEqual(st.cancelled, []);
  // An abandoned one-time attempt is still cleared for a new one-time payment (unchanged behaviour).
  sb = world({ extraPayments: [oneTime('awaiting_payment', 'pi_old')] });
  const st2 = fakeStripe({ intents: { pi_old: { id: 'pi_old', status: 'requires_payment_method' } } });
  assert.ok((await AI.clearInFlight(deps(sb, st2), P1)).ok); assert.deepStrictEqual(st2.cancelled, ['pi_old']);
});

// ---------------------------------------------------------------- stripe.js wire shape
t('stripe.js: setup session and off-session PI go to the platform with on_behalf_of / transfer_data', async () => {
  const S = require('../lib/payments/stripe');
  const calls = [];
  const realFetch = global.fetch; const realKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  global.fetch = async (url, init) => { calls.push({ url, headers: init.headers, body: decodeURIComponent(init.body || '') }); return { ok: true, json: async () => ({ id: 'x_1', url: 'u', status: 'succeeded' }) }; };
  try {
    await S.createCustomer({ email: 'o@example.com' });
    await S.createSetupSession({ customerId: 'cus_1', onBehalfOf: ACCT, successUrl: 's', cancelUrl: 'c' });
    assert.strictEqual((await S.createSetupSession({ customerId: 'cus_1', successUrl: 's', cancelUrl: 'c' })).ok, false, 'on_behalf_of required');
    const g = require('../lib/demo/outbound_guard');
    const realGuard = g.guardOutbound; g.guardOutbound = async () => ({ blocked: false });
    try {
      await S.createAssessmentPaymentIntent({ amountCents: 74417, applicationFeeCents: 2517, connectedAccountId: ACCT, paymentMethodId: 'pm_1',
        methodKind: 'card', offSession: true, customerId: 'cus_1', idempotencyKey: 'autopay-a-2026-12-15', metadata: { payment_flow: 'autopay' } });
    } finally { g.guardOutbound = realGuard; }
  } finally { global.fetch = realFetch; process.env.STRIPE_SECRET_KEY = realKey; }
  assert.ok(calls.every((c) => !c.headers['Stripe-Account']), 'never on the connected account');
  assert.match(calls[1].body, /setup_intent_data\[on_behalf_of\]=acct_test_1/);
  assert.match(calls[1].body, /payment_method_types\[0\]=card&payment_method_types\[1\]=us_bank_account/);
  const pi = calls[calls.length - 1];
  assert.match(pi.url, /\/payment_intents$/);
  for (const p of ['customer=cus_1', 'off_session=true', 'confirm=true', `on_behalf_of=${ACCT}`, `transfer_data[destination]=${ACCT}`, 'application_fee_amount=2517', 'amount=74417', 'metadata[payment_flow]=autopay']) {
    assert.ok(pi.body.includes(p), `PI body has ${p}`);
  }
  assert.ok(!pi.body.includes('mandate_data'), 'off-session uses the saved mandate, not a fresh one');
  assert.strictEqual(pi.headers['Idempotency-Key'], 'autopay-a-2026-12-15');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.stack || e.message); }
  }
  if (failed) { console.log(`\n${failed} autopay intent check(s) FAILED`); process.exit(1); }
  console.log('\nall autopay intent checks passed');
})();
