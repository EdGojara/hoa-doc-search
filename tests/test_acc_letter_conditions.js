// ============================================================================
// tests/test_acc_letter_conditions.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// Conditions in a drafted ACC letter must have a real basis and must not be
// built on dates that have already passed.
// Scar (WAT-ARC-2026-0025): the re-review draft added
//   6. "You are solely responsible for determining whether any ... permit is
//       required" (no governing-document basis), and
//   7. "Please notify our office if your completion date extends beyond
//       September 15, 2026." (written on October 2).
// lib/acc/letter_checks.js removes both kinds deterministically from every
// generated draft (engine, re-review, redraft) and records what it removed;
// legitimate document-based conditions survive. Nothing case-specific is
// hard-coded.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pruneConditions, datesIn } = require('../lib/acc/letter_checks');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const OCT2 = '2026-10-02T20:00:00Z';
const nums = (t) => (t.match(/^\s*\d+\.\s.*$/gm) || []).map((l) => l.trim());

const SHAPE = [
  'Dear Mr. Lee and Ms. Park,',
  '',
  'Your application for the replacement of your driveway is approved, subject to the following conditions:',
  '',
  '1. Work shall stay within the footprint described in your application.',
  '2. Finished concrete shall be a minimum of 4 inches thick, consistent with Section 3.4 of the Riverbend Declaration.',
  '3. Finished grades shall drain toward the street and not toward adjacent lots, consistent with Section 3.3 of the Riverbend Declaration.',
  '4. You are solely responsible for determining whether any county or municipal permit is required and for obtaining it before work begins.',
  '5. Please notify our office if your completion date extends beyond September 15, 2026.',
  '',
  'Please retain a copy of this letter for your records.',
].join('\n');

check('the Sweetspire shape: expired completion date and unsupported permit boilerplate are removed; 1-3 survive and stay numbered', () => {
  const r = pruneConditions(SHAPE, { reviewDate: OCT2 });
  assert.deepStrictEqual(r.removed.map((x) => x.reason), ['unsupported_boilerplate', 'expired_date']);
  assert.deepStrictEqual(nums(r.text).map((l) => l.slice(0, 2)), ['1.', '2.', '3.']);
  assert.ok(/Section 3\.4 of the Riverbend Declaration/.test(r.text) && /Section 3\.3 of the Riverbend Declaration/.test(r.text));
  assert.ok(!/September 15, 2026/.test(r.text) && !/permit/i.test(r.text));
  assert.ok(/Please retain a copy/.test(r.text), 'non-condition text untouched');
});
check('an application date that is still in the FUTURE is kept', () => {
  const r = pruneConditions('1. Please notify our office if your completion date extends beyond December 15, 2026.', { reviewDate: OCT2 });
  assert.strictEqual(r.removed.length, 0);
});
check('expired dates in numeric and ISO formats are caught too; the review date is compared in Central time', () => {
  assert.strictEqual(pruneConditions('1. Complete the work by 9/15/2026.', { reviewDate: OCT2 }).removed.length, 1);
  assert.strictEqual(pruneConditions('1. Work must be completed before 2026-09-30.', { reviewDate: OCT2 }).removed.length, 1);
  assert.deepStrictEqual(datesIn('Sept. 15, 2026 and 10/01/2026'), [Date.UTC(2026, 8, 15), Date.UTC(2026, 9, 1)]);
});
check('a past date that is NOT a future-facing deadline (e.g. a reference to when something was submitted) is kept', () => {
  const r = pruneConditions('1. The color shall match the sample you submitted on September 1, 2026.', { reviewDate: OCT2 });
  assert.strictEqual(r.removed.length, 0);
});
check('a permit condition WITH a governing-document basis survives; one the staff instructions ask for survives', () => {
  const cited = '1. A pool permit is required under Section 5.2 of the Declaration before excavation.';
  assert.strictEqual(pruneConditions(cited, { reviewDate: OCT2 }).removed.length, 0);
  const asked = '1. You must obtain the City building permit before construction.';
  assert.strictEqual(pruneConditions(asked, { reviewDate: OCT2, staffInstructions: 'add: city permit required' }).removed.length, 0);
  assert.strictEqual(pruneConditions(asked, { reviewDate: OCT2 }).removed.length, 1, 'no basis -> removed');
});
check('the bare word "section" is not a citation: a permit condition about "the sidewalk section" is still removed (live re-review shape)', () => {
  const t = '5. The homeowner is solely responsible for determining whether Fort Bend County or the City of Richmond requires a permit for work within the public right-of-way (the sidewalk section) and for obtaining any such permit before or concurrent with that portion of the work. This HOA approval does not constitute or replace any required governmental authorization.';
  const r = pruneConditions(t, { reviewDate: OCT2 });
  assert.strictEqual(r.removed.length, 1); assert.strictEqual(r.removed[0].reason, 'unsupported_boilerplate');
  assert.strictEqual(pruneConditions('1. A permit is required under Article IV of the Declaration.', { reviewDate: OCT2 }).removed.length, 0, 'a real Article citation still counts');
  assert.strictEqual(pruneConditions('1. A permit is required per § 7 of the rules.', { reviewDate: OCT2 }).removed.length, 0, '§ citation counts');
});
check('licensing / insurance / liability boilerplate without a basis is removed', () => {
  for (const t of ['1. Contractor must be licensed and insured.', '1. Homeowner assumes all liability for the work.', '1. You agree to indemnify the association.']) {
    assert.strictEqual(pruneConditions(t, { reviewDate: OCT2 }).removed[0].reason, 'unsupported_boilerplate', t);
  }
});
check('multi-line conditions are handled as one item; a letter with nothing to remove comes back byte-identical', () => {
  const ml = '1. Work shall stay within the footprint.\n2. Please notify our office if completion\n   extends beyond August 1, 2026.\n3. Curbs shall not be altered.';
  const r = pruneConditions(ml, { reviewDate: OCT2 });
  assert.deepStrictEqual(nums(r.text), ['1. Work shall stay within the footprint.', '2. Curbs shall not be altered.']);
  const clean = 'Dear X,\n\n1. Keep the footprint.\n2. Match the existing color.\n';
  assert.strictEqual(pruneConditions(clean, { reviewDate: OCT2 }).text, clean);
});
check('wired into every generated draft: engine (incl. re-review) and redraft; removals recorded, never silent', () => {
  const s = src('server.js');
  const eng = s.slice(s.indexOf('async function assessAndDraftAcc'), s.indexOf("app.post('/acc-review', upload.any()"));
  assert.ok(/pruneConditions\(letterBody, \{ reviewDate: new Date\(\)/.test(eng) && /letter_pruned: _pruned\.removed/.test(eng));
  const rd = s.slice(s.indexOf("app.post('/acc-review/decisions/:id/redraft'"), s.indexOf("app.post('/acc-review/render-letter'"));
  assert.ok(/pruneConditions\(bodyText, \{ reviewDate: new Date\(\), staffInstructions: instructions \}\)/.test(rd) && /removed_conditions: _pr\.removed/.test(rd));
  assert.ok(/removed_conditions: Array\.isArray\(out\.letter_pruned\)/.test(src('lib/acc/documents.js')));
});
check('prompts: no reflexive permit disclaimer anywhere; minimum-necessary condition basis + date rules present', () => {
  const s = src('server.js');
  assert.ok(!/standard permit disclaimer/.test(s) && !/always include permit disclaimer/.test(s));
  assert.ok((s.match(/use the MINIMUM necessary conditions\. Every condition must have a traceable basis/g) || []).length >= 2);
  assert.ok(/never write a date that has already passed as a future condition or deadline/.test(s));
  assert.ok(!/Sweetspire|Waterview|September 15/.test(src('lib/acc/letter_checks.js')));
});

let pass = 0, fail = 0;
console.log('ACC letter conditions: real basis, no expired dates (Issue #14)');
for (const [n, fn] of tests) { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
