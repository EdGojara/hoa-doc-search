#!/usr/bin/env node
// ============================================================================
// test_balance_asof.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// The homeowner portal's balance card must NEVER present a stale figure as
// current.
//
// THE SCAR. fmtAsOf() used to return 'As of <today>' whenever the balance came
// from the live GL (source === 'transactions'), on the assumption that a
// live-GL balance is real-time. That assumption holds only while transactions
// are actually being imported. On 2026-08-18 they were not: the newest
// transaction in EVERY community was weeks old, and Waterview — portal ON,
// 1,171 homes — had properties whose data ended 2026-03-01 while the portal
// told those owners "As of August 18, 2026."
//
// That is the worst shape a bug can take on a customer surface. The number is
// confident, plausible, and nothing about it looks broken. Nobody files a
// ticket for a wrong balance that looks right. And it is about to matter more,
// not less: once Stripe assessment payments are live, an owner paying a figure
// that is weeks stale ends up short without knowing it.
//
// THE RULE. The label always reflects the date the DATA actually ends, never
// the date the page was rendered. Past ~5 weeks (assessments post monthly) the
// wording changes from "As of" to "Reflects activity through", so the owner is
// told plainly rather than left to assume.
//
//   node tests/test_balance_asof.js     # or: npm run test:balance-asof
// ============================================================================
const fs = require('fs');
const path = require('path');

const PORTAL = path.join(__dirname, '..', 'public', 'portal.html');
const html = fs.readFileSync(PORTAL, 'utf8');

const m = html.match(/function fmtAsOf[\s\S]*?\n}/);
if (!m) {
  console.error('✗ Could not find fmtAsOf() in public/portal.html — did it get renamed?');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const fmtAsOf = new Function('bal', m[0] + '; return fmtAsOf(bal);');

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\nBalance "as of" label — never claim data is newer than it is\n');

check('fresh live-GL data reads as current', () => {
  const out = fmtAsOf({ source: 'transactions', as_of: daysAgo(2) });
  assert(/^As of /.test(out), 'expected "As of ...", got: ' + out);
});

check('7-week-old data is NOT presented as current', () => {
  const out = fmtAsOf({ source: 'transactions', as_of: daysAgo(53) });
  assert(!/As of/.test(out), 'stale balance still says "As of": ' + out);
  assert(/through/i.test(out), 'expected "Reflects activity through ...", got: ' + out);
});

check('5-month-old data is NOT presented as current (the Waterview case)', () => {
  const out = fmtAsOf({ source: 'transactions', as_of: daysAgo(170) });
  assert(/through/i.test(out), 'expected "through", got: ' + out);
});

check("today's date is never stamped on stale data", () => {
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  for (const d of [40, 60, 120, 200]) {
    const out = fmtAsOf({ source: 'transactions', as_of: daysAgo(d) });
    assert(!out.includes(todayStr), `${d}-day-old balance rendered with today's date: ${out}`);
  }
});

check('the real data date always appears in the label', () => {
  const out = fmtAsOf({ source: 'transactions', as_of: '2026-03-01' });
  assert(/March 1, 2026/.test(out), 'label omits the actual data date: ' + out);
});

check('snapshot source is labelled with its own date', () => {
  const out = fmtAsOf({ source: 'snapshot', as_of: '2026-07-30' });
  assert(/July 30, 2026/.test(out), 'got: ' + out);
});

check('missing as_of degrades honestly, never to a date', () => {
  const out = fmtAsOf({ source: 'transactions' });
  assert(/no recent snapshot/i.test(out), 'got: ' + out);
});

check('a date-only string does not slip a day in Central time', () => {
  const out = fmtAsOf({ source: 'snapshot', as_of: '2026-07-01' });
  assert(/July 1, 2026/.test(out), 'date-string boundary bug is back: ' + out);
});

check('source is not what decides the label — the date is', () => {
  const stale = fmtAsOf({ source: 'transactions', as_of: daysAgo(90) });
  const fresh = fmtAsOf({ source: 'transactions', as_of: daysAgo(1) });
  assert(stale !== fresh, 'same label for 90-day-old and 1-day-old data');
});

if (fail) {
  console.error(`\n✗ ${fail} check(s) failed.`);
  console.error('  The balance card must never present a stale figure as current.');
  console.error('  Label from bal.as_of (the date the DATA ends), never from new Date().\n');
  process.exit(1);
}
console.log(`\n✓ Balance as-of labelling: all ${pass} checks passed.\n`);
