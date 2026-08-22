// ============================================================================
// tests/test_bedrock_pay.js — Bedrock Pay names the rail; the association is paid.
// ----------------------------------------------------------------------------
// Ed 2026-08-21, watching the live sandbox checkout page say "Pay Bedrock
// Association Management LLC" for a Waterview clubhouse rental: "why is that,
// why can't we have payment going to the association." Then: "what if we call
// it Bedrock Pay" and "i want the association to be the vendor of record."
//
// Both, and they are different layers:
//
//   the EXPERIENCE is Bedrock Pay      button, receipt, confirmation, portal
//   the MERCHANT is the association    on_behalf_of on the Stripe charge
//
// The money always went to the association — transfer_data.destination sends it
// straight to their connected account and it never rests in a Bedrock balance.
// What was missing was on_behalf_of, which decides whose NAME is on the charge
// and, more importantly, WHOSE ACCOUNT EATS A DISPUTE.
//
// That last part is substance, not branding. A clubhouse rental agreement is
// between the renter and the ASSOCIATION; Bedrock signs it as managing agent,
// in a representative capacity — the same way Ed signs a landscape contract.
// If a renter disputes a $400 deposit, the party to that agreement should
// defend it on their own account, out of their own money.
//
// These tests exist because the two layers are easy to collapse back together.
// Somebody renaming things for brand consistency could put "Bedrock Pay" where
// the association's name belongs and undo the substantive half, and every
// screen would still look fine.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const brand = require('../lib/payments/brand');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const stripeSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payments', 'stripe.js'), 'utf8');
const ASSOC = 'Waterview Estates Owners Association, Inc.';

console.log('\nThe association is the merchant of record');
check('on_behalf_of is set on the charge', () => {
  assert.ok(/on_behalf_of\s*=\s*connectedAccountId/.test(stripeSrc),
    'without it Stripe treats the PLATFORM as merchant: Bedrock on the checkout page, Bedrock on the statement, and Bedrock defending a dispute over the association\'s money');
});
check('it is set alongside the transfer, not instead of it', () => {
  // transfer_data moves the money; on_behalf_of decides whose charge it is.
  // Losing either one breaks a different half.
  const block = stripeSrc.slice(stripeSrc.indexOf('if (hasHoaFee)'), stripeSrc.indexOf('// If ONLY management-company fees'));
  assert.ok(/transfer_data\s*=\s*\{\s*destination:\s*connectedAccountId\s*\}/.test(block), 'money must still route to the association');
  assert.ok(/application_fee_amount/.test(block), 'Bedrock\'s fee must still come back as an application fee');
  assert.ok(/on_behalf_of/.test(block), 'and the association must be the merchant');
});
check('only when the association is actually owed something', () => {
  // A management-company-only charge stays entirely on the platform. Naming the
  // association as merchant on money that is not theirs would be worse than the
  // bug being fixed.
  // Anchor on the ASSIGNMENT, not the first mention. The comment above it
  // explains on_behalf_of at length, and matching that tests the explanation.
  const idx = stripeSrc.indexOf('params.payment_intent_data.on_behalf_of =');
  assert.ok(idx > -1, 'the assignment must exist');
  const guard = stripeSrc.lastIndexOf('if (hasHoaFee)', idx);
  const closes = stripeSrc.indexOf('// If ONLY management-company fees', guard);
  assert.ok(guard > -1 && guard < idx && idx < closes,
    'on_behalf_of must sit inside the hasHoaFee branch');
});

console.log('\nThe statement says what the charge was FOR');
check('the suffix no longer repeats the community name', () => {
  // With the association's name leading, "WATERVIEW ESTATES* WATERVIEW" wastes
  // the one line a homeowner gets to recognise a charge weeks later.
  assert.ok(/statementSuffix/.test(stripeSrc), 'the descriptor must go through the brand helper');
  assert.strictEqual(brand.statementSuffix('AMENITY RENTAL'), 'AMENITY RENTAL');
});
check('it survives what Stripe allows', () => {
  assert.ok(brand.statementSuffix('x'.repeat(50)).length <= 22, 'Stripe caps the suffix at 22 characters');
  assert.strictEqual(brand.statementSuffix('Pool & Gate!!'), 'POOL GATE', 'punctuation is rejected by Stripe');
  assert.strictEqual(brand.statementSuffix(''), 'AMENITY', 'never empty');
  assert.strictEqual(brand.statementSuffix(null), 'AMENITY');
});

console.log('\nBedrock Pay names the way you pay, never the party paid');
check('the settlement note names the association, not us', () => {
  const s = brand.settlementNote(ASSOC);
  assert.ok(s.includes(ASSOC), 'must name the association');
  assert.ok(/never holds/.test(s), 'and say plainly that we do not hold their money');
  assert.ok(!/pay Bedrock Pay|to Bedrock Pay/i.test(s), 'Bedrock Pay is never the payee');
});
check('no double period after "Inc."', () => {
  // Association legal names end in "Inc." far more often than not, and this
  // line sits directly under a card form — where a homeowner is deciding
  // whether the page looks real.
  assert.ok(!/Inc\.\./.test(brand.settlementNote(ASSOC)));
  assert.ok(!/Inc\.\./.test(brand.receiptFooter(ASSOC)));
  assert.ok(/association\./.test(brand.settlementNote(null)), 'the no-name fallback still ends cleanly');
});
check('the receipt says who was paid and who the merchant is', () => {
  const r = brand.receiptFooter(ASSOC);
  assert.ok(r.includes(ASSOC));
  assert.ok(/merchant of record/.test(r), 'the receipt should state it outright');
  assert.ok(/Bedrock Pay/.test(r), 'and name the rail');
});
check('the handoff line names who is being paid', () => {
  const l = brand.redirectingLabel(ASSOC);
  assert.ok(l.includes(ASSOC), '"Redirecting to secure checkout" told the homeowner nothing');
  assert.ok(l.includes('Bedrock Pay'));
});

console.log('\nThe page says it before the card, not after');
check('the clubhouse form carries the note', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'clubhouse.html'), 'utf8');
  assert.ok(/id="payNote"/.test(html), 'there must be somewhere to say it');
  assert.ok(/never holds your association/.test(html), 'and it must actually say it');
  assert.ok(/Taking you to Bedrock Pay to pay/.test(html), 'the redirect names the association');
});
check('the check-paying community gets an honest line instead', () => {
  // An association that takes a check is a normal association. It must not get
  // a payment promise it cannot keep.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'clubhouse.html'), 'utf8');
  assert.ok(/takes payment by check/.test(html));
});

console.log(`\nbedrock_pay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
