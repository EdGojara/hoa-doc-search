#!/usr/bin/env node
// ============================================================================
// test_ap_approval_pattern.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// "Release approve: consistent with expectations AND recurring." Consistent has
// to mean the same KIND of bill, not merely a similar number.
//
// THE SCAR (Canyon Gate, 2026-10-15): Earthcare's monthly landscape bill is
// $8,842.68. Its #1348 was $9,593.75 of irrigation repairs (57 lines like
// "Clock A Zone 5 - Replace 2in valve"), within 25% of the monthly bill, so the
// approval path called it "Recurring monthly and consistent with expectations"
// and routed it to release. And Star Protection's half-size $2,459.84 week read
// as normal against a "typical $326.01 per bill", the median of its LINES.
//
//   node tests/test_ap_approval_pattern.js
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const { descriptionMatch } = require('../lib/ap/bill_pattern');
const { approvalPath } = require('../lib/ap/approval_policy');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

// What Earthcare's prior Canyon Gate bills said (ap_invoice_lines, as on file).
const EARTHCARE_PRIOR = [
  'July landscape maintenance service at Canyon Gate at Cinco Ranch (3 trips)', 'Sales Tax',
  'August landscape maintenance service at Canyon Gate at Cinco Ranch', 'Sales Tax',
  'Sept. landscape maintenance service at Canyon Gate at Cinco Ranch', 'Sales Tax',
  'Remove 1 dead pine tree, stump grind 2 stumps. 6302 Marina Canyon Way. DM-1-75', 'Sales Tax',
];
const IGNORE = 'Canyon Gate at Cinco Ranch Earthcare Management, Inc.';
const L1348 = [
  { description: 'Clock A Zone 1 - Replace 12" worn out popup.', amount_cents: 3828 },
  { description: 'Clock A Zone 5 - Replace 2" valve that is not working.', amount_cents: 57815 },
  { description: 'Clock C - Main Street Zone 25 - Repair lateral line break.', amount_cents: 12389 },
  { description: 'Clock E - Canyon Gate Ct. & Marina Canyon Way Zone 2 - Repair lateral line break.', amount_cents: 12389 },
  { description: 'Clock F Zone 2-8 - Broken Wires.', amount_cents: 179100 },
];

t('Earthcare #1348 (irrigation repairs) does not match its monthly landscape bills', () => {
  const m = descriptionMatch({ lines: L1348, priorTexts: EARTHCARE_PRIOR, ignoreText: IGNORE });
  assert.strictEqual(m.checked, true); assert.strictEqual(m.matched, false);
  assert.match(m.summary, /100% of this bill is for work that doesn't appear/);
});

t('one shared street name ("Marina Canyon Way") is a location, not the same work', () => {
  const m = descriptionMatch({ lines: [L1348[3]], priorTexts: EARTHCARE_PRIOR, ignoreText: IGNORE });
  assert.strictEqual(m.matched, false);
});

t('Earthcare\'s October monthly bill matches', () => {
  const m = descriptionMatch({ lines: [{ description: 'October landscape maintenance service at Canyon Gate at Cinco Ranch', amount_cents: 816875 }, { description: 'Sales Tax', amount_cents: 67393 }], priorTexts: EARTHCARE_PRIOR, ignoreText: IGNORE });
  assert.strictEqual(m.matched, true);
});

t('Star Protection\'s weekly lines match its prior weeks', () => {
  const prior = ['Noncomm Regular — 128.00 Hours @ $22.85', 'Site Supervisor Regular — 40.00 Hours @ $25.25', 'Phone — 1.00 Each @ $16.62', 'Sales Tax'];
  const m = descriptionMatch({ lines: [{ description: 'Noncomm Regular', amount_cents: 165091 }, { description: 'Site Supervisor Regular', amount_cents: 60480 }, { description: 'Phone', amount_cents: 1665 }], priorTexts: prior, ignoreText: 'Star Protection Agency LLC' });
  assert.strictEqual(m.matched, true);
});

t('no words to compare (no lines, or only generic prior memos like "Invoice 117311"): no verdict', () => {
  assert.strictEqual(descriptionMatch({ lines: [], priorTexts: EARTHCARE_PRIOR }).checked, false);
  assert.strictEqual(descriptionMatch({ lines: L1348, priorTexts: ['Invoice 117311', 'Sales Tax'] }).checked, false);
  assert.strictEqual(descriptionMatch({}).checked, false);
});

const REC = { recurring: true, cadence: 'monthly', months_covered: 4, typical_cents: 884268, amount_flag: 'normal', variance_pct: 8 };

t('approval path: recurring + amount normal + NOT the usual kind of bill -> manager_review (the #1348 fix)', () => {
  const dm = descriptionMatch({ lines: L1348, priorTexts: EARTHCARE_PRIOR, ignoreText: IGNORE });
  const p = approvalPath({ ...REC, description_match: dm }, []);
  assert.strictEqual(p.path, 'manager_review');
  assert.match(p.reason, /doesn't match its usual bills here/);
});

t('approval path: recurring + amount normal + same kind of bill -> release (unchanged)', () => {
  assert.strictEqual(approvalPath({ ...REC, description_match: { checked: true, matched: true } }, []).path, 'release');
});

t('approval path: no description verdict -> the amount test alone, as before', () => {
  assert.strictEqual(approvalPath({ ...REC, description_match: { checked: false, matched: null } }, []).path, 'release');
  assert.strictEqual(approvalPath(REC, []).path, 'release');
  assert.strictEqual(approvalPath({ ...REC, amount_flag: 'low', variance_pct: -42 }, []).path, 'manager_review');
});

t('approval path: an owed credit still outranks everything', () => {
  const p = approvalPath({ ...REC, description_match: { checked: true, matched: true } }, [{ reason: 'pool closed', expected_cents: 147000 }]);
  assert.strictEqual(p.path, 'manager_review'); assert.strictEqual(p.credit_hold, true);
});

t('the recurrence profile judges BILLS (one journal entry each), never single lines, and never the bill itself', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/ap/recurring'), 'utf8');
  assert.ok(/const key = je \|\|/.test(src), 'history is grouped by journal entry');
  assert.ok(/excludeJournalEntryId && je === excludeJournalEntryId/.test(src), 'the bill never cites itself');
  assert.ok(/billedAboutThisBefore = postings\.some\(\(c\) => Math\.abs\(totalCents - c\) <= 0\.1 \* c\)/.test(src), 'normal = a prior bill within 10%, not a percentile band');
  for (const caller of ['../lib/ap/intake', '../api/ap', '../scripts/backfill_ap_approval_path']) {
    const s = require('fs').readFileSync(require.resolve(caller), 'utf8');
    assert.ok(/lines:/.test(s) && /accountNumber:/.test(s), `${caller} passes the bill's lines and account to the profile`);
  }
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message.split('\n').join('\n      ')); }
  }
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} approval-pattern checks passed`);
  process.exit(failed ? 1 : 0);
})();
