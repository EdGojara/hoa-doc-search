// ============================================================================
// tests/test_master_plan_extract.js — run: node tests/test_master_plan_extract.js
//
// Covers the deterministic filename fallback for master-plan PDF extraction.
// The AI path (Claude PDF binary) is non-deterministic and is validated live
// against real submittals (e.g. "4505 - Somerset DEF.pdf" → plan 4505 Somerset,
// elevations D/E/F, 2978 sqft, 2 stories — confirmed 2026-06-18).
// ============================================================================

const assert = require('assert');
const { _fromFilename } = require('../lib/master_plan_extract');

let passed = 0;
const check = (name, cond) => { assert.ok(cond, `FAIL: ${name}`); passed++; console.log(`  ✓ ${name}`); };

{
  const r = _fromFilename('4505 - Somerset DEF.pdf');
  check('plan number parsed', r.plan_number === '4505');
  check('name parsed', r.plan_name === 'Somerset');
  check('elevation parsed', r.elevation === 'DEF');
  check('orientation defaults to standard', r.elevation_orientation === 'standard');
}
{
  const r = _fromFilename('476N_Tesla_C4.pdf');
  check('underscore separators handled', r.plan_number === '476N' && r.plan_name === 'Tesla' && r.elevation === 'C4');
}
{
  const r = _fromFilename('4710.pdf');
  check('bare plan number → number only, null name/elev', r.plan_number === '4710' && r.plan_name === null && r.elevation === null);
}
check('empty filename → null', _fromFilename('') === null);
check('null filename → null', _fromFilename(null) === null);

console.log(`\n${passed} assertions passed.`);
