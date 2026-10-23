// ============================================================================
// tests/test_portal_launch_gates.js — the homeowner/Board portal launch gates
// ----------------------------------------------------------------------------
// 2026-10-16 pre-launch review. Each check pins one fix so it cannot quietly
// revert before Monday's controlled launch:
//   - Pay shows only when lib/payments/payment_readiness.js says ready (Ed's
//     per-community switch, financials, Stripe charges + payouts, mode match);
//     the button and the server checkout read the SAME decision, the portal
//     fails closed, and a payment still settling shows as "processing".
//   - Portal cookies are never signed with STAFF_PASSWORD in production.
//   - Board property detail returns only what the drawer renders (no owner
//     email, no raw view row) and Board views are audit-logged.
//   - Bulk homeowner invites go to current OWNERS only, never renters.
//   - No Sign out button on the homeowner portal (Ed 2026-06-11).
// Offline: pure functions + source reads. No database, no Stripe.
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'offline-test-key';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };
const asyncChecks = [];
const acheck = (name, fn) => asyncChecks.push([name, fn]);
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- Pay gate ---------------------------------------------------------------
// The decision is lib/payments/payment_readiness.js (Stripe hardening PR); the
// portal only adapts it. These pin the adapter: it fails CLOSED when readiness
// is absent or throws, and passes the decision and the pending payment through.
const payGate = require('../lib/portal/pay_gate');
const portalSrc = read('api/portal.js');
const portalHtml = read('public/portal.html');

acheck('pay: readiness module absent → no Pay, checkout refused', async () => {
  payGate._setReadinessForTest(null);
  const st = await payGate.portalPayState({}, { communityId: 'c', propertyId: 'p' });
  assert.strictEqual(st.payments_enabled, false); assert.strictEqual(st.pending, null);
  assert.strictEqual((await payGate.portalCheckoutGate({}, 'c')).ready, false);
});
acheck('pay: readiness throws → no Pay (fails closed)', async () => {
  const boom = async () => { throw new Error('db down'); };
  payGate._setReadinessForTest({ portalPaymentState: boom, paymentsReadyFor: boom });
  assert.strictEqual((await payGate.portalPayState({}, { communityId: 'c', propertyId: 'p' })).payments_enabled, false);
  assert.strictEqual((await payGate.portalCheckoutGate({}, 'c')).ready, false);
});
acheck('pay: switch off (Waterview shape) → no Pay; reason passes through', async () => {
  const msg = 'Online payment is not turned on for this community yet.';
  payGate._setReadinessForTest({
    portalPaymentState: async () => ({ payments_enabled: false, message: msg, pending: null }),
    paymentsReadyFor: async () => ({ ready: false, reason: 'online_payments_off', message: msg }),
  });
  assert.strictEqual((await payGate.portalPayState({}, { communityId: 'c', propertyId: 'p' })).payments_enabled, false);
  const g = await payGate.portalCheckoutGate({}, 'c');
  assert.strictEqual(g.ready, false); assert.strictEqual(g.reason, 'online_payments_off'); assert.strictEqual(g.message, msg);
});
acheck('pay: ready + a processing payment → enabled, pending passed through', async () => {
  const pending = { amount_cents: 64500, since: '2026-10-16T12:00:00Z', method: 'us_bank_account', label: 'Payment processing' };
  let asked = null;
  payGate._setReadinessForTest({
    portalPaymentState: async (_sb, args) => { asked = args; return { payments_enabled: true, message: null, pending }; },
    paymentsReadyFor: async () => ({ ready: true, reason: null, message: null }),
  });
  const st = await payGate.portalPayState({}, { communityId: 'c', propertyId: 'p' });
  assert.strictEqual(st.payments_enabled, true); assert.deepStrictEqual(st.pending, pending);
  assert.deepStrictEqual(asked, { communityId: 'c', propertyId: 'p', tenureId: null });
  assert.strictEqual((await payGate.portalCheckoutGate({}, 'c')).ready, true);
  payGate._setReadinessForTest(undefined);
});

check('pay: the button and the checkout read the same readiness decision', () => {
  assert.ok(/payments_enabled: payState\.payments_enabled === true/.test(portalSrc), '/me payments_enabled must come from payment_readiness');
  assert.ok(/payment_pending: payState\.pending \|\| null/.test(portalSrc));
  assert.ok(!/payments_enabled: !!community\.stripe_connected_account_id/.test(portalSrc), 'an account id alone must not enable Pay');
  const checkout = portalSrc.slice(portalSrc.indexOf("router.post('/pay/checkout'"), portalSrc.indexOf("router.post('/autopay/begin'"));
  assert.ok(/portalCheckoutGate\(supabase, prop\.community_id\)/.test(checkout));
  assert.ok(checkout.indexOf('portalCheckoutGate') < checkout.indexOf('createAssessmentCheckout('), 'refuse before creating a session');
  assert.ok(/pending_amount_cents: r\.pending_amount_cents/.test(checkout), 'the payment_processing refusal keeps its amount');
  assert.ok(/window\._payCtx\.payments_enabled = !!\(ctx\.community && ctx\.community\.payments_enabled\)/.test(portalHtml));
});
check('pay: the portal hides Pay and says "processing" while a payment settles', () => {
  assert.ok(/id="payPendingNote"/.test(portalHtml));
  assert.ok(/&& !\(pending && pending\.amount_cents > 0\)/.test(portalHtml));
});
check('pay: one per-community switch (online_payments_enabled), no second flag', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'migrations', '540_portal_pay_enabled.sql')));
  assert.ok(!/portal_pay_enabled/.test(portalSrc + read('lib/portal/pay_gate.js')));
});


// ---- Portal cookie secret ---------------------------------------------------
const { resolvePortalSecret } = require('../api/portal');
check('cookie secret: production without PORTAL_COOKIE_SECRET refuses (no STAFF_PASSWORD fallback)', () => {
  const r = resolvePortalSecret({ NODE_ENV: 'production', STAFF_PASSWORD: 'shared', SUPABASE_KEY: 'svc' });
  assert.strictEqual(r.secret, null); assert.ok(/not set/.test(r.error));
});
check('cookie secret: PORTAL_COOKIE_SECRET equal to STAFF_PASSWORD is refused everywhere', () => {
  for (const env of ['production', 'development']) {
    assert.strictEqual(resolvePortalSecret({ NODE_ENV: env, STAFF_PASSWORD: 'same', PORTAL_COOKIE_SECRET: 'same' }).secret, null);
  }
});
check('cookie secret: a dedicated secret is used', () => {
  assert.strictEqual(resolvePortalSecret({ NODE_ENV: 'production', STAFF_PASSWORD: 'a', PORTAL_COOKIE_SECRET: 'b' }).secret, 'b');
});
check('cookie secret: local dev keeps a logged fallback', () => {
  const r = resolvePortalSecret({ NODE_ENV: 'development', STAFF_PASSWORD: 'a' });
  assert.strictEqual(r.secret, 'a'); assert.strictEqual(r.devFallback, true);
});
check('cookie secret: with no key, cookies are refused (verify returns null, not a crash)', () => {
  assert.ok(/function verifyCookie\(token\) \{\r?\n  if \(!token\) return null;\r?\n  if \(!PORTAL_SECRET\) return null;/.test(portalSrc));
  assert.ok(/function verifyMimicCookie\(token\) \{\r?\n  if \(!token\) return null;\r?\n  if \(!PORTAL_SECRET\) return null;/.test(portalSrc));
});

// ---- Board property detail --------------------------------------------------
const { projectBoardSummary } = require('../api/board_portal');
const boardSrc = read('api/board_portal.js');
check('board: property summary is projected to the drawer fields (no owner email/phone/mailing)', () => {
  const out = projectBoardSummary({
    property_id: 'p', street_address: '1 Main', owner_name: 'Pat', current_balance: 10,
    owner_email: 'pat@example.com', owner_phone: '555', owner_mailing_address: 'x', vantaca_account_id: 'v',
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ['current_balance', 'owner_name', 'property_id', 'street_address']);
});
check('board: ownership/residency history carries names only', () => {
  const detail = boardSrc.slice(boardSrc.indexOf("router.get('/property/:id'"), boardSrc.indexOf("router.get('/board-members'"));
  assert.ok(!/primary_email/.test(detail), 'owner email must not reach the board drawer');
  assert.ok(/summary: projectBoardSummary\(summary\)/.test(detail));
});
check('board: property and community views are audit-logged', () => {
  for (const a of ['board_view_property', 'board_view_summary', 'board_view_properties', 'board_view_ar', 'board_view_budget', 'board_view_violations']) {
    assert.ok(boardSrc.includes(`'${a}'`), `${a} must be logged`);
  }
  assert.ok(/from\('portal_audit_log'\)\.insert/.test(boardSrc));
});

// ---- Bulk invite: owners only ----------------------------------------------
const adminSrc = read('api/portal_admin.js');
check('invite: bulk homeowner invites are restricted to current owners', () => {
  const bulk = adminSrc.slice(adminSrc.indexOf("router.post('/community/:communityId/bulk-invite'"));
  assert.ok(/currentOwnershipsIn\(communityId, \{ contactIds: contact_ids \}\)/.test(bulk));
  assert.ok(!/from\('property_residencies'\)/.test(bulk.slice(0, bulk.indexOf("role: 'homeowner'"))), 'a residency must not qualify a homeowner invite');
  assert.ok(/from\('property_ownerships'\)[\s\S]{0,200}is\('end_date', null\)/.test(adminSrc));
});
check('invite: adoption + invite lookups are chunked (no 1,171-id URL)', () => {
  const adoption = adminSrc.slice(adminSrc.indexOf("router.get('/community/:communityId/adoption'"), adminSrc.indexOf("router.post('/community/:communityId/bulk-invite'"));
  assert.ok(!/\.in\('(property_id|id|contact_id|email)', (propertyIds|contactIds|emails)\)/.test(adoption), 'use fetchIn (chunked) for id lists');
  assert.ok(/const IN_CHUNK = 200/.test(adminSrc));
});

// ---- No Sign out on the homeowner portal ------------------------------------
check('portal: no visible Sign out button (Ed 2026-06-11)', () => {
  assert.ok(!/>\s*Sign out\s*</.test(portalHtml));
  assert.ok(!/logoutBtn/.test(portalHtml));
});

(async () => {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  }
  console.log(`\nportal_launch_gates: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
