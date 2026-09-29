#!/usr/bin/env node
// ============================================================================
// tests/test_operator_briefing.js  (Issue #6, 2026-09-29)
// ----------------------------------------------------------------------------
// Locks the Operator Home briefing rules (public/app/briefing.js):
//   1. a FAILED source is never shown as healthy or as zero;
//   2. /api/today's own failed inbox section is a problem, not "clear";
//   3. receivables only "match the GL" on an exact $0.00 difference;
//   4. exceptions sort ahead of routine work; a cash shortfall leads;
//   5. payables are scoped to the selected community;
//   6. the headline counts problems + items and never claims more than it checked.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { buildBriefing, money } = require('../public/app/briefing.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const C1 = 'c1', C2 = 'c2';
const ok = (data) => ({ ok: true, data });
const clearMail = ok({ total_pending: 0, summary: { locked_first_class: 0, locked_certified: 0, locked_batches: [] } });
const clearPay = ok({ invoices: [], cash: [] });
const clearToday = ok({ inbox: { count: 0, items: [] }, section_errors: {} });

console.log('test_operator_briefing');

t('all clear → no items, three healthy, honest headline', () => {
  const b = buildBriefing({ mail: clearMail, payables: clearPay, today: clearToday }, { communityId: C1, isOwner: true });
  assert.strictEqual(b.items.length, 0);
  assert.strictEqual(b.problems.length, 0);
  assert.deepStrictEqual(b.healthy.map((h) => h.key), ['mail', 'payables', 'inbox']);
  assert.strictEqual(b.headline, 'Nothing needs you right now.');
  assert.ok(/Mail Queue, Payables and the homeowner inbox are clear/.test(b.subline));
});

t('failed source is a problem row, never healthy', () => {
  const b = buildBriefing({ mail: { ok: false, error: 'HTTP 500' }, payables: clearPay, today: clearToday }, { communityId: C1 });
  assert.strictEqual(b.problems.length, 1);
  assert.strictEqual(b.problems[0].key, 'mail');
  assert.ok(!b.healthy.some((h) => h.key === 'mail'), 'failed Mail Queue must not appear as clear');
  assert.strictEqual(b.headline, 'One thing needs you.');
});

t('missing source (never loaded) is a problem row', () => {
  const b = buildBriefing({ mail: clearMail, today: clearToday }, {});
  assert.ok(b.problems.some((p) => p.key === 'payables'));
});

t("today's failed inbox section is a problem, not 'clear'", () => {
  const today = ok({ inbox: { count: 0, items: [] }, section_errors: { inbox: 'permission denied' } });
  const b = buildBriefing({ mail: clearMail, payables: clearPay, today }, {});
  assert.ok(b.problems.some((p) => p.key === 'inbox'));
  assert.ok(!b.healthy.some((h) => h.key === 'inbox'));
});

t('locked letters → confirm-mailed item that points at the post-print check', () => {
  const mail = ok({ total_pending: 0, summary: { locked_first_class: 9, locked_certified: 0, locked_batches: [{ printed_at: '2026-09-28T18:05:00Z' }] } });
  const b = buildBriefing({ mail, payables: clearPay, today: clearToday }, {});
  assert.strictEqual(b.items[0].key, 'mail_locked');
  assert.ok(/Confirm 9 printed letters were mailed/.test(b.items[0].title));
  assert.ok(/post-print check/.test(b.items[0].detail));
});

t('cash shortfall leads and replaces the routine release item', () => {
  const payables = ok({
    invoices: [{ community_id: C1, vendor: 'V', total_cents: 50000 }],
    cash: [{ community_id: C1, count: 1, pending_cents: 50000, operating_cash_cents: 10000, covered: false }],
  });
  const mail = ok({ total_pending: 3, summary: { first_class_mail: 3, locked_first_class: 0, locked_certified: 0 } });
  const b = buildBriefing({ mail, payables, today: clearToday }, { communityId: C1, isOwner: true });
  assert.strictEqual(b.items[0].key, 'payables_cash');
  assert.ok(!b.items.some((i) => i.key === 'payables'));
});

t('payables are scoped to the selected community', () => {
  const payables = ok({ invoices: [{ community_id: C2, vendor: 'Other', total_cents: 999 }], cash: [] });
  const b = buildBriefing({ mail: clearMail, payables, today: clearToday }, { communityId: C1, isOwner: true });
  assert.ok(!b.items.some((i) => i.key === 'payables'));
  assert.ok(b.healthy.some((h) => h.key === 'payables'));
});

t('late inbox threads rank ahead of printing', () => {
  const today = ok({ inbox: { count: 2, capped: false, items: [{ sla: 'overdue' }, { sla: 'green' }] }, section_errors: {} });
  const mail = ok({ total_pending: 4, summary: { first_class_mail: 4, locked_first_class: 0, locked_certified: 0 } });
  const b = buildBriefing({ mail, payables: clearPay, today }, {});
  assert.deepStrictEqual(b.items.map((i) => i.key), ['inbox', 'mail_pending']);
});

t('capped inbox says "10+" rather than exactly 10', () => {
  const today = ok({ inbox: { count: 10, capped: true, items: [] }, section_errors: {} });
  const b = buildBriefing({ mail: clearMail, payables: clearPay, today }, {});
  assert.ok(/Answer 10\+ homeowner threads/.test(b.items[0].title));
});

const ctl = (over) => ok(Object.assign({ subledger_cents: 10000, accounts: 5, owners_owing: 3, owners_in_credit: 1,
  gl_1300_2400_net_cents: 10000, gl_accounts_found: 2, diff_cents: 0, conversion: { ready: true }, ties: true }, over));

t('receivables tie to the GL only when the server says it ties (exact $0.00, converted)', () => {
  assert.strictEqual(buildBriefing({ control: ctl() }, {}).receivables.gl.state, 'match');
  const off = buildBriefing({ control: ctl({ gl_1300_2400_net_cents: 9999, diff_cents: 1, ties: false }) }, {}).receivables;
  assert.strictEqual(off.gl.state, 'diff');
  assert.ok(/difference \$0\.01/.test(off.gl.text));
});

t('unconverted community shows NO GL difference (never validate unconverted)', () => {
  const r = buildBriefing({ control: ctl({ gl_1300_2400_net_cents: 20000, diff_cents: -10000, ties: false, conversion: { ready: false } }) }, {}).receivables;
  assert.strictEqual(r.gl.state, 'none');
  assert.ok(!/difference/.test(r.gl.text), 'must not print a difference for an unconverted community');
});

t('no owner ledger is stated, not shown as $0 tying to the GL', () => {
  const r = buildBriefing({ control: ctl({ subledger_cents: 0, accounts: 0, gl_1300_2400_net_cents: 0, diff_cents: 0, ties: false, conversion: { ready: false } }) }, {}).receivables;
  assert.strictEqual(r.gl.state, 'none');
});

t('failed receivables read is an error card, not $0.00', () => {
  const r = buildBriefing({ control: { ok: false, error: 'HTTP 500' } }, {}).receivables;
  assert.strictEqual(r.ok, false);
});

t('money formats negatives in parentheses', () => {
  assert.strictEqual(money(-12345), '($123.45)');
  assert.strictEqual(money(5870704), '$58,707.04');
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
