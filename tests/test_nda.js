// =============================================================================
// tests/test_nda.js — the Bedrock mutual NDA fills + renders correctly
// =============================================================================
// Ed 2026-09-03: an NDA to have banks/insurers/media sign before sharing trustEd
// internals. Guards that the generator fills the counterparty + signatory, leaves
// no unresolved placeholders, keeps the mutual + Texas + no-reverse-engineering
// substance, and honors an edited master body.
//
// Run: node tests/test_nda.js   (wired into npm test)
// =============================================================================
const assert = require('assert');
const { fillNda, renderNdaHtml, NDA_TEMPLATE_MD, NDA_SLUG } = require('../lib/legal/nda_render');

let failures = 0;
function check(name, fn){ try { fn(); console.log(`  PASS  ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}`); console.log(`        ${e.message}`); } }

check('fillNda replaces the counterparty and effective date', () => {
  const out = fillNda(NDA_TEMPLATE_MD, { counterparty: 'Acme Bank, N.A.', effective_date_text: 'September 3, 2026' });
  assert.ok(out.includes('Acme Bank, N.A.'), 'counterparty inserted');
  assert.ok(out.includes('September 3, 2026'), 'date inserted');
  assert.ok(!/\{\{/.test(out), 'no leftover placeholders');
});

check('renderNdaHtml carries the material substance + both signature blocks', () => {
  const html = renderNdaHtml(
    { counterparty: 'Acme Bank, N.A.', effective_date_text: 'September 3, 2026', signatory_name: 'Ed Gojara', signatory_title: 'Managing Member', cp_signer_name: 'Jane Roe', cp_signer_title: 'General Counsel' },
    { docMeta: { version: 2, generated: 'September 3, 2026' } },
  );
  assert.ok(/Mutual Non-Disclosure Agreement/.test(html), 'title');
  assert.ok(/Reverse Engineering/i.test(html), 'no-reverse-engineering clause (platform internals)');
  assert.ok(/State of Texas/.test(html), 'Texas governing law');
  // Venue fix: federal half must name SDTX Houston Division, not "federal courts in Fort Bend".
  assert.ok(/Southern District of Texas, Houston Division/.test(html), 'correct federal venue');
  assert.ok(!/federal courts located in Fort Bend/.test(html), 'no bad federal-in-Fort-Bend venue');
  // AI/model-training misuse clause + independent-development carve-back.
  assert.ok(/training data/i.test(html) && /artificial intelligence or machine learning/i.test(html), 'AI training clause');
  assert.ok(/independently develop/i.test(html), 'independent-development carve-back (not a non-compete)');
  assert.ok(/Restricted Use/i.test(html), '§5 renamed to Restricted Use');
  assert.ok(/screen-record/i.test(html), 'no-recording-of-demonstrations clause');
  assert.ok(!/competes with, replicates, or substitutes/i.test(html), 'redundant "replicates" tightened out');
  assert.ok(/with respect to its trustEd platform/i.test(html) && !/affiliates including the trustEd/i.test(html), 'trustEd wording not an "affiliate"');
  // Backup carve-out in return/destruction.
  assert.ok(/routine electronic backups/i.test(html), 'backup/archival carve-out');
  // Observed/derived info in the confidential-information definition.
  assert.ok(/learned, observed, inferred, or derived/i.test(html), 'observed/derived-from-demo language');
  assert.ok(/BEDROCK ASSOCIATION MANAGEMENT, LLC/.test(html), 'Bedrock signature block');
  assert.ok(/ACME BANK, N\.A\./.test(html), 'counterparty signature block');
  assert.ok(/Ed Gojara/.test(html) && /Managing Member/.test(html), 'Bedrock signatory prefilled');
  assert.ok(/Jane Roe/.test(html) && /General Counsel/.test(html), 'counterparty signer prefilled');
  assert.ok(/Template v2/.test(html), 'template version stamped in footer');
  assert.ok(!/\{\{/.test(html), 'no leftover placeholders in the rendered doc');
});

check('renderNdaHtml uses an edited master body when supplied', () => {
  const edited = '## Mutual Non-Disclosure Agreement\n\nCustom clause for {{COUNTERPARTY}}. Governed by the laws of the State of Texas.';
  const html = renderNdaHtml({ counterparty: 'Beta Insurance Co.' }, { bodyMarkdown: edited });
  assert.ok(/Custom clause for Beta Insurance Co\./.test(html), 'edited body flows through');
});

check('slug is the stable Legal Disclosures key', () => { assert.strictEqual(NDA_SLUG, 'mutual-nda'); });

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll NDA checks passed.');
