// ============================================================================
// tests/test_checkout_preview_gate.js — when may the checkout preview exist?
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "i am still not seeing anything in the reservation portal" /
// "im just seeing online payments coming soon."
//
// The preview shipped gated on `!stripeLib.isConfigured()` — "are Stripe keys
// set anywhere". That was the wrong question and it made the feature DEAD ON
// ARRIVAL in production, which is the only place Ed uses it: the keys ARE set
// on Render. Walking the live site showed it plainly —
//
//     stripe_configured: true      <- keys are set
//     stripe_ready:      false     <- Waterview has no connected account
//
// so the preview refused itself, the form still showed the "coming soon" wall,
// and Ed saw exactly what he had seen before I started.
//
// The right question is whether a real charge can happen FOR THIS ASSOCIATION.
// Waterview has no connected account, so the live path 503s with
// community_stripe_not_onboarded however good the keys are — there is no real
// checkout for a preview to shadow. That also makes the gate safe by
// construction: the moment a community finishes onboarding, a real charge
// becomes possible and the preview refuses itself.
//
// Verified behaviourally against live data before shipping (keys set, Waterview
// not onboarded -> preview returns $645.00 with the onboarding blocker named;
// community onboarded -> preview 409s and checkout stops previewing). These
// checks exist so the gate cannot quietly revert to the global test.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const payments = fs.readFileSync(path.join(__dirname, '..', 'api', 'payments.js'), 'utf8');
const clubhouse = fs.readFileSync(path.join(__dirname, '..', 'public', 'clubhouse.html'), 'utf8');

console.log('\nThe gate asks about the association, not the keys');
check('the preview branch calls chargeIsImpossible', () => {
  assert.ok(/wantsPreview && await chargeIsImpossible/.test(payments),
    'the create-checkout preview branch must gate on whether a real charge is possible');
});
check('chargeIsImpossible reads the connected account', () => {
  assert.ok(/stripe_connected_account_id/.test(payments.slice(payments.indexOf('async function chargeIsImpossible'), payments.indexOf('async function chargeIsImpossible') + 700)),
    'it must check the community\'s connected account, not just the keys');
});
check('the preview endpoint refuses only an onboarded community', () => {
  assert.ok(/isConfigured\(\) && rental\.community\.stripe_connected_account_id/.test(payments),
    'GET /preview must 409 only when a REAL charge is possible for that community');
});
check('it does not refuse on keys alone', () => {
  // The exact regression: `if (stripeLib.isConfigured()) return 409`.
  assert.ok(!/if \(stripeLib\.isConfigured\(\)\) \{\s*return res\.status\(409\)/.test(payments),
    'refusing on keys alone kills the preview in production, where keys are set');
});

console.log('\nThe form is not hidden behind the missing step');
check('the "coming soon" wall is gone', () => {
  // Match the CALL, not the phrase — the phrase still appears in the comment
  // explaining why the wall was removed, and that comment is worth keeping.
  assert.ok(!/renderClosed\(\{[^}]*Online payments coming soon/.test(clubhouse),
    'a complete, working reservation form must not be hidden because one step is missing');
});
check('payment method is stated before the form is filled in', () => {
  assert.ok(/Payment is by check for now/.test(clubhouse),
    'say how payment works up front, not after they have filled everything in');
});
check('staff get a link rather than a URL to memorise', () => {
  // Ed could not find the preview because it needed ?preview=1 typed by hand.
  assert.ok(/preview the card step/i.test(clubhouse),
    'the payment preview must be reachable by clicking, not by remembering a query parameter');
});
check('the client asks for a preview when the association cannot be paid', () => {
  assert.ok(/preview: isPreview \|\| !stripeLive \|\| \(community && community\.stripe_ready === false\)/.test(clubhouse),
    'the client must request the preview when this community has no connected account');
});

console.log(`\ncheckout_preview_gate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
