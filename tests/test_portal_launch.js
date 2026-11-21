// Portal launch controls (Ed 2026-11-21, LOPF rollout).
const assert = require('assert');
const { renderInviteEmail } = require('../lib/email/portal_invite');
const fa = require('../lib/portal/financial_access');

// Invites promise only what the association shows. Fail-closed by default.
const line = (o) => renderInviteEmail({ toName: 'Pat Lee', communityName: 'Sample', magicLink: 'https://x/y', role: 'homeowner', ...o }).text;
assert.ok(!/balance|payment/i.test(line({})), 'no balance or payment promise by default');
assert.ok(/account balance/.test(line({ balance: true })) && !/online payments/.test(line({ balance: true })));
assert.ok(/online payments/.test(line({ balance: true, payments: true })));
assert.ok(!/online payments/.test(line({ payments: true })), 'payments are never promised without balances');

// The stamp cannot be forged or wiped by an ordinary config write.
const stamped = { balance: { status: 'live' }, homeowner_financials: { verified_at: '2026-11-21T00:00:00Z', verified_by: 'owner@example.com' } };
let next = fa.carryFinancialStamp(stamped, { balance: { status: 'live' }, compliance: { status: 'live' } });
assert.deepStrictEqual(next.homeowner_financials, stamped.homeowner_financials, 'a full replace keeps the stamp');
next = fa.carryFinancialStamp({ balance: { status: 'live' } }, { balance: { status: 'live' }, homeowner_financials: { verified_at: 'x', verified_by: 'forged' } });
assert.strictEqual(next.homeowner_financials, undefined, 'a tile edit cannot forge a stamp');
assert.strictEqual(fa.decideFinancialAccess({ portal_module_config: next }).balance, false);

// The owner switch: balances on with payments still off; off removes both.
const on = fa.balancesOnConfig({ compliance: { status: 'live' } }, { verifiedBy: 'owner@example.com', note: 'AR tied', at: '2026-11-21T00:00:00Z' });
let d = fa.decideFinancialAccess({ portal_module_config: on, stripe_connected_account_id: 'acct_1', stripe_onboarding_status: 'enabled' });
assert.deepStrictEqual([d.balance, d.payments, d.reason], [true, false, 'payments_off'], 'balances on never turns payments on');
assert.strictEqual(on.compliance.status, 'live', 'other tiles untouched');
const off = fa.balancesOffConfig(on);
d = fa.decideFinancialAccess({ portal_module_config: off });
assert.deepStrictEqual([d.balance, d.payments], [false, false]);
assert.strictEqual(off.homeowner_financials, undefined);

console.log('test_portal_launch: ok');
