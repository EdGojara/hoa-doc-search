// Tests for lib/enforcement/letter_batch.js — bundle-aware print dedupe.
// Scar (Ed 2026-07-29): a courtesy/§209 bundle's N interactions share ONE PDF,
// so merging per-interaction printed the bundle N times ("217 bundles → 267
// envelopes"). The dedupe must merge each unique PDF exactly once.
const assert = require('assert');
const { uniqueLettersByPdf } = require('../lib/enforcement/letter_batch');

let pass = 0;
const ok = (d, c) => { assert.ok(c, d); pass++; };

// A 2-violation bundle: two interactions, ONE shared PDF. Must merge once.
const bundle2 = [
  { id: 'a', content: 'prop1/bundle-courtesy_1-x.pdf' },
  { id: 'b', content: 'prop1/bundle-courtesy_1-x.pdf' },
];
const u2 = uniqueLettersByPdf(bundle2);
ok('a 2-item bundle merges as ONE PDF', u2.length === 1);
ok('the surviving row is the first occurrence', u2[0].id === 'a');

// Mixed batch: a 3-item bundle + two singletons = 3 unique envelopes.
const mixed = [
  { id: '1', content: 'p/bundle-A.pdf' },
  { id: '2', content: 'p/bundle-A.pdf' },
  { id: '3', content: 'p/bundle-A.pdf' },
  { id: '4', content: 'q/single-1.pdf' },
  { id: '5', content: 'r/single-2.pdf' },
];
ok('3-item bundle + 2 singletons = 3 envelopes, not 5', uniqueLettersByPdf(mixed).length === 3);

// Rows with no content are dropped (nothing to merge).
ok('rows with no content are dropped', uniqueLettersByPdf([{ id: 'x' }, { id: 'y', content: null }]).length === 0);

// Order is preserved across distinct PDFs.
const ordered = [
  { id: '1', content: 'c.pdf' },
  { id: '2', content: 'a.pdf' },
  { id: '3', content: 'a.pdf' },
  { id: '4', content: 'b.pdf' },
];
assert.deepStrictEqual(uniqueLettersByPdf(ordered).map((l) => l.content), ['c.pdf', 'a.pdf', 'b.pdf']);
pass++;

// Defensive: non-array / empty input.
ok('empty array -> empty', uniqueLettersByPdf([]).length === 0);
ok('non-array -> empty', uniqueLettersByPdf(null).length === 0);

console.log(`letter_batch: ${pass} assertions passed`);
