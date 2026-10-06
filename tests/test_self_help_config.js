// ============================================================================
// tests/test_self_help_config.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// A 10-day self-help case (force-mow / cleanup / tree) cannot be opened for a
// community with no self-help authority on file.
//
// Quail Ridge, 520 Shady Dale: a manual "Lawn - 10-Day Certified Force Mow" case
// saved and returned ok, then its letter draft failed on the missing config and
// said so only in the server log. Staff saw an open case, a photo, no letter,
// nothing in Drafts. The manual-create route now checks first and refuses with a
// plain explanation; the auto-draft uses the same definition of "configured".
//
//   node tests/test_self_help_config.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sh = require('../lib/enforcement/self_help_config');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// Synthetic community rows shaped like the live ones.
const UNCONFIGURED = { name: 'Synthetic Ridge', legal_name: 'Synthetic Ridge HOA', declaration_doc_number: null, declaration_county: null, force_mow_section_full: null, cleanup_section_full: null };
const LAWN_ONLY = { name: 'Synthetic Gate', declaration_doc_number: '2001000001', declaration_county: 'Fort Bend', force_mow_section_full: 'Article III, Section 12 of the Declaration', cleanup_section_full: null };

console.log('\nWhich categories are self-help');
check('the three 10-day slugs map to their remedy; everything else is null', () => {
  assert.strictEqual(sh.remedyFor('lawn_force_mow_10day'), 'lawn');
  assert.strictEqual(sh.remedyFor('trash_cleanup_10day'), 'cleanup');
  assert.strictEqual(sh.remedyFor('tree_hazard_10day'), 'tree');
  for (const s of ['lawn_maintenance', 'vehicle_inoperable', 'mildew_mold_visible', '', undefined]) assert.strictEqual(sh.remedyFor(s), null);
});

console.log('\nWhat each remedy needs');
check('an unconfigured community is missing the section, recording number and county', () => {
  assert.deepStrictEqual(sh.missingFields(UNCONFIGURED, 'lawn'), ['force_mow_section_full', 'declaration_doc_number', 'declaration_county']);
  assert.deepStrictEqual(sh.missingFields(null, 'lawn'), ['force_mow_section_full', 'declaration_doc_number', 'declaration_county']);
});
check('lawn and tree cite the force-mow section; cleanup needs its own', () => {
  assert.deepStrictEqual(sh.missingFields(LAWN_ONLY, 'lawn'), []);
  assert.deepStrictEqual(sh.missingFields(LAWN_ONLY, 'tree'), []);
  assert.deepStrictEqual(sh.missingFields(LAWN_ONLY, 'cleanup'), ['cleanup_section_full']);
});
check('whitespace is not a configured value', () => {
  assert.deepStrictEqual(sh.missingFields({ ...LAWN_ONLY, declaration_county: '   ' }, 'lawn'), ['declaration_county']);
});
check('the refusal names the community, the category and each missing item, and offers the regular category', () => {
  const msg = sh.explainMissing('Synthetic Ridge', 'Lawn - 10-Day Certified Force Mow', sh.missingFields(UNCONFIGURED, 'lawn'));
  assert.match(msg, /Synthetic Ridge has no self-help authority on file/);
  assert.match(msg, /Lawn - 10-Day Certified Force Mow/);
  assert.match(msg, /recording number/); assert.match(msg, /recording county/); assert.match(msg, /force-mow/);
  assert.match(msg, /regular \(courtesy \/ §209\) category/);
  assert.strictEqual(sh.explainMissing('X', 'Y', []), null);
});

console.log('\nThe routes use it');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'enforcement.js'), 'utf8');
check('POST /violations/manual checks self-help config BEFORE it inserts the violation', () => {
  const start = SRC.indexOf("router.post('/violations/manual', upload.array(");
  assert.ok(start > 0, 'manual route not found');
  const pre = SRC.indexOf("code: 'self_help_config_missing'", start);
  const ins = SRC.indexOf(".from('violations')\n      .insert(", start);
  assert.ok(pre > start, 'no self-help pre-check in the manual route');
  assert.ok(ins > start, 'violation insert not found');
  assert.ok(pre < ins, 'pre-check must run before the violation is created');
});
check('the auto-draft path uses the same helper (no second definition of "configured")', () => {
  const fn = SRC.slice(SRC.indexOf('async function _draftLetterForBumpedViolation'));
  assert.match(fn.slice(0, 12000), /_sh\.missingFields\(shComm, remedyMode\)/);
  assert.ok(!/const SELF_HELP_REMEDY = \{ lawn_force_mow_10day/.test(fn.slice(0, 12000)), 'local SELF_HELP_REMEDY copy still present');
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : ''));
