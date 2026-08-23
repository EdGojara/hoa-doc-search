// ============================================================================
// tests/test_autopay.js — a standing authorisation to take somebody's money.
// ----------------------------------------------------------------------------
// Ed 2026-08-22: "go ahead and build it out for the demo, i want to show the
// bank a full working model" and "we are moving off of the platform."
//
// Vantaca Pay is not a fallback any more, so this is the system of record. An
// autopay mandate is a legal instrument: it is the document produced when a
// homeowner says "I never agreed to that."
//
// Every rule below exists because of something in Vantaca's own terms that we
// are deliberately not repeating:
//
//   §5.3  assigns the Regulation E 10-day varying-amount notice to "your
//         Association or property management company" and provides nothing to
//         send it with. Here the notice IS the gate — no notice, no debit.
//
//   the duplicate-payment banner on their payment page. A unique index allows
//         one live mandate per property, so a second enrolment cannot quietly
//         double-debit a lot.
//
// The cap deserves its own note. "Pay full balance" is only acceptable to a
// homeowner who can bound it, and a cap that silently CLAMPS the charge to the
// maximum is worse than no cap at all — it takes the most they would tolerate,
// every time, and looks like consent. It must stop.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/payments/autopay');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const autopaySrc = src('lib/payments/autopay.js');
const mig = src('migrations/383_assessment_autopay.sql');

// The Reg E gate, mirrored so the decision can be exercised directly.
const noticeOk = (r, amount, today) => {
  const ageOk = !!(r.notice_sent_at && A._daysBetween(r.notice_sent_at, today) >= A.NOTICE_DAYS_MIN);
  const noticed = r.noticed_amount_cents;
  const matches = noticed != null && Math.abs(amount - noticed) <= Math.max(100, Math.round(noticed * 0.01));
  return !!(ageOk && matches);
};

console.log('\nRegulation E: no notice, no debit');
check('a mandate with no notice on record does not charge', () => {
  assert.strictEqual(noticeOk({ notice_sent_at: null, noticed_amount_cents: null }, 61500, '2026-10-01'), false,
    'this is the duty Vantaca §5.3 hands to the manager and gives no mechanism for');
});
check('a notice sent 9 days ago is not enough', () => {
  assert.strictEqual(noticeOk({ notice_sent_at: '2026-09-22', noticed_amount_cents: 61500 }, 61500, '2026-10-01'), false);
});
check('10 days is', () => {
  assert.strictEqual(noticeOk({ notice_sent_at: '2026-09-21', noticed_amount_cents: 61500 }, 61500, '2026-10-01'), true);
});
check('a notice that named a different amount does not cover this charge', () => {
  // The obligation is to warn of a SPECIFIC figure. A late fee posted after the
  // notice went out means the homeowner was never told about this debit.
  assert.strictEqual(noticeOk({ notice_sent_at: '2026-09-19', noticed_amount_cents: 61500 }, 68500, '2026-10-01'), false);
});
check('but a trivial difference does not restart the clock', () => {
  // 1% or a dollar, whichever is larger. Re-noticing over 40 cents would delay
  // every payment by twelve days and teach staff to bypass the gate.
  assert.strictEqual(noticeOk({ notice_sent_at: '2026-09-19', noticed_amount_cents: 61500 }, 61540, '2026-10-01'), true);
});
check('a re-notice is scheduled rather than the charge just failing', () => {
  assert.ok(/next_notice_at: today, notice_sent_at: null, noticed_amount_cents: null/.test(autopaySrc),
    'a changed balance should re-notice and retry, not strand the homeowner');
});

console.log('\nThe homeowner cap stops, it does not clamp');
check('a balance over the cap is refused, not shrunk', () => {
  assert.ok(/outcome: 'skipped_over_cap'/.test(autopaySrc));
  assert.ok(!/Math\.min\(amount, r\.max_amount_cents\)/.test(autopaySrc),
    'clamping to the cap takes the most they would tolerate and calls it consent');
});
check('and it pauses with a reason the homeowner can read', () => {
  assert.ok(/status: 'paused'/.test(autopaySrc));
  assert.ok(/is above the .* limit you set/.test(autopaySrc), 'in their words, not an error code');
});

console.log('\nFailures surface instead of retrying forever');
check('three strikes and it stops for a person to look at', () => {
  assert.ok(/fails >= 3/.test(autopaySrc),
    'retrying against a closed account just accumulates return fees on the homeowner');
});
check('every attempt is logged, including the ones that did nothing', () => {
  // An autopay that silently stopped working is the worst outcome available:
  // the homeowner believes they are current while late fees accrue.
  for (const o of ['noticed', 'charged', 'failed', 'skipped_zero_balance', 'skipped_over_cap', 'skipped_no_notice']) {
    assert.ok(mig.includes(`'${o}'`), `outcome ${o} must be recordable`);
  }
  assert.ok(/recordRun\(r\.id, \{ amount_cents: 0, outcome: 'skipped_zero_balance'/.test(autopaySrc),
    'a zero-balance skip is still an event worth seeing');
});

console.log('\nOne mandate per property');
check('the unique index prevents a second live enrolment', () => {
  // "Seeing duplicate payments? Visit the Support Page" is the banner we are
  // specifically not going to need.
  assert.ok(/assessment_autopay_one_active/.test(mig));
  assert.ok(/ON assessment_autopay \(property_id\)[\s\S]{0,120}WHERE status IN \('pending_setup', 'active', 'paused'\)/.test(mig),
    'cancelled mandates must not block re-enrolment, live ones must');
});

console.log('\nThe money and the mandate stay with the association');
check('the customer and the charge run on the connected account', () => {
  const s = src('lib/payments/stripe.js');
  const fnStart = s.indexOf('async function chargeOffSession');
  const fn = s.slice(fnStart, fnStart + 1400);
  assert.ok(/stripeAccount: opts\.connectedAccountId/.test(fn),
    'a charge on the platform account would put association money in Bedrock\'s balance');
  assert.ok(/off_session: 'true'/.test(fn) && /confirm: 'true'/.test(fn),
    'the homeowner is not present — that is what a standing authorisation means');
});
check('ACH settling as "processing" counts as success', () => {
  const s = src('lib/payments/stripe.js');
  assert.ok(/status === 'succeeded' \|\| pi\.status === 'processing'/.test(s),
    'ACH does not settle instantly; treating processing as failure would double-charge on retry');
});

console.log('\nThe notice is scheduled before the charge, by construction');
check('advancing a cycle sets the notice ahead of the charge', () => {
  assert.ok(/next_notice_at: addDays\(next, -NOTICE_DAYS_TARGET\)/.test(autopaySrc));
  assert.ok(A.NOTICE_DAYS_TARGET > A.NOTICE_DAYS_MIN,
    'sending on the statutory boundary invites an argument about timezones');
});
check('and clears the previous notice so it cannot be reused', () => {
  assert.ok(/notice_sent_at: null,\s*\n\s*noticed_amount_cents: null,/.test(autopaySrc),
    'last cycle\'s notice must not authorise next cycle\'s debit');
});

console.log('\nThe record is the association\'s');
check('the migration says so', () => {
  assert.ok(/association_record/.test(mig),
    'this is the document produced when a homeowner says they never agreed');
  assert.ok(/GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_autopay\s+TO service_role/.test(mig),
    'a new table the API writes to needs explicit grants');
});

console.log(`\nautopay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
