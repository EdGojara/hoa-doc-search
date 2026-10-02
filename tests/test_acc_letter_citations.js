// ============================================================================
// tests/test_acc_letter_citations.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// A homeowner ACC decision letter keeps the governing-document citation the
// review supplied. Scar (WAT-ARC-2026-0025): condition 4 read "consistent with
// the bylaws of the Waterview Estates Declaration". The customer leak filter's
// citation-softening rule rewrote "Section 2.21" to "the bylaws", turning a
// Declaration citation into a different document, and finalize re-ran it at
// send. Now:
//   - formal decision letters keep citations verbatim (Declaration / CC&R /
//     Article / Section), while every real leak block still fires;
//   - conversational surfaces still soften, but to "the governing documents",
//     never to "the bylaws";
//   - every ACC letter path screens as a formal letter;
//   - Annie's drafting names the document as the analysis does.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { screenForLeaks } = require('../lib/voice/leak_filter');
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const formal = (t) => screenForLeaks(t, { audience: 'customer', autoRewrite: true, formalLetter: true });
const casual = (t) => screenForLeaks(t, { audience: 'customer', autoRewrite: true });

check('a Declaration section citation is NOT rewritten as bylaws in a decision letter', () => {
  const t = '4. Any change in grade or drainage must be consistent with Section 2.21 of the Riverbend Declaration.';
  const r = formal(t);
  assert.strictEqual(r.text, t); assert.ok(!/bylaws/i.test(r.text)); assert.ok(r.ok);
});
check('CC&R, Article/Section and "Declaration of Covenants" titles are kept verbatim in a decision letter', () => {
  const t = 'Your request conflicts with Article VII, Section 7.3 of the Declaration of Covenants, Conditions and Restrictions (the CC&Rs), paragraph 4.';
  assert.strictEqual(formal(t).text, t);
});
check('a letter that genuinely cites the Bylaws keeps "Bylaws"', () => {
  const t = 'Under Section 3.2 of the Bylaws, the committee meets monthly.';
  assert.strictEqual(formal(t).text, t);
});
check('formal mode removes only citation REGISTER rules: real leaks still block / rewrite', () => {
  assert.ok(formal('This letter was written by Claude. See Section 2.21.').blocks.length > 0);
  assert.ok(formal('[INTERNAL: reviewer note] Section 2.21 applies.').blocks.length > 0);
});
check('conversational surfaces still soften a citation, but never into a DIFFERENT document ("bylaws")', () => {
  const r = casual('That has to be consistent with Section 2.21 of the Declaration.');
  assert.ok(!/bylaws/i.test(r.text), r.text);
  assert.ok(/the governing documents of the Declaration/.test(r.text));
  assert.ok(!/replacement: 'the bylaws'/.test(src('lib/voice/leak_filter.js')));
});
check('every ACC decision-letter screen (engine draft, letter upload, finalize, redraft, preview) is a formal letter', () => {
  const s = src('server.js');
  const spans = [
    s.slice(s.indexOf('async function assessAndDraftAcc'), s.indexOf("app.post('/acc-review', upload.any()")),
    s.slice(s.indexOf("app.post('/acc-review/letter'"), s.indexOf("app.get('/acc-review/decisions', async")),
    s.slice(s.indexOf("app.post('/acc-review/decisions/:id/finalize'"), s.indexOf("app.post('/acc-review/decisions/:id/redraft'")),
    s.slice(s.indexOf("app.post('/acc-review/decisions/:id/redraft'"), s.indexOf("app.post('/acc-review/render-letter'")),
    s.slice(s.indexOf("app.post('/acc-review/render-letter'"), s.indexOf("app.post('/acc-review/render-letter'") + 3000),
  ];
  for (const sp of spans) {
    const calls = sp.match(/screenForLeaks\([^)]*\)/g) || [];
    assert.ok(calls.length >= 1, 'a screen in each ACC letter path');
    for (const c of calls) assert.ok(/formalLetter: true/.test(c), c);
  }
});
check('Annie\'s drafting names the governing document as the analysis does, never "the bylaws" for a Declaration/CC&R', () => {
  const s = src('server.js');
  const n = (s.match(/Never call a Declaration or CC&R provision "the bylaws"; they are different documents\./g) || []).length;
  assert.ok(n >= 2, 'engine first draft + redraft');
});

let pass = 0, fail = 0;
console.log('ACC letter citations (Issue #14)');
for (const [n, fn] of tests) { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
