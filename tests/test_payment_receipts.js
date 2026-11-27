// tests/test_payment_receipts.js  (Ed 2026-11-27)
// Homeowner payment confirmations: the Bedrock confirmation number, the receipt and
// the ACH "submitted" email, sent ONCE per payment and never on a webhook replay,
// refund or dispute. Offline: fake Supabase, fake email, fake payment store.
// Run: node tests/test_payment_receipts.js
const assert = require('assert');
const { newConfirmationNumber, normalizeConfirmationNumber, isConfirmationNumber } = require('../lib/payments/confirmation_number');
const { renderPaymentNotice, createPaymentNotifier, methodText } = require('../lib/payments/payment_receipts');
const { processWebhookEvent } = require('../lib/payments/payment_lifecycle');

let failed = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const DASH_RE = /[–—]/;

// ---------------------------------------------------------------- fake supabase
// Enough of PostgREST for the notifier: select/eq/is/in/or/order/limit/single/maybeSingle,
// update (compare-and-set via the filters, applied atomically), insert.
function fakeSupabase(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  let seq = 0;
  const parseOr = (expr) => expr.split(',').map((part) => {
    const [col, op, ...rest] = part.split('.');
    const v = rest.join('.');
    if (op === 'is' && v === 'null') return (r) => r[col] == null;
    if (op === 'lt') return (r) => r[col] != null && String(r[col]) < v;
    if (op === 'neq') return (r) => r[col] !== v;
    throw new Error(`fake or(): unsupported ${part}`);
  });
  function builder(table) {
    const filters = []; let op = 'select'; let payload = null; let single = null; let limitN = null;
    const run = () => {
      db[table] = db[table] || [];
      const rows = db[table];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `${table}-${++seq}`, ...r }));
        db[table] = rows.concat(list);
        return { data: list, error: null };
      }
      if (op === 'update') { match.forEach((r) => Object.assign(r, payload)); return { data: match.map((r) => ({ ...r })), error: null }; }
      const out = limitN != null ? match.slice(0, limitN) : match;
      if (single === 'maybe') return { data: out[0] ? { ...out[0] } : null, error: null };
      if (single === 'one') return out.length === 1 ? { data: { ...out[0] }, error: null } : { data: null, error: { message: 'not single' } };
      return { data: out.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; }, order() { return b; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
      is(c, v) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      or(expr) { const any = parseOr(expr); filters.push((r) => any.some((f) => f(r))); return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { single = 'maybe'; return b; },
      single() { single = 'one'; return b; },
      insert(rows) { op = 'insert'; payload = rows; return b; },
      update(patch) { op = 'update'; payload = patch; return b; },
      then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
    };
    return b;
  }
  return { from: builder, db };
}

const COMM = 'comm-wv'; const PROP = 'prop-1'; const GROUP = 'grp-1';
function world({ methodType = 'card', settlement = 'settled', posting = 'posted', fee = 4286, confirmation = 'BP-7K3M-9QXA', display = 'visa ending 4242' } = {}) {
  return fakeSupabase({
    payments: [
      { id: 'pay-a', community_id: COMM, property_id: PROP, contact_id: 'c-1', portal_user_id: 'pu-1', payment_group_id: GROUP, product_type: 'assessment_payment', fee_type: 'assessment',
        amount_cents: 142500, payment_method_type: methodType, settlement_state: settlement, posting_state: posting, settled_at: '2026-12-01T16:05:00Z', created_at: '2026-12-01T16:00:00Z',
        confirmation_number: confirmation, processor_payment_id: 'pi_3QzSECRET', stripe_charge_id: 'ch_3QzSECRET',
        processor_metadata: { flow: 'payment_element', method_display: display } },
      ...(fee ? [{ id: 'pay-f', community_id: COMM, payment_group_id: GROUP, product_type: 'assessment_payment', fee_type: methodType === 'card' ? 'card_fee' : 'ach_fee', amount_cents: fee, confirmation_number: confirmation }] : []),
    ],
    portal_users: [{ id: 'pu-1', email: 'owner@example.com', status: 'active' }],
    contacts: [{ id: 'c-1', primary_email: 'contact@example.com' }],
    communities: [{ id: COMM, name: 'Waterview Estates', hoa_legal_name: 'Waterview Estates Owners Association, Inc.', slug: 'waterview' }],
    properties: [{ id: PROP, street_address: '5127 Waterview Meadow Dr' }],
    interactions: [],
  });
}
function mailer({ fail = false } = {}) {
  const sent = [];
  const sendEmail = async (opts) => { sent.push(opts); return fail ? { ok: false, error: 'resend down' } : { ok: true, vendor_message_id: `msg-${sent.length}` }; };
  return { sent, sendEmail };
}
const quiet = { log() {}, warn() {}, error() {} };
const FROM = 'Bedrock Notices <notices@bedrocktx.com>';
const notifierFor = (sb, m, extra = {}) => createPaymentNotifier({ supabase: sb, sendEmail: m.sendEmail, fromAddress: FROM, log: quiet, ...extra });

// ================================================================ confirmation numbers
t('confirmation number: BP-XXXX-XXXX, Crockford alphabet, no I L O U', () => {
  for (let i = 0; i < 2000; i++) {
    const n = newConfirmationNumber();
    assert.ok(isConfirmationNumber(n), n);
    assert.ok(!/[ILOU]/.test(n.slice(3)), n);
  }
});
t('confirmation number: 20,000 draws, no collision', () => {
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(newConfirmationNumber());
  assert.strictEqual(seen.size, 20000);
});
t('confirmation number: staff typing is normalized (case, O/0, I/1, dashes)', () => {
  assert.strictEqual(normalizeConfirmationNumber('bp-7k3m-9qxa'), 'BP-7K3M-9QXA');
  assert.strictEqual(normalizeConfirmationNumber('BP 7K3M 9QXA'), 'BP-7K3M-9QXA');
  assert.strictEqual(normalizeConfirmationNumber('7K3M9QXA'), 'BP-7K3M-9QXA');
  assert.strictEqual(normalizeConfirmationNumber('BP-1OI0-0000'), 'BP-1010-0000');
  assert.strictEqual(normalizeConfirmationNumber('pi_123'), null);
  assert.strictEqual(normalizeConfirmationNumber(''), null);
});

// ================================================================ the email itself
const sample = (kind, over = {}) => renderPaymentNotice({ kind, confirmationNumber: 'BP-7K3M-9QXA', associationName: 'Waterview Estates Owners Association, Inc.',
  communityName: 'Waterview Estates', propertyAddress: '5127 Waterview Meadow Dr', appliedCents: 142500, feeCents: 4286, methodType: 'card',
  methodDisplay: 'visa ending 4242', dateIso: '2026-12-01T16:05:00Z', ...over });

t('receipt: every required fact, fee on its own line, total = applied + fee', () => {
  const m = sample('receipt');
  for (const part of ['BP-7K3M-9QXA', 'Waterview Estates Owners Association, Inc.', '5127 Waterview Meadow Dr', 'Amount applied to your account: $1,425.00',
    'Processing fee (not applied to your account): $42.86', 'Total charged: $1,467.86', 'Payment method: Visa ending 4242', 'Date paid: December 1, 2026']) {
    assert.ok(m.text.includes(part), `missing "${part}"`);
  }
  assert.strictEqual(m.total_cents, 146786);
  assert.ok(m.subject.includes('BP-7K3M-9QXA') && /receipt/i.test(m.subject));
});
t('receipt: no fee shows $0.00, never hides the line', () => {
  const m = sample('receipt', { feeCents: 0, methodType: 'us_bank_account', methodDisplay: 'STRIPE TEST BANK ending 6789' });
  assert.ok(m.text.includes('Processing fee (not applied to your account): $0.00'));
  assert.ok(m.text.includes('Total charged: $1,425.00'));
  assert.ok(m.text.includes('Payment method: Bank account ending 6789'));
});
t('submitted (ACH): says it is processing, promises the receipt, amounts to be debited', () => {
  const m = sample('submitted', { methodType: 'us_bank_account', methodDisplay: 'Chase ending 6789', feeCents: 150 });
  assert.ok(/submitted/i.test(m.subject));
  assert.ok(m.text.includes('few business days'));
  assert.ok(m.text.includes('We will email your receipt'));
  assert.ok(m.text.includes('Total to be debited: $1,426.50'));
  assert.ok(m.text.includes('Amount to be applied to your account: $1,425.00'));
});
t('no em-dash or en-dash in any homeowner text, even when a name carries one', () => {
  for (const kind of ['receipt', 'submitted']) {
    const m = sample(kind, { associationName: 'Lakes — of Pine Forest', propertyAddress: '12 Oak – Unit B' });
    for (const part of [m.subject, m.text, m.html]) assert.ok(!DASH_RE.test(part), `${kind}: dash found`);
  }
});
t('method: only the last 4 digits ever appear', () => {
  assert.strictEqual(methodText({ methodType: 'card', display: 'visa ending 4242' }), 'Visa ending 4242');
  assert.strictEqual(methodText({ methodType: 'card', display: 'amex ending 0005' }), 'Amex ending 0005');
  assert.strictEqual(methodText({ methodType: 'card', display: '4242424242424242' }), 'Card');
  assert.strictEqual(methodText({ methodType: 'us_bank_account', display: 'Bank 000123456789 ending 6789' }), 'Bank account ending 6789');
  assert.strictEqual(methodText({ methodType: 'card', display: null }), 'Card');
});
t('the Stripe ids never appear in the email', async () => {
  const sb = world(); const m = mailer();
  await notifierFor(sb, m).notify('pay-a', 'receipt');
  const e = m.sent[0];
  for (const part of [e.subject, e.text, e.html]) assert.ok(!/\b(pi|ch|py|po|cs|tr)_[A-Za-z0-9]+/.test(part), 'stripe id leaked');
});
t('HTML escapes names', () => {
  const m = sample('receipt', { propertyAddress: '<script>x</script>' });
  assert.ok(!m.html.includes('<script>'));
});

// ================================================================ once, never on replay
t('idempotency: the second call (a replay) sends nothing', async () => {
  const sb = world(); const m = mailer(); const n = notifierFor(sb, m);
  const a = await n.notify('pay-a', 'receipt');
  const b = await n.notify('pay-a', 'receipt');
  assert.strictEqual(a.action, 'sent'); assert.strictEqual(b.action, 'already_sent');
  assert.strictEqual(m.sent.length, 1);
  const row = sb.db.payments.find((r) => r.id === 'pay-a');
  assert.ok(row.receipt_sent_at && row.receipt_message_id === 'msg-1' && row.receipt_email === 'owner@example.com');
  assert.strictEqual(m.sent[0].idempotencyKey, 'payment-receipt-pay-a');
  assert.strictEqual(m.sent[0].to, 'owner@example.com');
});
t('idempotency: two deliveries at the same moment send one email', async () => {
  const sb = world(); const m = mailer(); const n = notifierFor(sb, m);
  const [a, b] = await Promise.all([n.notify('pay-a', 'receipt'), n.notify('pay-a', 'receipt')]);
  assert.deepStrictEqual([a.action, b.action].sort(), ['already_claimed', 'sent']);
  assert.strictEqual(m.sent.length, 1);
});
t('idempotency: a second notifier (another server process) still sends nothing', async () => {
  const sb = world(); const m = mailer();
  await notifierFor(sb, m).notify('pay-a', 'receipt');
  await notifierFor(sb, m).notify('pay-a', 'receipt');
  assert.strictEqual(m.sent.length, 1);
});
t('a fresh claim held by another sender blocks; an abandoned one (over 15 min) does not', async () => {
  const sb = world(); const m = mailer();
  const row = sb.db.payments.find((r) => r.id === 'pay-a');
  row.receipt_claimed_at = new Date(Date.now() - 60 * 1000).toISOString();
  assert.strictEqual((await notifierFor(sb, m).notify('pay-a', 'receipt')).action, 'already_claimed');
  row.receipt_claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  assert.strictEqual((await notifierFor(sb, m).notify('pay-a', 'receipt')).action, 'sent');
  assert.strictEqual(m.sent.length, 1);
});
t('a failed send releases the claim, records the reason, and a later call sends', async () => {
  const sb = world(); const bad = mailer({ fail: true });
  const r = await notifierFor(sb, bad).notify('pay-a', 'receipt');
  assert.strictEqual(r.action, 'not_sent');
  const row = sb.db.payments.find((x) => x.id === 'pay-a');
  assert.strictEqual(row.receipt_claimed_at, null); assert.ok(/resend down/.test(row.notice_error)); assert.ok(!row.receipt_sent_at);
  const good = mailer();
  assert.strictEqual((await notifierFor(sb, good).notify('pay-a', 'receipt')).action, 'sent');
  assert.strictEqual(row.notice_error, null);
});
t('the sent receipt is logged on the property\'s interaction history', async () => {
  const sb = world(); const m = mailer();
  await notifierFor(sb, m).notify('pay-a', 'receipt');
  const i = sb.db.interactions;
  assert.strictEqual(i.length, 1);
  assert.strictEqual(i[0].type, 'email_outbound'); assert.strictEqual(i[0].property_id, PROP); assert.ok(i[0].subject.includes('BP-7K3M-9QXA'));
});
t('no receipt for a payment not settled, or reversed before the receipt went out', async () => {
  const m = mailer();
  assert.strictEqual((await notifierFor(world({ settlement: 'processing' }), m).notify('pay-a', 'receipt')).action, 'skipped');
  assert.strictEqual((await notifierFor(world({ posting: 'reversed' }), m).notify('pay-a', 'receipt')).action, 'skipped');
  assert.strictEqual(m.sent.length, 0);
});
t('submitted: only for a bank payment that is processing, and never after the receipt', async () => {
  const m = mailer();
  assert.strictEqual((await notifierFor(world({ methodType: 'card', settlement: 'processing' }), m).notify('pay-a', 'submitted')).action, 'skipped');
  const sb = world({ methodType: 'us_bank_account', settlement: 'processing', fee: 150, display: 'Chase ending 6789' });
  assert.strictEqual((await notifierFor(sb, m).notify('pay-a', 'submitted')).action, 'sent');
  assert.strictEqual((await notifierFor(sb, m).notify('pay-a', 'submitted')).action, 'already_sent');
  assert.strictEqual(m.sent.length, 1);
  const late = world({ methodType: 'us_bank_account', settlement: 'processing' });
  late.db.payments[0].receipt_sent_at = '2026-12-04T00:00:00Z';
  assert.strictEqual((await notifierFor(late, m).notify('pay-a', 'submitted')).action, 'skipped');
});
t('a non-bedrocktx.com sender is refused', async () => {
  const sb = world(); const m = mailer();
  const r = await createPaymentNotifier({ supabase: sb, sendEmail: m.sendEmail, fromAddress: 'notices@gmail.com', log: quiet }).notify('pay-a', 'receipt');
  assert.strictEqual(r.action, 'not_sent'); assert.strictEqual(m.sent.length, 0);
});
t('no portal user: falls back to the contact email; none at all is recorded, not sent', async () => {
  const sb = world(); sb.db.payments[0].portal_user_id = null; const m = mailer();
  await notifierFor(sb, m).notify('pay-a', 'receipt');
  assert.strictEqual(m.sent[0].to, 'contact@example.com');
  const sb2 = world(); sb2.db.payments[0].portal_user_id = null; sb2.db.payments[0].contact_id = null;
  assert.strictEqual((await notifierFor(sb2, m).notify('pay-a', 'receipt')).action, 'no_recipient');
  assert.ok(/no email/.test(sb2.db.payments[0].notice_error));
  assert.strictEqual(sb2.db.payments[0].receipt_claimed_at, null);
});
t('a payment from before migration 587 gets a confirmation number once', async () => {
  const sb = world({ confirmation: null }); const m = mailer();
  const r = await notifierFor(sb, m).notify('pay-a', 'receipt');
  assert.ok(isConfirmationNumber(r.confirmation_number));
  assert.ok(sb.db.payments.every((x) => x.confirmation_number === r.confirmation_number), 'whole group carries it');
});
t('a notifier error never throws', async () => {
  const sb = world(); const m = mailer();
  const r = await createPaymentNotifier({ supabase: sb, sendEmail: async () => { throw new Error('boom'); }, fromAddress: FROM, log: quiet }).notify('pay-a', 'receipt');
  assert.strictEqual(r.action, 'error');
  assert.strictEqual(sb.db.payments[0].receipt_claimed_at, null);
});

// ================================================================ the webhook lifecycle
// A fake store whose notifyPayment is the REAL notifier over the fake database, so the
// whole path (event -> settle -> post -> receipt) is exercised.
function lifecycleStore(sb, m, { methodType = 'card' } = {}) {
  const claimed = new Set(); const calls = { notify: [], reverse: 0, stage: 0 };
  const row = () => sb.db.payments.find((r) => r.id === 'pay-a');
  const n = notifierFor(sb, m);
  return {
    calls,
    async claimEvent(e) { if (claimed.has(e.id)) return 'done'; claimed.add(e.id); return 'claimed'; },
    async finishEvent() {},
    async settle() { const p = row(); if (p.settlement_state === 'settled') return { action: 'done', payment_id: p.id, posting_state: p.posting_state };
      p.settlement_state = 'settled'; p.settled_at = '2026-12-01T16:05:00Z'; return { action: 'post', payment_id: p.id }; },
    async postPayment() { row().posting_state = 'posted'; return { posting: 'posted' }; },
    async markProcessing() { const p = row(); if (p.settlement_state === 'awaiting_payment') { p.settlement_state = 'processing'; return { action: 'processing', payment_id: p.id }; }
      return { action: 'done', payment_id: p.id, state: p.settlement_state }; },
    async markFailed() { row().settlement_state = 'failed'; return { action: 'failed', payment_id: 'pay-a' }; },
    async findAssessmentByIntent() { return { id: 'pay-a', payment_group_id: GROUP, group_total_cents: 146786 }; },
    async reversePayment() { calls.reverse++; row().posting_state = 'reversed'; return { action: 'reversed' }; },
    async recoverDisputedFunds() { return { action: 'recovered' }; },
    async flagReview() {},
    async notifyPayment(id, kind) { calls.notify.push(kind); return n.notify(id, kind); },
    async stagePayout(p, acct) { calls.stage++; return { action: 'staged', payout_id: p.id, account: acct }; },
    async failPayout() { return { action: 'failed' }; },
  };
}
const piEvent = (id, type, extra = {}) => ({ id, type, livemode: false, created: 1764604800, data: { object: {
  id: 'pi_1', latest_charge: 'ch_1', payment_method_types: [extra.bank ? 'us_bank_account' : 'card'],
  metadata: { product_type: 'assessment_payment', payment_flow: 'payment_element', payment_group_id: GROUP }, ...(extra.obj || {}) } } });

t('card: payment_intent.succeeded sends one receipt; the same event replayed sends nothing', async () => {
  const sb = world({ settlement: 'awaiting_payment', posting: 'not_posted' }); const m = mailer(); const store = lifecycleStore(sb, m);
  const a = await processWebhookEvent(piEvent('evt_1', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  const b = await processWebhookEvent(piEvent('evt_1', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  assert.strictEqual(a.http, 200); assert.strictEqual(b.http, 200); assert.ok(b.body.duplicate);
  assert.strictEqual(m.sent.length, 1);
});
t('card: a second, different success event for the same payment sends nothing', async () => {
  const sb = world({ settlement: 'awaiting_payment', posting: 'not_posted' }); const m = mailer(); const store = lifecycleStore(sb, m);
  await processWebhookEvent(piEvent('evt_1', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  await processWebhookEvent(piEvent('evt_2', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  assert.strictEqual(m.sent.length, 1);
  assert.deepStrictEqual(store.calls.notify, ['receipt', 'receipt']);
});
t('ACH: processing sends "submitted", success sends the receipt, replays send nothing', async () => {
  const sb = world({ methodType: 'us_bank_account', settlement: 'awaiting_payment', posting: 'not_posted', fee: 150, display: 'Chase ending 6789' });
  const m = mailer(); const store = lifecycleStore(sb, m, { methodType: 'us_bank_account' });
  await processWebhookEvent(piEvent('evt_p', 'payment_intent.processing', { bank: true }), { store, mode: 'test', log: quiet });
  await processWebhookEvent(piEvent('evt_p2', 'payment_intent.processing', { bank: true }), { store, mode: 'test', log: quiet });
  assert.strictEqual(m.sent.length, 1); assert.ok(/submitted/i.test(m.sent[0].subject));
  await processWebhookEvent(piEvent('evt_s', 'payment_intent.succeeded', { bank: true }), { store, mode: 'test', log: quiet });
  await processWebhookEvent(piEvent('evt_s', 'payment_intent.succeeded', { bank: true }), { store, mode: 'test', log: quiet });
  assert.strictEqual(m.sent.length, 2); assert.ok(/receipt/i.test(m.sent[1].subject));
  assert.ok(m.sent.every((e) => e.text.includes('BP-7K3M-9QXA')));
});
t('ACH via Checkout: session completed unpaid -> submitted; async success -> receipt', async () => {
  const sb = world({ methodType: 'us_bank_account', settlement: 'awaiting_payment', posting: 'not_posted', fee: 0 });
  const m = mailer(); const store = lifecycleStore(sb, m);
  const sess = (id, type, status) => ({ id, type, livemode: false, created: 1764604800, data: { object: { id: 'cs_1', payment_status: status, payment_intent: 'pi_1', metadata: { product_type: 'assessment_payment', payment_group_id: GROUP } } } });
  await processWebhookEvent(sess('evt_c1', 'checkout.session.completed', 'unpaid'), { store, mode: 'test', log: quiet });
  await processWebhookEvent(sess('evt_c2', 'checkout.session.async_payment_succeeded', 'paid'), { store, mode: 'test', log: quiet });
  assert.deepStrictEqual(m.sent.map((e) => (/submitted/i.test(e.subject) ? 'submitted' : 'receipt')), ['submitted', 'receipt']);
});
t('refunds and disputes never send an email (and never a second receipt)', async () => {
  const sb = world(); const m = mailer(); const store = lifecycleStore(sb, m);
  await processWebhookEvent(piEvent('evt_1', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  const before = m.sent.length;
  const charge = (id, type, obj) => ({ id, type, livemode: false, created: 1764691200, data: { object: { id: 'ch_1', payment_intent: 'pi_1', ...obj } } });
  await processWebhookEvent(charge('evt_r', 'charge.refunded', { refunded: true, amount: 146786, amount_refunded: 146786 }), { store, mode: 'test', log: quiet });
  await processWebhookEvent(charge('evt_d', 'charge.dispute.created', { id: 'dp_1', charge: 'ch_1', amount: 146786 }), { store, mode: 'test', log: quiet });
  await processWebhookEvent(charge('evt_dc', 'charge.dispute.closed', { id: 'dp_1', status: 'won' }), { store, mode: 'test', log: quiet });
  await processWebhookEvent(piEvent('evt_1b', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });   // late duplicate after the refund
  assert.strictEqual(m.sent.length, before);
  assert.ok(!store.calls.notify.includes('submitted'));
});
t('a refund that arrives before the receipt was sent stops the receipt', async () => {
  const sb = world({ posting: 'reversed' }); const m = mailer(); const store = lifecycleStore(sb, m);
  sb.db.payments[0].settlement_state = 'settled';
  await processWebhookEvent(piEvent('evt_x', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  assert.strictEqual(m.sent.length, 0);
});
t('a failed bank payment sends nothing', async () => {
  const sb = world({ methodType: 'us_bank_account', settlement: 'processing' }); const m = mailer(); const store = lifecycleStore(sb, m);
  await processWebhookEvent(piEvent('evt_f', 'payment_intent.payment_failed', { bank: true, obj: { last_payment_error: { message: 'R01' } } }), { store, mode: 'test', log: quiet });
  assert.strictEqual(m.sent.length, 0);
});
t('an email outage never fails the webhook (the ledger does not wait on mail)', async () => {
  const sb = world({ settlement: 'awaiting_payment', posting: 'not_posted' }); const m = mailer({ fail: true }); const store = lifecycleStore(sb, m);
  const r = await processWebhookEvent(piEvent('evt_1', 'payment_intent.succeeded'), { store, mode: 'test', log: quiet });
  assert.strictEqual(r.http, 200);
  assert.strictEqual(sb.db.payments[0].posting_state, 'posted');
  const store2 = { ...lifecycleStore(sb, m), notifyPayment: async () => { throw new Error('mail crashed'); } };
  sb.db.payments[0].settlement_state = 'awaiting_payment';
  assert.strictEqual((await processWebhookEvent(piEvent('evt_2', 'payment_intent.succeeded'), { store: store2, mode: 'test', log: quiet })).http, 200);
});
t('payout.paid on an association account is staged; a platform payout is ignored', async () => {
  const sb = world(); const m = mailer(); const store = lifecycleStore(sb, m);
  const po = (id, account) => ({ id, type: 'payout.paid', livemode: false, created: 1764864000, ...(account ? { account } : {}), data: { object: { id: 'po_1', amount: 142500, arrival_date: 1764864000 } } });
  await processWebhookEvent(po('evt_po1', 'acct_wv'), { store, mode: 'test', log: quiet });
  const plat = await processWebhookEvent(po('evt_po2', null), { store, mode: 'test', log: quiet });
  assert.strictEqual(store.calls.stage, 1); assert.strictEqual(plat.http, 200);
  assert.strictEqual(m.sent.length, 0);
});

// ================================================================ static guard
t('no em-dash or en-dash in the receipt module\'s homeowner strings or the Pay page result text', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../lib/payments/payment_receipts.js'), 'utf8');
  const strings = src.match(/(['`])(?:\\.|(?!\1).)*\1/g) || [];
  assert.ok(!strings.some((s) => DASH_RE.test(s) && !/\\u20/.test(s)), 'dash in a string literal');
  const page = fs.readFileSync(path.join(__dirname, '../public/portal-pay.html'), 'utf8');
  const result = page.slice(page.indexOf('function showResult'), page.indexOf('function mountElement'));
  assert.ok(result.length > 100 && !DASH_RE.test(result), 'dash in the success screen text');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : `\nall ${queue.length} passed`);
  process.exit(failed ? 1 : 0);
})();
