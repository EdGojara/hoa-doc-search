// ============================================================================
// test_salutation.js — regression tests for violation-letter salutations
// ----------------------------------------------------------------------------
// Run: node tests/test_salutation.js   (exit 1 on any failure)
//
// Scar 2026-06-26: "Hurdoiu Enterprise LLC Series 2" rendered as "Dear Mr. 2,"
// — the old code split on spaces, took "2" as a surname, and prefixed an
// assumed "Mr." Letters are a catastrophic-output surface (they go to owners on
// HOA letterhead), so the salutation must never (a) invent a gender honorific,
// (b) treat an entity like a person, or (c) emit a number/garbage as a name.
// ============================================================================

const assert = require('assert');
const { buildSalutation } = require('../lib/enforcement/violation_letter');

const cases = [
  // Entities — addressed by name, no honorific.
  ['Hurdoiu Enterprise LLC Series 2', 'Dear Hurdoiu Enterprise LLC Series 2,'],
  ['Lennar Homes LLC', 'Dear Lennar Homes LLC,'],
  ['The Werdenberg Living Trust', 'Dear The Werdenberg Living Trust,'],
  ['Tafish Family Management LLC', 'Dear Tafish Family Management LLC,'],
  // Couples.
  ['Chadi & Eva Abou-Mourad', 'Dear Chadi and Eva Abou-Mourad,'],
  ['Julian & Maria Mendoza', 'Dear Julian and Maria Mendoza,'],
  // Individuals — full name, title-cased, no gender guess.
  ['jose alvarez', 'Dear Jose Alvarez,'],
  ['JOSE M ALVAREZ', 'Dear Jose M Alvarez,'],
  ['Maria Mendoza', 'Dear Maria Mendoza,'],
  // Comma "Last, First".
  ['Alvarez, Jose', 'Dear Jose Alvarez,'],
  // Empty / null.
  ['', 'Dear Property Owner,'],
  [null, 'Dear Property Owner,'],
  [undefined, 'Dear Property Owner,'],
];

let pass = 0, fail = 0;
for (const [input, want] of cases) {
  const got = buildSalutation(input);
  try { assert.strictEqual(got, want); pass++; }
  catch { fail++; console.log(`FAIL | ${JSON.stringify(input)} -> ${got} (wanted ${want})`); }
}

// Invariants that must hold for ANY input (no honorific guess, no bare-digit name).
const fuzz = ['Bob', 'X', '123 LLC', 'Smith, John, Jr.', 'A & B & C', 'M., III Bourque'];
for (const n of fuzz) {
  const s = buildSalutation(n);
  try {
    assert.ok(!/\bMr\.|\bMrs\.|\bMs\./.test(s), `honorific leaked: ${s}`);
    assert.ok(!/undefined|Dear ,/.test(s), `garbage: ${s}`);
    pass++;
  } catch (e) { fail++; console.log(`FAIL | invariant on ${JSON.stringify(n)}: ${e.message}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
