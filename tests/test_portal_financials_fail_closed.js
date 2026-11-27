// Homeowner balances and online payment are fail-closed, per association (Ed 2026-11-16):
// off until an association's balances are verified and payments are switched on; a
// connected Stripe account alone never enables Pay. lib/portal/financial_access.js.
'use strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const FA = require('../lib/portal/financial_access');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13)).join('');

const verified = { verified_at: '2026-12-01T00:00:00Z', verified_by: 'Ed Gojara' };
const base = { id: 'c', is_demo: false, stripe_connected_account_id: 'acct_x', stripe_onboarding_status: 'enabled' };
const d = (cfg, over = {}) => FA.decideFinancialAccess({ ...base, ...over, portal_module_config: cfg });

console.log('decision');
check('a connected, enabled Stripe account alone: no balance, no Pay', !d({}).balance && !d({}).payments);
check('a missing or malformed config: off', !d(null).balance && !d('x').payments && !FA.decideFinancialAccess(null).balance);
check('Waterview today (balance tile live, nothing verified): no balance, no Pay', (() => { const r = d({ balance: { status: 'live' } }); return !r.balance && !r.payments && r.reason === 'balances_not_verified'; })());
check('a verification stamp without the balance tile switched on: off', !d({ homeowner_financials: { ...verified, payments: true } }).balance);
check('a half stamp (no verified_by) is not verification', !d({ balance: { status: 'live' }, homeowner_financials: { verified_at: '2026-12-01' } }).balance);
check('verified balances, payments not switched on: balance yes, Pay no', (() => { const r = d({ balance: { status: 'live' }, homeowner_financials: verified }); return r.balance && !r.payments; })());
check('payments switched on but Stripe onboarding not enabled: no Pay', !d({ balance: { status: 'live' }, homeowner_financials: { ...verified, payments: true } }, { stripe_onboarding_status: 'in_progress' }).payments);
check('payments switched on, no connected account: no Pay', !d({ balance: { status: 'live' }, homeowner_financials: { ...verified, payments: true } }, { stripe_connected_account_id: null }).payments);
check('everything explicit: balance and Pay', (() => { const r = d({ balance: { status: 'live' }, homeowner_financials: { ...verified, payments: true } }); return r.balance && r.payments; })());
check('payments must be literally true (a string is not a switch)', !d({ balance: { status: 'live' }, homeowner_financials: { ...verified, payments: 'yes' } }).payments);
check('the demo community keeps its sample balance', FA.decideFinancialAccess({ is_demo: true, stripe_connected_account_id: 'acct_demo' }).balance);

console.log('presentation');
{
  const p = FA.presentedModuleConfig({ balance: { status: 'live' }, arc: { status: 'live' }, homeowner_financials: verified }, { balance: false });
  check('the browser gets the balance tile hidden and every other tile unchanged', p.balance.status === 'hidden' && p.arc.status === 'live');
  check('the verification stamp never reaches the browser', !('homeowner_financials' in p));
}

console.log('lookup');
(async () => {
  const fakeErr = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
  const r = await FA.financialAccessFor(fakeErr, 'c');
  check('a lookup failure refuses (never a pass)', !r.balance && !r.payments && r.reason === 'lookup_failed');
  const r2 = await FA.financialAccessFor(fakeErr, null);
  check('no association: refuses', !r2.balance && !r2.payments);

  console.log('wiring');
  const portal = src('api/portal.js');
  check('portal home: no balance sent unless allowed', portal.includes("if (!financialAccess.balance) balance = { status: 'hidden', amount_cents: null, as_of: null };"));
  check('portal home: Pay follows the gate, not the connected account', portal.includes('payments_enabled: financialAccess.payments,') && !portal.includes('payments_enabled: !!community.stripe_connected_account_id'));
  check('portal home: the tile config sent to the browser is the gated one', portal.includes("portal_module_config: require('../lib/portal/financial_access').presentedModuleConfig(community.portal_module_config, financialAccess),"));
  const guards = portal.match(/if \(!access\.balance\) return res\.status\(403\)\.json\(\{ error: 'balance_not_available'/g) || [];
  check('GET /balance and GET /transactions refuse (403) when balances are off', guards.length === 2
    && portal.indexOf("router.get('/balance'") < portal.indexOf("error: 'balance_not_available'")
    && portal.lastIndexOf("error: 'balance_not_available'") > portal.indexOf("router.get('/transactions'"));
  const ck = src('lib/payments/assessment_checkout.js');
  check('every homeowner checkout (portal Pay, pay link) is refused server-side unless payments are allowed', ck.includes("return { ok: false, status: 403, error: 'online_payments_not_enabled'")
    && ck.indexOf("error: 'online_payments_not_enabled'") < ck.indexOf('const amount = testAmountCents'));
  check('only the demo payment-sandbox lot skips the association gate', ck.includes('if (identity.property.payment_sandbox !== true) {'));
  check('the pay link shows "not available yet" for the refusal', src('server.js').includes("r.error === 'online_payments_not_enabled'"));
  check('the portal hides the balance stat when the server hides the balance', src('public/portal.html').includes("balVal.closest('.stat').style.display = bal.status === 'hidden' ? 'none' : '';"));

  // Claire (phone and portal) quotes a balance only through the same decision.
  const vt = src('lib/voice/tools.js');
  check('Claire balance lookup refuses unless the association shows balances', vt.includes('financialAccessFor(supabase, communityRow.id)')
    && vt.indexOf('if (!access.balance)') > -1 && vt.indexOf('if (!access.balance)') < vt.indexOf('resolveCurrentAR(supabase'));
  const cc = src('lib/claire/caller_context.js');
  check('Claire caller context loads a balance only when balances are on', cc.includes('const bal = (!includeBalance || !access.balance) ? null :'));

  console.log(`\nportal financials fail-closed: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
