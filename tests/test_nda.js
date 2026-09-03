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
  const html = renderNdaHtml({ counterparty: 'Acme Bank, N.A.', effective_date_text: 'September 3, 2026', signatory_name: 'Ed Gojara', signatory_title: 'Managing Member' });
  assert.ok(/Mutual Non-Disclosure Agreement/.test(html), 'title');
  assert.ok(/Reverse Engineering/i.test(html), 'no-reverse-engineering clause (platform internals)');
  assert.ok(/State of Texas/.test(html) && /Fort Bend County/.test(html), 'Texas governing law + venue');
  assert.ok(/BEDROCK ASSOCIATION MANAGEMENT, LLC/.test(html), 'Bedrock signature block');
  assert.ok(/ACME BANK, N\.A\./.test(html), 'counterparty signature block');
  assert.ok(/Ed Gojara/.test(html) && /Managing Member/.test(html), 'Bedrock signatory prefilled');
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
