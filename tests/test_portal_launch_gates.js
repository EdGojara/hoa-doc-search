// ============================================================================
// tests/test_portal_launch_gates.js — the homeowner/Board portal launch gates
// ----------------------------------------------------------------------------
// 2026-10-16 pre-launch review. Each check pins one fix so it cannot quietly
// revert before Monday's controlled launch:
//   - Pay shows only when Ed's per-community switch is on AND Stripe is truly
//     ready (charges + payouts, live in production) AND financials are active;
//     the button and the server checkout read the SAME decision.
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
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- Pay gate ---------------------------------------------------------------
const { evaluatePayGate, serverKeyMode } = require('../lib/portal/pay_gate');
const READY = {
  community: { id: 'c1', name: 'Quail Ridge', portal_pay_enabled: true, stripe_connected_account_id: 'acct_1' },
  lifecycle: { allowed: true },
  stripe: { ok: true, charges_enabled: true, payouts_enabled: true },
  keyMode: 'live',
  isProduction: true,
};
const gate = (over) => evaluatePayGate({ ...READY, ...over });

check('pay: every condition met → enabled', () => assert.strictEqual(gate({}).enabled, true));
check('pay: switch off (the default) → no Pay, even with Stripe fully ready', () => {
  const r = gate({ community: { ...READY.community, portal_pay_enabled: false } });
  assert.strictEqual(r.enabled, false); assert.strictEqual(r.code, 'pay_not_enabled');
  assert.strictEqual(gate({ community: { ...READY.community, portal_pay_enabled: undefined } }).enabled, false,
    'a missing column (migration 540 not applied) must read as off');
});
check('pay: Waterview shape (account exists, switch off) → no Pay', () => {
  assert.strictEqual(gate({ community: { id: 'wv', name: 'Waterview', stripe_connected_account_id: 'acct_wv', portal_pay_enabled: false } }).enabled, false);
});
check('pay: financials switched off → no Pay', () => {
  const r = gate({ lifecycle: { allowed: false, reason: 'Online payments are switched off for X.' } });
  assert.strictEqual(r.enabled, false); assert.strictEqual(r.code, 'community_not_taking_payments');
});
check('pay: no connected account → no Pay', () => {
  assert.strictEqual(gate({ community: { ...READY.community, stripe_connected_account_id: null } }).code, 'stripe_not_onboarded');
});
check('pay: charges enabled but payouts not → no Pay', () => {
  assert.strictEqual(gate({ stripe: { ok: true, charges_enabled: true, payouts_enabled: false } }).code, 'stripe_onboarding_incomplete');
});
check('pay: account not retrievable with this key (other mode / deleted) → no Pay', () => {
  assert.strictEqual(gate({ stripe: { ok: false, error: 'No such account' } }).code, 'stripe_account_unavailable');
});
check('pay: production with a TEST key → no Pay', () => {
  assert.strictEqual(gate({ keyMode: 'test' }).code, 'stripe_not_live');
  assert.strictEqual(gate({ keyMode: 'test', isProduction: false }).enabled, true, 'local/staging may use test mode');
  assert.strictEqual(gate({ keyMode: null }).code, 'stripe_not_configured');
});
check('pay: key mode read from the key prefix', () => {
  assert.strictEqual(serverKeyMode('sk_live_abc'), 'live');
  assert.strictEqual(serverKeyMode('rk_live_abc'), 'live');
  assert.strictEqual(serverKeyMode('sk_test_abc'), 'test');
  assert.strictEqual(serverKeyMode(''), null);
});

const portalSrc = read('api/portal.js');
const portalHtml = read('public/portal.html');
check('pay: the button and the checkout read the same gate', () => {
  assert.ok(/payments_enabled: payGate\.enabled === true/.test(portalSrc), '/me payments_enabled must come from the pay gate');
  assert.ok(!/payments_enabled: !!community\.stripe_connected_account_id/.test(portalSrc), 'an account id alone must not enable Pay');
  const checkout = portalSrc.slice(portalSrc.indexOf("router.post('/pay/checkout'"), portalSrc.indexOf("router.post('/autopay/begin'"));
  assert.ok(/portalPayGateForCommunityId\(supabase, prop\.community_id, \{ fresh: true \}\)/.test(checkout), 'checkout must re-check the gate fresh');
  assert.ok(checkout.indexOf('portalPayGateForCommunityId') < checkout.indexOf('createAssessmentCheckout('), 'refuse before creating a session');
  assert.ok(/window\._payCtx\.payments_enabled = !!\(ctx\.community && ctx\.community\.payments_enabled\)/.test(portalHtml));
});
check('pay: migration 540 defaults the switch OFF and turns it on for nobody', () => {
  const mig = read('migrations/540_portal_pay_enabled.sql');
  assert.ok(/portal_pay_enabled BOOLEAN NOT NULL DEFAULT FALSE/.test(mig));
  assert.ok(!/UPDATE\s+communities/i.test(mig), 'no migration may enable portal pay');
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

console.log(`\nportal_launch_gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
