// scripts/test_chunker_structure.js
//
// Sanity test for the structure-aware chunkText in lib/library_reindex.js.
// Runs five synthetic declaration shapes through the chunker and asserts the
// breadcrumb is captured correctly. Catches regex regressions before they
// ship to production indexing.
//
//   node scripts/test_chunker_structure.js

// Inline-mirror the patterns + chunker from lib/library_reindex.js so this
// test fails loudly if the patterns drift. We're explicitly NOT requiring()
// the production code to keep the test independent — if the production
// chunker changes shape, this test breaks and forces an update.
const fs = require('fs');
const path = require('path');

// Require the actual production module so test reflects shipped code.
const lib = require('../lib/library_reindex');
// chunkText is not exported by default; expose via internal require shim.
// If unexported, fall back to copying via reflection. Cleaner: export it.
let chunkText;
try {
  // We add module.exports.chunkText below if not already exported.
  chunkText = require('../lib/library_reindex').chunkText;
} catch (_) {
  chunkText = null;
}
if (typeof chunkText !== 'function') {
  console.error('FAIL: chunkText is not exported from lib/library_reindex.js — add it to module.exports');
  process.exit(2);
}

let pass = 0, fail = 0;
function assert(cond, label, got) {
  if (cond) { pass += 1; console.log(`  OK  ${label}`); }
  else      { fail += 1; console.error(`  FAIL ${label} (got: ${JSON.stringify(got)})`); }
}

function findChunkAt(chunks, needle) {
  return chunks.find((c) => c.content.includes(needle));
}

// -----------------------------------------------------------------------
// Test 1 — classic Texas HOA Bylaws shape (mixed-case headers, no separator)
// -----------------------------------------------------------------------
console.log('\nTest 1: classic Bylaws — "Article V" / "Section 5.7 First Meeting."');
{
  const text = `
PREAMBLE

These Bylaws are adopted...

Article I
Definitions

Section 1.1 Defined Terms.

The following terms shall have the meanings set forth below...

Article V
Meetings

Section 5.7 First Meeting.

The first meeting of a newly elected Board shall be held within thirty (30) days
of the election. No additional notice to directors is required as long as a
majority of the whole board is present.

Section 5.8 Regular Meetings.

Regular meetings of the Board shall be held no less than quarterly.
`;
  const chunks = chunkText(text, 200, 50); // smaller chunks for tight testing
  const c1 = findChunkAt(chunks, 'thirty (30) days');
  const c2 = findChunkAt(chunks, 'Regular meetings of the Board');
  assert(c1 && c1.article === 'V', 'first meeting chunk has article V', c1 && c1.article);
  assert(c1 && c1.section === '5.7', 'first meeting chunk has section 5.7', c1 && c1.section);
  assert(c1 && c1.sectionHeading && c1.sectionHeading.startsWith('First Meeting'), 'first meeting chunk has heading', c1 && c1.sectionHeading);
  assert(c2 && c2.section === '5.8', 'regular meetings chunk has section 5.8', c2 && c2.section);
}

// -----------------------------------------------------------------------
// Test 2 — Declaration with ALL CAPS Article + dashed heading
// -----------------------------------------------------------------------
console.log('\nTest 2: Declaration — "ARTICLE VII — USE RESTRICTIONS" / "Section 7.2 Commercial Use Prohibited."');
{
  const text = `
ARTICLE VII — USE RESTRICTIONS

Section 7.1 Residential Use Only.

The Lots shall be used for residential purposes only.

Section 7.2 Commercial Use Prohibited.

No Lot or Dwelling shall be used for trade, business, or commercial purposes,
including without limitation any short-term rental arrangement.
`;
  const chunks = chunkText(text, 200, 50);
  const c = findChunkAt(chunks, 'trade, business, or commercial');
  assert(c && c.article === 'VII', 'commercial chunk has article VII', c && c.article);
  assert(c && c.articleHeading === 'USE RESTRICTIONS', 'article heading captured', c && c.articleHeading);
  assert(c && c.section === '7.2', 'commercial chunk has section 7.2', c && c.section);
  assert(c && c.sectionHeading && c.sectionHeading.startsWith('Commercial Use'), 'section heading captured', c && c.sectionHeading);
}

// -----------------------------------------------------------------------
// Test 3 — Subsections with deeper numbering (7.2.1)
// -----------------------------------------------------------------------
console.log('\nTest 3: subsection numbering — "Section 7.2.1 Definitions of Commercial Use"');
{
  const text = `
ARTICLE VII
Use Restrictions

Section 7.2.1 Definitions of Commercial Use.

For purposes of this Article, "commercial use" includes short-term rentals
of less than thirty consecutive days, regardless of platform.
`;
  const chunks = chunkText(text, 200, 50);
  const c = findChunkAt(chunks, 'thirty consecutive days');
  assert(c && c.section === '7.2.1', 'subsection number captured', c && c.section);
}

// -----------------------------------------------------------------------
// Test 4 — Doc with NO Article/Section structure (vendor invoice)
// -----------------------------------------------------------------------
console.log('\nTest 4: unstructured doc — vendor invoice, no breadcrumb expected');
{
  const text = `
INVOICE #12345
Date: 2026-05-01
Bill To: Bedrock Association Mgmt

Description: Pool maintenance service for May 2026
Quantity: 1
Amount: $850.00

Thank you for your business.
`;
  const chunks = chunkText(text, 200, 50);
  const c = chunks[0];
  assert(c && !c.article, 'no article detected', c && c.article);
  assert(c && !c.section, 'no section detected', c && c.section);
  assert(chunks.length > 0, 'still produces chunks', chunks.length);
}

// -----------------------------------------------------------------------
// Test 5 — Roman numeral progression. Uses smaller chunk size so each
// article gets its own chunk (the 199-char test text would otherwise fit
// in a single 200-char chunk and the per-article assertions wouldn't be
// meaningful).
// -----------------------------------------------------------------------
console.log('\nTest 5: Roman numeral article progression I → II → III');
{
  const text = `
Article I
Definitions

Section 1.1 Terms. Defined terms appear here.

Article II
Membership

Section 2.1 Eligible Owners. Members shall be...

Article III
Governance

Section 3.1 Board Composition.
`;
  const chunks = chunkText(text, 70, 15);
  const cI   = findChunkAt(chunks, 'Defined terms');
  const cII  = findChunkAt(chunks, 'Eligible Owners');
  const cIII = findChunkAt(chunks, 'Board Composition');
  assert(cI && cI.article === 'I', 'article I tracked', cI && cI.article);
  assert(cII && cII.article === 'II', 'article II tracked (reset section)', cII && cII.article);
  assert(cIII && cIII.article === 'III', 'article III tracked', cIII && cIII.article);
  assert(cII && cII.section === '2.1', 'section 2.1 under article II', cII && cII.section);
}

// -----------------------------------------------------------------------
console.log(`\n=========\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
