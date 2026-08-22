// ============================================================================
// tests/test_refund_routing.js — the $400 deposit has to come back.
// ----------------------------------------------------------------------------
// Found 2026-08-22 while tracing the money on the first live-path booking, after
// Ed asked how Vantaca's fee model compares. Every Waterview clubhouse
// reservation carries a $400 refundable deposit, which makes this the most
// frequently exercised money path in the feature — and it had never once run,
// because no payment had ever completed.
//
// Two faults, both from treating a DESTINATION charge like a DIRECT one:
//
//  1. The refund was created with stripeAccount = the ASSOCIATION's account.
//     We create the charge on Bedrock's platform and transfer onward, so the
//     PaymentIntent belongs to the platform. The association's account has
//     never heard of it. Stripe answers "No such payment_intent" — a homeowner
//     waiting on $400, and an error naming an object nobody would think to
//     look for.
//
//  2. reverse_transfer was never passed. Without it the refund is paid out of
//     the PLATFORM balance while the association keeps the transferred money.
//     Bedrock would fund a $400 refund of the association's own deposit, and
//     nothing on any screen would say so.
//
// These assert the SHAPE of the call, not Stripe's behaviour. Sandbox would
// have caught the first fault the moment somebody clicked refund; the second
// one moves real money in the wrong direction and still looks like success.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const stripeSrc = src('lib/payments/stripe.js');
const refundFn = stripeSrc.slice(stripeSrc.indexOf('async function refund(opts'),
  stripeSrc.indexOf('async function refund(opts') + 3000);

// Mirror of the parameter logic in stripeLib.refund, so the decisions can be
// exercised directly. Kept honest by the drift check at the bottom.
function buildRefund(o) {
  const params = { payment_intent: o.paymentIntentId || 'pi_x' };
  if (o.amountCents) params.amount = o.amountCents;
  if (o.reason) params.reason = o.reason;
  const isDestination = !o.directCharge && !!o.connectedAccountId;
  if (isDestination || o.reverseTransfer) params.reverse_transfer = 'true';
  if (o.refundApplicationFee) params.refund_application_fee = 'true';
  return { params, stripeAccount: (o.directCharge && o.connectedAccountId) || undefined };
}

const ASSOC = 'acct_1U7EvhDmUc6aMLv7';

console.log('\nA destination-charge refund runs on the platform');
check('the deposit return does NOT scope to the association', () => {
  const r = buildRefund({ amountCents: 40000, connectedAccountId: ASSOC });
  assert.strictEqual(r.stripeAccount, undefined,
    'the PaymentIntent lives on the platform; scoping to the connected account is what returned "No such payment_intent"');
});
check('and it pulls the transfer back', () => {
  const r = buildRefund({ amountCents: 40000, connectedAccountId: ASSOC });
  assert.strictEqual(r.params.reverse_transfer, 'true',
    'without this Bedrock funds a refund of the association\'s own deposit');
});
check('a real direct charge still refunds on the connected account', () => {
  const r = buildRefund({ amountCents: 1000, connectedAccountId: ASSOC, directCharge: true });
  assert.strictEqual(r.stripeAccount, ASSOC);
  assert.ok(!r.params.reverse_transfer, 'there is no transfer to reverse on a direct charge');
});
check('a platform-only charge needs neither', () => {
  // A management-fee-only charge never left the platform.
  const r = buildRefund({ amountCents: 2500 });
  assert.strictEqual(r.stripeAccount, undefined);
  assert.ok(!r.params.reverse_transfer);
});

console.log('\nThe management fee comes back only when nothing was delivered');
check('returning a deposit after the event keeps it', () => {
  // The rental happened. Bedrock earned the $25.
  const r = buildRefund({ amountCents: 40000, connectedAccountId: ASSOC, refundApplicationFee: false });
  assert.ok(!r.params.refund_application_fee);
});
check('a cancelled booking gives it back', () => {
  const r = buildRefund({ amountCents: 64500, connectedAccountId: ASSOC, refundApplicationFee: true });
  assert.strictEqual(r.params.refund_application_fee, 'true');
});
check('it is never on by default', () => {
  // Keeping a fee you earned is recoverable and visible. Silently handing back
  // revenue on every deposit return is neither.
  const r = buildRefund({ amountCents: 40000, connectedAccountId: ASSOC });
  assert.ok(!r.params.refund_application_fee, 'the caller must ask for it');
});

console.log('\nThe callers say which case they are');
check('the deposit-return path states it explicitly', () => {
  const am = src('api/amenities.js');
  assert.ok(/refundApplicationFee:\s*false/.test(am),
    'the post-event deposit return must state that Bedrock keeps its fee');
});
check('the admin refund lets the operator decide', () => {
  const p = src('api/payments.js');
  assert.ok(/refundApplicationFee:\s*req\.body\.refund_application_fee === true/.test(p),
    'cancelled-vs-deposit-return is a judgement, not something to assume');
});

console.log('\nThe copy here matches the code');
check('the real refund routes destination charges to the platform', () => {
  assert.ok(/const isDestination = !directCharge && !!connectedAccountId/.test(refundFn),
    'the destination test must exist');
  assert.ok(/stripeAccount: \(directCharge && connectedAccountId\) \|\| undefined/.test(refundFn),
    'only a direct charge may scope to the connected account');
  assert.ok(/params\.reverse_transfer = 'true'/.test(refundFn));
  assert.ok(/params\.refund_application_fee = 'true'/.test(refundFn));
});

console.log(`\nrefund_routing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
