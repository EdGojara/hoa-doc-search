// =============================================================================
// tests/test_insurance_rfp_validate.js — the RFP completeness guard, encoded
// =============================================================================
//
// THE SCAR (Ed 2026-09-03, Waterview Estates): a generated insurance RFP asked
// brokers to quote 5 coverage lines when the association actually carried 7. A
// $941,600 Hartford PROPERTY policy was dropped, CYBER was dropped, and CRIME
// rendered as "not purchased" — because the program was extracted from only the
// casualty PDFs and `renderInsuranceRfpHTML` never throws. A clean, professional,
// HALF-COMPLETE RFP was one click from going to competing brokers under Bedrock's
// name.
//
// This proves lib/insurance_rfp_validate.js blocks that: it cross-checks the
// program against the source policy filenames and against the Texas-HOA baseline,
// and refuses (ok:false) when a carried line is missing or empty. Same family as
// the builder-letter validator and the bedrock-vote preview cross-check.
//
// Run: node tests/test_insurance_rfp_validate.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  validateProgramCompleteness, inferLineFromFilename, canonicalLine, LINE,
} = require('../lib/insurance_rfp_validate');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

// ---- filename -> line inference (Bedrock's `POLICY - X.pdf` convention) ------
check('filename inference maps Bedrock policy filenames to lines', () => {
  const cases = [
    ['POLICY - PROP.pdf', LINE.PROPERTY],
    ['POLICY - GL.pdf', LINE.GL],
    ['POLICY - GL - BOP - CHUBB.pdf', LINE.GL],
    ['POLICY - CGL.pdf', LINE.GL],
    ['POLICY - D&O.pdf', LINE.DO],
    ['POLICY - D&O .pdf', LINE.DO],
    ['POLICY - XS.pdf', LINE.UMBRELLA],
    ['POLICY - CRIME.pdf', LINE.CRIME],
    ['POLICY - CRIME - CAIS.pdf', LINE.CRIME],
    ['POLICY - CYBER.pdf', LINE.CYBER],
  ];
  for (const [file, want] of cases) {
    assert.strictEqual(inferLineFromFilename(file), want, `${file} -> ${inferLineFromFilename(file)} (wanted ${want})`);
  }
  // A cover letter / ACORD carries no line signal.
  assert.strictEqual(inferLineFromFilename('cover letter.pdf'), null);
});

// ---- line-name normalization ------------------------------------------------
check('canonicalLine collapses synonyms', () => {
  assert.strictEqual(canonicalLine('Directors & Officers'), LINE.DO);
  assert.strictEqual(canonicalLine('D&O'), LINE.DO);
  assert.strictEqual(canonicalLine("Workers' Compensation"), LINE.WC);
  assert.strictEqual(canonicalLine('Employers Liability'), LINE.WC);
  assert.strictEqual(canonicalLine('Umbrella/Excess Liability'), LINE.UMBRELLA);
  assert.strictEqual(canonicalLine('Commercial Property'), LINE.PROPERTY);
  assert.strictEqual(canonicalLine('Cyber'), LINE.CYBER);
});

// ---- the source cross-check: a filed PDF's line must appear in the program --
check('BLOCKS when source policy files imply lines the program dropped', () => {
  const sources = ['POLICY - PROP.pdf', 'POLICY - GL.pdf', 'POLICY - D&O.pdf', 'POLICY - XS.pdf', 'POLICY - CRIME.pdf', 'POLICY - CYBER.pdf'];
  const program = {
    coverages: [
      { line: 'General Liability', limits: [{ amount: '$1,000,000' }] },
      { line: 'Directors & Officers', limits: [{ amount: '$1,000,000' }] },
      { line: 'Umbrella/Excess Liability', limits: [{ amount: '$5,000,000' }] },
      { line: 'Crime/Fidelity', limits: [] }, // present but empty = "not purchased"
    ],
  };
  const r = validateProgramCompleteness(program, sources);
  assert.strictEqual(r.ok, false, 'must block');
  for (const line of [LINE.PROPERTY, LINE.CYBER, LINE.CRIME]) {
    assert.ok(r.blockers.some((b) => b.startsWith(line + ':')), `expected a blocker for ${line}; got: ${r.blockers.join(' | ')}`);
  }
});

// ---- the baseline: even with NO source files, must-haves are required -------
check('BLOCKS a must-have (Property/D&O) missing even without source files', () => {
  const program = { coverages: [{ line: 'General Liability', limits: [{ amount: '$1,000,000' }] }] };
  const r = validateProgramCompleteness(program, []);
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => b.startsWith(LINE.PROPERTY + ':')), 'Property must-have blocker');
  assert.ok(r.blockers.some((b) => b.startsWith(LINE.DO + ':')), 'D&O must-have blocker');
});

// ---- a genuinely complete program passes ------------------------------------
check('PASSES a complete program with real limits', () => {
  const sources = ['POLICY - PROP.pdf', 'POLICY - GL.pdf', 'POLICY - D&O.pdf', 'POLICY - XS.pdf', 'POLICY - CRIME.pdf', 'POLICY - CYBER.pdf'];
  const program = {
    coverages: [
      { line: 'Property', limits: [{ amount: '$941,600' }] },
      { line: 'General Liability', limits: [{ amount: '$1,000,000' }] },
      { line: 'Directors & Officers', limits: [{ amount: '$1,000,000' }] },
      { line: 'Umbrella/Excess Liability', limits: [{ amount: '$5,000,000' }] },
      { line: 'Crime/Fidelity', limits: [{ amount: '$100,000' }] },
      { line: 'Cyber', limits: [{ amount: '$1,000,000' }] },
      { line: 'Workers Compensation', limits: [{ amount: '$1,000,000' }] },
    ],
  };
  const r = validateProgramCompleteness(program, sources);
  assert.strictEqual(r.ok, true, `expected pass; blockers: ${r.blockers.join(' | ')}`);
});

// ---- fixture corpus: every JSON in fixtures/insurance-program ----------------
const FIX_DIR = path.join(__dirname, 'fixtures', 'insurance-program');
for (const file of fs.readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).sort()) {
  check(`fixture: ${file}`, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, file), 'utf8'));
    const r = validateProgramCompleteness(fx.program, fx.sources || []);
    assert.strictEqual(r.ok, fx.expect.ok, `ok mismatch (blockers: ${r.blockers.join(' | ')})`);
    for (const line of (fx.expect.missing || [])) {
      assert.ok(r.blockers.some((b) => b.startsWith(line + ':')), `expected blocker naming ${line}; got: ${r.blockers.join(' | ')}`);
    }
  });
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll insurance RFP completeness-guard checks passed.');
