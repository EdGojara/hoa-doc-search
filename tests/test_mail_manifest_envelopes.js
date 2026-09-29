// tests/test_mail_manifest_envelopes.js: the Mail Queue batch manifest lists one
// row per PRINTED envelope (Issue #5 follow-up, Ed 2026-09-28). A two-violation
// house sharing one combined PDF is ONE row with ONE View, never two.
const assert = require('assert');
const { groupManifestEnvelopes } = require('../lib/enforcement/mail_manifest');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

t('two violations sharing one combined PDF are one envelope; singles stay one row each', () => {
  const r = groupManifestEnvelopes([
    { id: 'a1', address: '4819 Harbor Glen Lane', category: 'Mildew / mold (visible)', letter_type: 'Courtesy 1', content: 'p1/bundle-x.pdf', property_id: 'p1' },
    { id: 'a2', address: '4819 Harbor Glen Lane', category: 'Dead or dying tree', letter_type: 'Courtesy 1', content: 'p1/bundle-x.pdf', property_id: 'p1' },
    { id: 'b1', address: '4822 Bonny Loch Lane', category: 'Weeds in Flower Beds', letter_type: 'Courtesy 1', content: 'v9/courtesy_1.pdf', property_id: 'p2' },
  ]);
  assert.strictEqual(r.envelope_count, 2);
  assert.strictEqual(r.combined_envelopes, 1);
  const hg = r.envelopes.find((e) => e.address === '4819 Harbor Glen Lane');
  assert.deepStrictEqual(hg.categories, ['Mildew / mold (visible)', 'Dead or dying tree']);
  assert.strictEqual(hg.violation_count, 2); assert.ok(hg.combined);
  assert.deepStrictEqual(hg.interaction_ids, ['a1', 'a2']); assert.strictEqual(hg.view_id, 'a1');
  assert.strictEqual(r.properties_with_multiple_envelopes, 0);
});

t('a house with two DIFFERENT PDFs (e.g. two stages) is two envelopes and is flagged', () => {
  const r = groupManifestEnvelopes([
    { id: 'c1', address: '1 A St', category: 'X', letter_type: 'Courtesy 1', content: 'v1/c1.pdf', property_id: 'p3' },
    { id: 'c2', address: '1 A St', category: 'Y', letter_type: 'Courtesy 2', content: 'v2/c2.pdf', property_id: 'p3' },
  ]);
  assert.strictEqual(r.envelope_count, 2); assert.strictEqual(r.combined_envelopes, 0); assert.strictEqual(r.properties_with_multiple_envelopes, 1);
});

t('a letter with no PDF stays its own row (never merged into another)', () => {
  const r = groupManifestEnvelopes([{ id: 'd1', address: '2 B St', category: 'Z', letter_type: 'Courtesy 1', content: null, property_id: 'p4' }, { id: 'd2', address: '2 B St', category: 'W', letter_type: 'Courtesy 1', content: null, property_id: 'p4' }]);
  assert.strictEqual(r.envelope_count, 2); assert.ok(r.envelopes.every((e) => !e.has_pdf));
});

t('the manifest API and UI use envelopes (source contract)', () => {
  const fs = require('fs');
  assert.ok(/groupManifestEnvelopes\(/.test(fs.readFileSync(require.resolve('../api/enforcement'), 'utf8')));
  const ui = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/each a separate notice/.test(ui), 'the misleading label is gone');
  assert.ok(/combined into one letter/.test(ui));
  assert.ok(/letter-pdf\/' \+ it\.view_id/.test(ui), 'one View per envelope');
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall mail manifest envelope checks passed');
  process.exitCode = failed ? 1 : 0;
})();
