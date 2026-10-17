// tests/test_payment_hardening.js — Stripe assessment pipeline hardening (Ed 2026-10-16, migration 534).
// Offline: Stripe, Supabase, the GL poster and the email sender are all stubs.
//   1. readiness: checkout refuses unless the community can take money now
//   2. one in flight: a second Pay click never opens a second checkout
//   3. idempotency keys on Stripe writes
//   4. payouts relieve Stripe clearing into operating cash, exactly once
//   5. a duplicate webhook is a no-op; unknown / mismatched events are recorded and ignored
//   6. a lost dispute reverses the transfer (switch on) or tells staff exactly how (off)
//   7. receipts are recorded on settle and emailed only when switched on
// Run: node tests/test_payment_hardening.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'offline-test';
const assert = require('assert');

// ---------------------------------------------------------------- GL poster stub
let currentDb = null;
let postFail = null; // { code, message } to throw once
require.cache[require.resolve('../lib/accounting/posting')] = { id: 'posting-stub', loaded: true, exports: {
  async postJournalEntry(e) {
    if (postFail) { const f = postFail; postFail = null; throw Object.assign(new Error(f.message), { code: f.code }); }
    const db = currentDb;
    if (db.journal_entries.some((j) => j.community_id === e.community_id && j.source_reference === e.source_reference)) {
      throw Object.assign(new Error('duplicate key value violates unique constraint "uq_journal_entries_stripe_ref"'), { code: '23505' });
    }
    const entry = { id: `je-${db.journal_entries.length + 1}`, status: 'posted', ...e };
    db.journal_entries.push(entry);
    return { entry };
  },
} };

const { paymentsReadyFor, portalPaymentState } = require('../lib/payments/payment_readiness');
const { createAssessmentCheckout } = require('../lib/payments/assessment_checkout');
const { processWebhookEvent, handleStripeEvent } = require('../lib/payments/payment_lifecycle');
const { createPaymentStore } = require('../lib/payments/payment_store');
const { buildPaymentReceipt, receiptSendDecision } = require('../lib/payments/payment_receipt');
const { reconcileAccountMonth } = require('../lib/banking/monthly_rec');
const { PAYMENT_POLICY } = require('../lib/payments/payment_policy');

let failed = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const quiet = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------- fake supabase
const UNIQUE = { payment_receipts: ['payment_id'], stripe_payouts: ['payout_id'] };
function fakeSupabase(tables, { inFlightUnique = true } = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  for (const k of ['payments', 'journal_entries', 'stripe_payouts', 'payment_receipts', 'community_account_roles', 'chart_of_accounts', 'rpc_calls']) db[k] = db[k] || [];
  let seq = 0;
  const inFlight = (r) => r.product_type === 'assessment_payment' && r.fee_type === 'assessment' && r.payment_group_id && ['awaiting_payment', 'processing'].includes(r.settlement_state);
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let limitN = null; let single = null;
    const run = () => {
      const rows = db[table] || (db[table] = []);
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || `row${++seq}`, ...r }));
        for (const r of list) {
          for (const col of UNIQUE[table] || []) if (rows.some((x) => x[col] === r[col])) return { data: null, error: { code: '23505', message: `duplicate ${table}.${col}` } };
          if (table === 'payments' && inFlightUnique && inFlight(r)
            && rows.some((x) => inFlight(x) && x.property_id === r.property_id && x.tenure_id === r.tenure_id)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_payments_assessment_in_flight"' } };
          }
        }
        db[table] = rows.concat(list);
        return { data: single ? list[0] : list, error: null };
      }
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { match.forEach((r) => Object.assign(r, payload)); return { data: single ? match[0] || null : match, error: null }; }
      const out = limitN != null ? match.slice(0, limitN) : match;
      if (single === 'maybe') return { data: out[0] || null, error: null };
      if (single === 'one') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not single' } };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
      is(c, v) { filters.push((r) => (r[c] == null) === (v == null)); return b; },
      in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      not(c) { filters.push((r) => r[c] != null); return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { single = 'maybe'; return b; },
      single() { single = 'one'; return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(patch) { op = 'update'; payload = patch; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  async function rpc(fn, args) {
    db.rpc_calls.push({ fn, args });
    if (fn === 'payment_mark_failed') {
      const grp = db.payments.filter((p) => p.payment_group_id === args.p_group);
      grp.forEach((p) => { if (['awaiting_payment', 'processing'].includes(p.settlement_state)) Object.assign(p, { settlement_state: args.p_terminal, status: 'cancelled' }); });
      return { data: { action: args.p_terminal }, error: null };
    }
    if (fn === 'payment_flag_review') {
      const p = db.payments.find((x) => x.id === args.p_payment_id);
      if (p) Object.assign(p, { needs_review: true, review_reason: [p.review_reason, args.p_reason].filter(Boolean).join(' | ') });
      return { data: null, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  }
  const client = { from: builder, rpc, _db: db };
  currentDb = db;
  return client;
}

// ---------------------------------------------------------------- fixtures
const C = 'comm-qr', P1 = 'prop-1', TEN = 'ten-1', ACCT = 'acct_qr';
const LIVE_KEY = 'sk_live_x', TEST_KEY = 'sk_test_x';
const urls = { successUrl: 'https://app/portal?paid=1', cancelUrl: 'https://app/portal' };
const readyCommunity = (over = {}) => ({ id: C, name: 'Quail Ridge', slug: 'quail-ridge', hoa_legal_name: 'Quail Ridge HOA, Inc.', is_demo: false,
  management_status: 'active', financials_active: true, gl_cutover_date: '2026-08-01', stripe_connected_account_id: ACCT,
  online_payments_enabled: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_livemode: true,
  payment_receipt_emails_enabled: false, stripe_dispute_auto_reversal: false, ...over });
function world({ community = {}, payments = [], balance = 25000 } = {}) {
  return fakeSupabase({
    properties: [{ id: P1, community_id: C, street_address: '101 Quail Ridge Dr', trusted_account_number: 'QR-0101', payment_sandbox: false }],
    communities: [readyCommunity(community)],
    ownership_tenures: [{ id: TEN, community_id: C, property_id: P1, kind: 'owner', end_date: null, start_date: '2020-01-01' }],
    property_ownerships: [{ tenure_id: TEN, contact_id: 'contact-1', is_primary: true, start_date: '2020-01-01' }],
    v_current_owner_balance: [{ tenure_id: TEN, balance_cents: balance }],
    payments,
    community_account_roles: [
      { community_id: C, role: 'operating_cash', account_id: 'a1000' },
      { community_id: C, role: 'stripe_clearing', account_id: 'a1090' },
      { community_id: C, role: 'homeowner_ar', account_id: 'a1300' }],
    chart_of_accounts: ['a1000', 'a1090', 'a1300'].map((id) => ({ id, community_id: C, is_active: true, is_summary: false })),
  });
}
function fakeStripe({ account = { ok: true, charges_enabled: true, payouts_enabled: true }, sessions = {} } = {}) {
  const calls = { created: [], expired: [], retrieved: [], reversals: [], charges: [] };
  return {
    calls,
    isConfigured: () => true,
    async retrieveAccount() { return account; },
    async createCheckoutSession(opts) { calls.created.push(opts); return { ok: true, session_id: `cs_${calls.created.length}`, checkout_url: `https://checkout.stripe.test/${calls.created.length}` }; },
    async retrieveSession(id) { calls.retrieved.push(id); return sessions[id] ? { ok: true, session: sessions[id] } : { ok: false, error: 'No such checkout.session' }; },
    async expireCheckoutSession(id, o) { calls.expired.push({ id, ...o }); return { ok: true, status: 'expired' }; },
    async retrieveCharge(id) { calls.charges.push(id); return { ok: true, charge: { id, transfer: 'tr_123' } }; },
    async reverseTransfer(o) { calls.reversals.push(o); return { ok: true, reversal_id: 'trr_1', amount_cents: o.amountCents }; },
  };
}
const inflightRow = (over = {}) => ({ id: 'pay-old', community_id: C, product_type: 'assessment_payment', fee_type: 'assessment', payee: 'community_association',
  payment_group_id: 'grp-old', property_id: P1, tenure_id: TEN, amount_cents: 25000, payment_method_type: 'us_bank_account',
  settlement_state: 'awaiting_payment', processor_session_id: 'cs_old', created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), ...over });

// ================================================================ 1. readiness
t('readiness: a fully ready community passes (live key, account verified)', async () => {
  const sb = world();
  const r = await paymentsReadyFor(C, { supabase: sb, stripeLib: fakeStripe(), key: LIVE_KEY, verify: true });
  assert.strictEqual(r.ready, true, JSON.stringify(r));
});
t('readiness: every missing condition refuses with its own reason, and checkout writes nothing', async () => {
  const cases = [
    [{ online_payments_enabled: false }, null, 'online_payments_off'],
    [{ financials_active: false }, null, 'community_not_taking_payments'],
    [{ management_status: 'archived' }, null, 'community_not_taking_payments'],
    [{ stripe_connected_account_id: null }, null, 'community_stripe_not_onboarded'],
    [{}, { ok: true, charges_enabled: false, payouts_enabled: true }, 'connected_account_charges_disabled'],
    [{}, { ok: true, charges_enabled: true, payouts_enabled: false }, 'connected_account_payouts_disabled'],
    [{}, { ok: false, not_found: true, error: 'No such account' }, 'connected_account_mode_mismatch'],
    [{}, { ok: false, error: 'timeout' }, 'connected_account_unverified'],
  ];
  for (const [community, account, reason] of cases) {
    const sb = world({ community }); const st = fakeStripe(account ? { account } : {});
    const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
    assert.strictEqual(r.ok, false, reason);
    assert.strictEqual(r.error, reason, `${JSON.stringify(community)} -> ${r.error}`);
    assert.strictEqual(r.status, 409);
    assert.ok(r.hint && !/stripe|acct_/i.test(r.hint), 'homeowner-safe hint');
    assert.strictEqual(sb._db.payments.length, 0, 'no payment row written');
    assert.strictEqual(st.calls.created.length, 0, 'no Stripe session');
  }
});
t('readiness: no key at all is payment_not_configured (503)', async () => {
  const r = await paymentsReadyFor(C, { supabase: world(), key: '' });
  assert.strictEqual(r.reason, 'payment_not_configured');
});
t('readiness (portal, cached): an account cached from the other mode is not payable', async () => {
  const sb = world({ community: { stripe_account_livemode: false } });
  const r = await paymentsReadyFor(C, { supabase: sb, key: LIVE_KEY, verify: false });
  assert.strictEqual(r.reason, 'connected_account_mode_mismatch');
  const never = await paymentsReadyFor(C, { supabase: world({ community: { stripe_account_livemode: null } }), key: LIVE_KEY });
  assert.strictEqual(never.reason, 'connected_account_unverified');
});
t('readiness: a verified checkout refreshes the cached account state', async () => {
  const sb = world({ community: { stripe_charges_enabled: null, stripe_payouts_enabled: null, stripe_account_livemode: null } });
  await paymentsReadyFor(C, { supabase: sb, stripeLib: fakeStripe(), key: LIVE_KEY, verify: true });
  const c = sb._db.communities[0];
  assert.deepStrictEqual([c.stripe_charges_enabled, c.stripe_payouts_enabled, c.stripe_account_livemode], [true, true, true]);
  assert.ok(c.stripe_account_checked_at);
});
t('readiness: the switch defaults OFF (migration 534 column default)', async () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', '534_stripe_payment_hardening.sql'), 'utf8');
  assert.ok(/online_payments_enabled\s+boolean NOT NULL DEFAULT false/.test(sql));
  assert.ok(/payment_receipt_emails_enabled\s+boolean NOT NULL DEFAULT false/.test(sql));
  assert.ok(/stripe_dispute_auto_reversal\s+boolean NOT NULL DEFAULT false/.test(sql));
});

// ================================================================ 2. one in flight
t('double click: while an ACH payment is processing, checkout refuses with the pending amount', async () => {
  const sb = world({ payments: [inflightRow({ settlement_state: 'processing' })] }); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.strictEqual(r.error, 'payment_processing');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.pending_amount_cents, 25000);
  assert.ok(/\$250\.00 is already processing/.test(r.hint), r.hint);
  assert.strictEqual(st.calls.created.length, 0);
  assert.strictEqual(sb._db.payments.length, 1);
});
t('double click: an open identical checkout is handed back; no second session', async () => {
  const sb = world({ payments: [inflightRow()] });
  const st = fakeStripe({ sessions: { cs_old: { id: 'cs_old', status: 'open', url: 'https://checkout.stripe.test/old' } } });
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.ok(r.ok && r.reused, JSON.stringify(r));
  assert.strictEqual(r.checkout_url, 'https://checkout.stripe.test/old');
  assert.strictEqual(st.calls.created.length, 0);
  assert.strictEqual(sb._db.payments.length, 1);
});
t('double click: switching ACH -> card expires the open session first, then opens one new one', async () => {
  const sb = world({ payments: [inflightRow()] });
  const st = fakeStripe({ sessions: { cs_old: { id: 'cs_old', status: 'open', url: 'https://x/old' } } });
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'card', initiatedBy: 'homeowner_portal', ...urls });
  assert.ok(r.ok && !r.reused, JSON.stringify(r));
  assert.deepStrictEqual(st.calls.expired.map((e) => e.id), ['cs_old']);
  assert.strictEqual(sb._db.payments.find((p) => p.id === 'pay-old').settlement_state, 'expired');
  assert.strictEqual(st.calls.created.length, 1);
});
t('double click: a completed (Stripe has it) session refuses as processing', async () => {
  const sb = world({ payments: [inflightRow()] });
  const st = fakeStripe({ sessions: { cs_old: { id: 'cs_old', status: 'complete' } } });
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.strictEqual(r.error, 'payment_processing');
  assert.strictEqual(st.calls.created.length, 0);
});
t('double click: a checkout older than Stripe\'s 24h limit is expired locally and a new one opens', async () => {
  const sb = world({ payments: [inflightRow({ created_at: '2026-06-01T12:00:00Z' })] }); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(st.calls.retrieved.length, 0, 'no Stripe lookup for a dead session');
  assert.strictEqual(sb._db.payments.find((p) => p.id === 'pay-old').settlement_state, 'expired');
});
t('double click: an unverifiable recent checkout refuses rather than risk two sessions', async () => {
  const sb = world({ payments: [inflightRow()] }); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.strictEqual(r.error, 'checkout_in_progress');
  assert.strictEqual(st.calls.created.length, 0);
});
t('double click: two simultaneous clicks -> the unique index stops the second (409, no Stripe call)', async () => {
  const sb = world(); const st = fakeStripe();
  // Both clicks pass the in-flight read before either inserts; the second insert hits the index.
  const origFrom = sb.from; let reads = 0;
  sb.from = (t2) => { const b = origFrom(t2); if (t2 === 'payments') { const sel = b.select; b.select = (...a) => { reads++; return sel(...a); }; } return b; };
  const [a, b2] = await Promise.all([1, 2].map(() => createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY },
    { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls })));
  const outcomes = [a, b2].map((x) => (x.ok ? 'ok' : x.error)).sort();
  assert.deepStrictEqual(outcomes, ['checkout_in_progress', 'ok'], JSON.stringify([a, b2]));
  assert.strictEqual(st.calls.created.length, 1, 'exactly one Stripe session');
  assert.ok(reads >= 2);
});
t('portal: pending ACH shows as "Payment processing" with its amount; switch state comes from the server', async () => {
  const sb = world({ payments: [inflightRow({ settlement_state: 'processing' })] });
  const st = await portalPaymentState(sb, { communityId: C, propertyId: P1, tenureId: TEN });
  assert.strictEqual(st.payments_enabled, false, 'no key in this test env -> not configured');
  assert.deepStrictEqual([st.pending.amount_cents, st.pending.label], [25000, 'Payment processing']);
  const none = await portalPaymentState(world({ payments: [inflightRow()] }), { communityId: C, propertyId: P1 });
  assert.strictEqual(none.pending, null, 'an unpaid open checkout is not money in flight');
});

// ================================================================ 3. idempotency
t('idempotency: the checkout session is created with a key bound to its payment group', async () => {
  const sb = world(); const st = fakeStripe();
  const r = await createAssessmentCheckout({ supabase: sb, stripeLib: st, key: LIVE_KEY }, { propertyId: P1, paymentMethod: 'ach', initiatedBy: 'homeowner_portal', ...urls });
  assert.ok(r.ok);
  assert.strictEqual(st.calls.created[0].idempotencyKey, `asmt-checkout-${r.payment_group_id}`);
});
t('idempotency: stripe.js sends the Idempotency-Key header on writes', async () => {
  const saved = { fetch: global.fetch, key: process.env.STRIPE_SECRET_KEY };
  const seen = [];
  global.fetch = async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => ({ id: 'cs_9', status: 'expired' }) }; };
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline';
  try {
    delete require.cache[require.resolve('../lib/payments/stripe')];
    const stripe = require('../lib/payments/stripe');
    const r = await stripe.expireCheckoutSession('cs_9', { idempotencyKey: 'asmt-expire-g1' });
    assert.ok(r.ok);
    assert.strictEqual(seen[0].headers['Idempotency-Key'], 'asmt-expire-g1');
    assert.ok(/\/checkout\/sessions\/cs_9\/expire$/.test(seen[0].url));
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
  }
});

// ================================================================ 4/5. payouts + webhook idempotency
// A store whose event claims behave like stripe_event_claim (migration 469).
function webhookStore(sb, extra = {}) {
  const store = createPaymentStore({ supabase: sb, log: quiet, stripe: fakeStripe(), evaluate: extra.evaluate, receiptDeps: extra.receiptDeps || {} });
  const events = new Map();
  store.claimEvent = async (e) => {
    const cur = events.get(e.id);
    if (cur && ['processed', 'ignored'].includes(cur.status)) return 'done';
    events.set(e.id, { type: e.type, status: 'processing' });
    return 'process';
  };
  store.finishEvent = async (id, status, error, outcome) => { Object.assign(events.get(id), { status, error, outcome }); };
  store._events = events;
  return store;
}
const payoutEvent = (id, type = 'payout.paid', over = {}) => ({ id, type, livemode: true, account: ACCT, created: 1792170000,
  data: { object: { id: 'po_1', object: 'payout', amount: 81633, currency: 'usd', arrival_date: 1792170000, status: 'paid', ...over } } });

t('payout.paid: one entry Dr operating cash / Cr Stripe clearing on the arrival date', async () => {
  const sb = world(); const store = webhookStore(sb);
  const out = await processWebhookEvent(payoutEvent('evt_p1'), { store, mode: 'live', log: quiet });
  assert.strictEqual(out.http, 200);
  const jes = sb._db.journal_entries;
  assert.strictEqual(jes.length, 1);
  const je = jes[0];
  assert.strictEqual(je.source_reference, 'stripe:payout:po_1');
  assert.strictEqual(je.posting_date, '2026-10-16');
  assert.deepStrictEqual(je.lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents]), [['a1000', 81633, 0], ['a1090', 0, 81633]]);
  const row = sb._db.stripe_payouts[0];
  assert.deepStrictEqual([row.posting_state, row.journal_entry_id, row.amount_cents], ['posted', je.id, 81633]);
});
t('payout: a duplicate delivery (same event) and a re-sent event (new id, same payout) post nothing more', async () => {
  const sb = world(); const store = webhookStore(sb);
  await processWebhookEvent(payoutEvent('evt_p1'), { store, mode: 'live', log: quiet });
  const dup = await processWebhookEvent(payoutEvent('evt_p1'), { store, mode: 'live', log: quiet });
  assert.deepStrictEqual(dup.body, { received: true, duplicate: true });
  const again = await processWebhookEvent(payoutEvent('evt_p1b'), { store, mode: 'live', log: quiet });
  assert.strictEqual(again.http, 200);
  assert.strictEqual(store._events.get('evt_p1b').outcome.action, 'payout_already_posted');
  assert.strictEqual(sb._db.journal_entries.length, 1, 'exactly one JE per payout');
});
t('payout: a crash between the JE and the row update resumes without a second JE', async () => {
  const sb = world(); const store = webhookStore(sb);
  sb._db.journal_entries.push({ id: 'je-pre', community_id: C, source_reference: 'stripe:payout:po_1', status: 'posted' });
  const r = await handleStripeEvent(payoutEvent('evt_p2'), { store, mode: 'live', log: quiet });
  assert.strictEqual(r.outcome.action, 'payout_already_posted');
  assert.strictEqual(sb._db.journal_entries.length, 1);
  assert.strictEqual(sb._db.stripe_payouts[0].journal_entry_id, 'je-pre');
});
t('payout.failed after paid reverses it once (Dr clearing / Cr cash); before posting nothing is posted', async () => {
  const sb = world(); const store = webhookStore(sb);
  await processWebhookEvent(payoutEvent('evt_p1'), { store, mode: 'live', log: quiet });
  await processWebhookEvent(payoutEvent('evt_f1', 'payout.failed', { status: 'failed', failure_code: 'account_closed' }), { store, mode: 'live', log: quiet });
  await processWebhookEvent(payoutEvent('evt_f2', 'payout.failed', { status: 'failed', failure_code: 'account_closed' }), { store, mode: 'live', log: quiet });
  const fail = sb._db.journal_entries.filter((j) => j.source_reference === 'stripe:payout-fail:po_1');
  assert.strictEqual(fail.length, 1);
  assert.deepStrictEqual(fail[0].lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents]), [['a1090', 81633, 0], ['a1000', 0, 81633]]);
  assert.strictEqual(sb._db.stripe_payouts[0].posting_state, 'reversed');
  const sb2 = world(); const s2 = webhookStore(sb2);
  const r = await handleStripeEvent(payoutEvent('evt_f3', 'payout.failed', { status: 'failed' }), { store: s2, mode: 'live', log: quiet });
  assert.strictEqual(r.outcome.action, 'payout_failed_unposted');
  assert.strictEqual(sb2._db.journal_entries.length, 0);
});
t('payout: never posts for an archived community, financials off, or before GL cutover', async () => {
  for (const [community, why] of [[{ management_status: 'archived' }, 'archived'], [{ financials_active: false }, 'financials'], [{ gl_cutover_date: '2026-11-01' }, 'before_gl_cutover'], [{ gl_cutover_date: null }, 'before_gl_cutover']]) {
    const sb = world({ community }); const store = webhookStore(sb);
    const r = await handleStripeEvent(payoutEvent('evt_x', 'payout.paid', { arrival_date: Date.parse('2026-10-16T17:00:00Z') / 1000 }), { store, mode: 'live', log: quiet });
    assert.strictEqual(r.outcome.action, 'payout_not_applicable', why);
    assert.strictEqual(sb._db.journal_entries.length, 0, why);
    assert.strictEqual(sb._db.stripe_payouts[0].posting_state, 'not_applicable');
  }
});
t('payout: a closed period or a missing cash role is blocked for staff, not thrown', async () => {
  const sb = world(); const store = webhookStore(sb);
  postFail = { code: 'period_closed', message: 'period_closed: the books are closed through 2026-10-31' };
  const r = await handleStripeEvent(payoutEvent('evt_c'), { store, mode: 'live', log: quiet });
  assert.strictEqual(r.outcome.action, 'payout_blocked');
  assert.strictEqual(sb._db.stripe_payouts[0].posting_state, 'blocked');
  const sb2 = world(); sb2._db.community_account_roles = sb2._db.community_account_roles.filter((x) => x.role !== 'operating_cash');
  const r2 = await handleStripeEvent(payoutEvent('evt_d'), { store: webhookStore(sb2), mode: 'live', log: quiet });
  assert.deepStrictEqual([r2.outcome.action, r2.outcome.role], ['payout_blocked', 'operating_cash']);
});
t('payout: an unexpected posting error throws so Stripe retries', async () => {
  const sb = world(); const store = webhookStore(sb);
  postFail = { code: 'XX000', message: 'connection reset' };
  const out = await processWebhookEvent(payoutEvent('evt_e'), { store, mode: 'live', log: quiet });
  assert.strictEqual(out.http, 500);
  assert.strictEqual(store._events.get('evt_e').status, 'failed');
});
t('payout: a platform (Bedrock) payout and an unknown account are recorded and ignored', async () => {
  const sb = world(); const store = webhookStore(sb);
  const plat = payoutEvent('evt_plat'); delete plat.account;
  await processWebhookEvent(plat, { store, mode: 'live', log: quiet });
  assert.strictEqual(store._events.get('evt_plat').status, 'ignored');
  const other = payoutEvent('evt_other'); other.account = 'acct_unknown';
  await processWebhookEvent(other, { store, mode: 'live', log: quiet });
  assert.strictEqual(store._events.get('evt_other').status, 'ignored');
  assert.strictEqual(sb._db.journal_entries.length, 0);
});
t('webhook: unknown types and livemode-mismatched events are recorded and ignored', async () => {
  const sb = world(); const store = webhookStore(sb);
  await processWebhookEvent({ id: 'evt_u', type: 'customer.created', livemode: true, data: { object: {} } }, { store, mode: 'live', log: quiet });
  await processWebhookEvent(payoutEvent('evt_m'), { store, mode: 'test', log: quiet });
  assert.deepStrictEqual([store._events.get('evt_u').status, store._events.get('evt_m').status], ['ignored', 'ignored']);
  assert.strictEqual(store._events.get('evt_m').outcome.reason, 'livemode_mismatch');
  assert.strictEqual(sb._db.journal_entries.length, 0);
});
t('webhook: signatures verify per source; a connected-account event signed with the platform secret is refused', () => {
  const { verifyStripeWebhook } = require('../lib/payments/webhook_auth');
  const body = JSON.stringify({ id: 'evt', type: 'payout.paid', account: ACCT });
  const verify = (raw, sig, secret) => ({ ok: secret === 'whsec_connect' });
  assert.strictEqual(verifyStripeWebhook(body, 't=1,v1=x', { platformSecret: 'whsec_platform', connectSecret: 'whsec_connect', verify }).ok, true);
  assert.strictEqual(verifyStripeWebhook(body, 't=1,v1=x', { platformSecret: 'whsec_connect', connectSecret: 'whsec_platform', verify }).ok, false);
  const noSecret = verifyStripeWebhook(body, 't=1,v1=x', { platformSecret: 'p', connectSecret: '', verify });
  assert.deepStrictEqual([noSecret.ok, noSecret.status], [false, 503]);
});
t('bank rec: the payout entry matches the bank deposit; no unrecorded receipt is raised', () => {
  const account = { id: 'opr', label: 'Operating 1234', gl_account_number: '1000' };
  const opening = { as_of_date: '2026-09-30', bank_balance_cents: 100000, book_balance_cents: 100000, outstanding_checks: [], deposits_in_transit: [] };
  const gl = [{ id: 'g0', je_id: 'j0', reference: 'OPEN', posting_date: '2026-09-30', amount_cents: 100000, memo: 'Opening', description: 'Opening', source_module: 'opening_entry' },
    { id: 'g1', je_id: 'je-1', reference: 'JE-PO1', posting_date: '2026-10-16', amount_cents: 81633, memo: 'Stripe payout po_1', description: 'Stripe payout po_1 to the operating bank account', source_module: 'payment_intake' }];
  const stmt = { id: 'imp10', statement_period_start: '2026-10-01', statement_period_end: '2026-10-31', beginning_balance_cents: 100000, ending_balance_cents: 181633 };
  const bank = { id: 'b1', bank_statement_import_id: 'imp10', posting_date: '2026-10-16', amount_cents: 81633, description: 'STRIPE TRANSFER ST-PO1', check_number: null, transaction_type: 'ach_in' };
  const r = reconcileAccountMonth({ account, period_start: '2026-10-01', period_end: '2026-10-31', opening, statements: [stmt], bankTxns: [bank], glLines: gl,
    otherBankTxns: [], homeownerPayments: [], settings: { stale_check_days: 90, stale_deposit_days: 10, match_window_days: 45 }, codings: [], receiptOwners: {}, undepositedAccount: '1020' });
  assert.strictEqual(r.totals.difference_cents, 0, JSON.stringify(r.totals));
  assert.ok(r.items.some((i) => i.category === 'matched' && i.gl_ref === 'JE-PO1'));
  assert.ok(!r.exceptions.some((e) => e.code === 'unrecorded_receipt'));
});

// ================================================================ 6. lost dispute
function settledWorld(community = {}) {
  return world({ community, payments: [{ id: 'pay-1', community_id: C, product_type: 'assessment_payment', fee_type: 'assessment', payment_group_id: 'g1',
    property_id: P1, tenure_id: TEN, amount_cents: 25000, processor_payment_id: 'pi_1', settlement_state: 'settled', posting_state: 'reversed' }] });
}
const disputeClosed = (id, status) => ({ id, type: 'charge.dispute.closed', livemode: true, created: 1760630400,
  data: { object: { id: 'dp_1', status, amount: 25000, charge: 'ch_1', payment_intent: 'pi_1' } } });
t('dispute lost, auto reversal OFF (default): flagged with the exact transfer reversal; nothing reversed', async () => {
  const sb = settledWorld(); const stripe = fakeStripe();
  const store = createPaymentStore({ supabase: sb, log: quiet, stripe });
  const r = await handleStripeEvent(disputeClosed('evt_d1', 'lost'), { store, mode: 'live', log: quiet });
  assert.strictEqual(r.outcome.action, 'dispute_lost_flagged');
  assert.strictEqual(stripe.calls.reversals.length, 0);
  const p = sb._db.payments[0];
  assert.ok(p.needs_review);
  assert.ok(/reverse transfer tr_123 for \$250\.00/.test(p.review_reason) && /POST \/v1\/transfers\/tr_123\/reversals amount=25000/.test(p.review_reason), p.review_reason);
  assert.ok(p.review_reason.includes(`dispute_bearer is '${PAYMENT_POLICY.dispute_bearer}'`));
  assert.ok(!/—/.test(p.review_reason), 'no em dashes');
});
t('dispute lost, auto reversal ON: the transfer is reversed once, by idempotency key', async () => {
  const sb = settledWorld({ stripe_dispute_auto_reversal: true }); const stripe = fakeStripe();
  const store = createPaymentStore({ supabase: sb, log: quiet, stripe });
  const r = await handleStripeEvent(disputeClosed('evt_d2', 'lost'), { store, mode: 'live', log: quiet });
  assert.strictEqual(r.outcome.action, 'transfer_reversed');
  assert.deepStrictEqual(stripe.calls.reversals.map((x) => [x.transferId, x.amountCents, x.idempotencyKey]), [['tr_123', 25000, 'dispute-lost-dp_1']]);
});
t('dispute won or under review: no transfer reversal', async () => {
  const sb = settledWorld({ stripe_dispute_auto_reversal: true }); const stripe = fakeStripe();
  const store = createPaymentStore({ supabase: sb, log: quiet, stripe });
  store.findAssessmentByIntent = async () => ({ id: 'pay-1', payment_group_id: 'g1', group_total_cents: 25000 });
  await handleStripeEvent(disputeClosed('evt_d3', 'won'), { store, mode: 'live', log: quiet });
  await handleStripeEvent(disputeClosed('evt_d4', 'warning_closed'), { store, mode: 'live', log: quiet });
  assert.strictEqual(stripe.calls.reversals.length, 0);
});
t('policy: who bears ACH fees and disputes is an explicit, undecided default', () => {
  assert.deepStrictEqual({ ...PAYMENT_POLICY }, { ach_fee_bearer: 'platform', dispute_bearer: 'platform' });
  assert.ok(/TODO\(Ed\)/.test(require('fs').readFileSync(require.resolve('../lib/payments/payment_policy'), 'utf8')));
});

// ================================================================ 7. receipts
const session = { id: 'cs_1', payment_intent: 'pi_1', customer_details: { email: 'owner@example.com', name: 'Pat Owner' }, metadata: { payment_group_id: 'g1', product_type: 'assessment_payment' } };
function receiptWorld(community = {}) {
  return world({ community, payments: [
    { id: 'pay-1', community_id: C, product_type: 'assessment_payment', fee_type: 'assessment', payment_group_id: 'g1', property_id: P1, tenure_id: TEN,
      amount_cents: 25000, payment_method_type: 'card', trusted_account_number: 'QR-0101', settlement_state: 'settled' },
    { id: 'pay-1f', community_id: C, product_type: 'assessment_payment', fee_type: 'convenience_fee', payment_group_id: 'g1', amount_cents: 781, settlement_state: 'settled' }] });
}
function receiptDeps() {
  const sent = [];
  return { sent, deps: {
    buildPersonaEmail: (persona, body, communityName) => ({ html: `<p>${persona}|${communityName}</p>${body}`, attachments: [{ name: 'headshot' }] }),
    graphSend: { CLAIRE_MAILBOX: 'claire@bedrocktx.com', async sendAs(o) { sent.push(o); return { sent: true }; } },
  } };
}
t('receipt: recorded on settle and NOT emailed while the switch is off (default)', async () => {
  const sb = receiptWorld(); const rd = receiptDeps();
  const store = createPaymentStore({ supabase: sb, log: quiet, receiptDeps: rd.deps });
  const r = await store.createReceipt('pay-1', { session, paymentDate: '2026-10-16' });
  assert.deepStrictEqual([r.action, r.emailed, r.status], ['receipt_recorded', false, 'sending_disabled']);
  assert.strictEqual(rd.sent.length, 0);
  const row = sb._db.payment_receipts[0];
  assert.strictEqual(row.amount_cents, 25000);
  assert.ok(/Quail Ridge HOA, Inc\. received your payment of \$250\.00 on October 16, 2026/.test(row.body_text), row.body_text);
  assert.ok(/Card convenience fee: \$7\.81/.test(row.body_text));
});
t('receipt: with the switch on it goes out once, as Claire with the branded block', async () => {
  const sb = receiptWorld({ payment_receipt_emails_enabled: true }); const rd = receiptDeps();
  const store = createPaymentStore({ supabase: sb, log: quiet, receiptDeps: rd.deps });
  const r = await store.createReceipt('pay-1', { session, paymentDate: '2026-10-16' });
  assert.deepStrictEqual([r.emailed, r.status], [true, 'sent']);
  assert.strictEqual(rd.sent.length, 1);
  assert.deepStrictEqual([rd.sent[0].from, rd.sent[0].to], ['claire@bedrocktx.com', 'owner@example.com']);
  assert.ok(rd.sent[0].html.startsWith('<p>claire|Quail Ridge</p>') && rd.sent[0].attachments.length === 1);
  const again = await store.createReceipt('pay-1', { session, paymentDate: '2026-10-16' });
  assert.strictEqual(again.action, 'receipt_exists');
  assert.strictEqual(rd.sent.length, 1, 'never a second email');
});
t('receipt: a failed send is recorded, never thrown; no recipient is recorded as such', async () => {
  const sb = receiptWorld({ payment_receipt_emails_enabled: true }); const rd = receiptDeps();
  rd.deps.graphSend.sendAs = async () => { throw new Error('graph_not_configured'); };
  const r = await createPaymentStore({ supabase: sb, log: quiet, receiptDeps: rd.deps }).createReceipt('pay-1', { session, paymentDate: '2026-10-16' });
  assert.deepStrictEqual([r.emailed, sb._db.payment_receipts[0].status], [false, 'send_failed']);
  assert.strictEqual(receiptSendDecision({ community: { payment_receipt_emails_enabled: true }, toEmail: null }).status, 'no_recipient');
});
t('receipt: settle -> post -> receipt through the webhook; a receipt failure never fails the webhook', async () => {
  const sb = receiptWorld();
  const store = webhookStore(sb);
  store.settle = async () => ({ action: 'post', payment_id: 'pay-1' });
  store.postPayment = async () => ({ posting: 'posted' });
  const ev = { id: 'evt_s', type: 'checkout.session.completed', livemode: true, created: 1760630400, data: { object: { ...session, payment_status: 'paid' } } };
  const out = await processWebhookEvent(ev, { store, mode: 'live', log: quiet });
  assert.strictEqual(out.http, 200);
  assert.strictEqual(store._events.get('evt_s').outcome.receipt.action, 'receipt_recorded');
  const sb2 = receiptWorld(); const s2 = webhookStore(sb2);
  s2.settle = async () => ({ action: 'post', payment_id: 'pay-1' });
  s2.postPayment = async () => ({ posting: 'posted' });
  s2.createReceipt = async () => { throw new Error('relation "payment_receipts" does not exist'); };
  const out2 = await processWebhookEvent({ ...ev, id: 'evt_s2' }, { store: s2, mode: 'live', log: quiet });
  assert.strictEqual(out2.http, 200);
  assert.strictEqual(s2._events.get('evt_s2').outcome.receipt.action, 'receipt_failed');
});
t('receipt builder: refuses a non-positive amount or a bad date; no em dashes', () => {
  assert.throws(() => buildPaymentReceipt({ payment: { id: 'x', amount_cents: 0 }, paidOn: '2026-10-16' }));
  assert.throws(() => buildPaymentReceipt({ payment: { id: 'x', amount_cents: 100 }, paidOn: '10/16/2026' }));
  const r = buildPaymentReceipt({ payment: { id: 'abcd-ef12-3456', amount_cents: 100, trusted_account_number: 'QR-1', payment_method_type: 'us_bank_account' }, community: { name: 'QR' }, paidOn: '2026-10-16' });
  assert.ok(!/—/.test(r.body_text + r.subject));
  assert.ok(/Bank account \(ACH\)/.test(r.body_text));
});

// ---------------------------------------------------------------- run (in order: some tests swap globals)
(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : `\nall ${queue.length} payment hardening checks passed`);
  process.exit(failed ? 1 : 0);
})();
