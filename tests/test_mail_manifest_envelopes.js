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
    { id: 'a1', address: '4819 Harbor Glen Lane', category: 'Mildew / mold (visible)', letter_type: 'Courtesy 1', content: 'p1/bundle-x.pdf', property_id: 'p1', bundle_id: 'B1' },
    { id: 'a2', address: '4819 Harbor Glen Lane', category: 'Dead or dying tree', letter_type: 'Courtesy 1', content: 'p1/bundle-x.pdf', property_id: 'p1', bundle_id: 'B1' },
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

t('normal bundle: same bundle_id + property + content is ONE envelope with no warning', () => {
  const r = groupManifestEnvelopes([
    { id: 'n1', address: '9 N St', category: 'A', letter_type: 'Courtesy 1', content: 'pn/bundle.pdf', property_id: 'pn', bundle_id: 'BN' },
    { id: 'n2', address: '9 N St', category: 'B', letter_type: 'Courtesy 1', content: 'pn/bundle.pdf', property_id: 'pn', bundle_id: 'BN' },
  ]);
  assert.strictEqual(r.envelope_count, 1); assert.strictEqual(r.integrity_warnings, 0);
  assert.strictEqual(r.envelopes[0].violation_count, 2); assert.strictEqual(r.envelopes[0].integrity_warning, null);
});

t('same content path on two DIFFERENT properties is NOT collapsed: two envelopes, both flagged', () => {
  const r = groupManifestEnvelopes([
    { id: 'x1', address: '1 X St', category: 'A', letter_type: 'Courtesy 1', content: 'shared/file.pdf', property_id: 'px1' },
    { id: 'x2', address: '2 X St', category: 'B', letter_type: 'Courtesy 1', content: 'shared/file.pdf', property_id: 'px2' },
  ]);
  assert.strictEqual(r.envelope_count, 2);
  assert.strictEqual(r.combined_envelopes, 0);
  assert.strictEqual(r.integrity_warnings, 2);
  assert.ok(r.envelopes.every((e) => /also used by another envelope/.test(e.integrity_warning)));
});

t('same bundle_id with mismatched content or property is NOT merged: each member its own flagged row', () => {
  const content = groupManifestEnvelopes([
    { id: 'm1', address: '3 M St', category: 'A', letter_type: 'Courtesy 1', content: 'pm/bundle-a.pdf', property_id: 'pm', bundle_id: 'BM' },
    { id: 'm2', address: '3 M St', category: 'B', letter_type: 'Courtesy 1', content: 'pm/bundle-b.pdf', property_id: 'pm', bundle_id: 'BM' },
  ]);
  assert.strictEqual(content.envelope_count, 2); assert.strictEqual(content.combined_envelopes, 0);
  assert.ok(content.envelopes.every((e) => /disagree on content/.test(e.integrity_warning)));
  const prop = groupManifestEnvelopes([
    { id: 'q1', address: '4 Q St', category: 'A', letter_type: 'Courtesy 1', content: 'q/bundle.pdf', property_id: 'pq1', bundle_id: 'BQ' },
    { id: 'q2', address: '5 Q St', category: 'B', letter_type: 'Courtesy 1', content: 'q/bundle.pdf', property_id: 'pq2', bundle_id: 'BQ' },
  ]);
  assert.strictEqual(prop.envelope_count, 2);
  assert.ok(prop.envelopes.every((e) => /disagree on property_id/.test(e.integrity_warning)));
  assert.strictEqual(prop.integrity_warnings, 2);
  const stage = groupManifestEnvelopes([
    { id: 's1', address: '6 S St', category: 'A', letter_type: 'Courtesy 1', content: 's/b.pdf', property_id: 'ps', bundle_id: 'BS' },
    { id: 's2', address: '6 S St', category: 'B', letter_type: 'Courtesy 2', content: 's/b.pdf', property_id: 'ps', bundle_id: 'BS' },
  ]);
  assert.ok(stage.envelopes.every((e) => /letter_type/.test(e.integrity_warning)));
});

t('same bundle_id + property + content + type but DIFFERENT addresses is NOT merged: separate flagged rows', () => {
  const r = groupManifestEnvelopes([
    { id: 'z1', address: '7 Z St', category: 'A', letter_type: 'Courtesy 1', content: 'pz/bundle.pdf', property_id: 'pz', bundle_id: 'BZ' },
    { id: 'z2', address: '7 Zed Street', category: 'B', letter_type: 'Courtesy 1', content: 'pz/bundle.pdf', property_id: 'pz', bundle_id: 'BZ' },
  ]);
  assert.strictEqual(r.envelope_count, 2); assert.strictEqual(r.combined_envelopes, 0);
  assert.ok(r.envelopes.every((e) => /^bundle BZ members disagree on address/.test(e.integrity_warning)));
  // A non-bundle property+content group is worded as an envelope group.
  const g = groupManifestEnvelopes([
    { id: 'g1', address: '8 G St', category: 'A', letter_type: 'Courtesy 1', content: 'pg/f.pdf', property_id: 'pg' },
    { id: 'g2', address: '8 G St', category: 'B', letter_type: 'Courtesy 2', content: 'pg/f.pdf', property_id: 'pg' },
  ]);
  assert.ok(g.envelopes.every((e) => /^envelope group members disagree on letter_type/.test(e.integrity_warning)));
});

t('a letter with no PDF stays its own row (never merged into another)', () => {
  const r = groupManifestEnvelopes([{ id: 'd1', address: '2 B St', category: 'Z', letter_type: 'Courtesy 1', content: null, property_id: 'p4' }, { id: 'd2', address: '2 B St', category: 'W', letter_type: 'Courtesy 1', content: null, property_id: 'p4' }]);
  assert.strictEqual(r.envelope_count, 2); assert.ok(r.envelopes.every((e) => !e.has_pdf));
});

t('the manifest API and UI use envelopes (source contract)', () => {
  const fs = require('fs');
  const api = fs.readFileSync(require.resolve('../api/enforcement'), 'utf8');
  assert.ok(/groupManifestEnvelopes\(/.test(api));
  assert.ok(/bundle_id: i\._bundle_id/.test(api), 'the manifest passes bundle_id into the grouping');
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
