// Tests for lib/email/reply_learning — the encode-Ed reply capture + retrieval.
const assert = require('assert');
const { editRatio, getReplyExamples, formatExamplesForPrompt, SUBSTANTIVE_EDIT_RATIO } = require('../lib/email/reply_learning');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

// A thenable fake so `await supabase.from(...).select()...` yields {data,error}.
function fakeSupabase(rows) {
  const b = {
    select() { return this; }, eq() { return this; }, gte() { return this; },
    order() { return this; }, limit() { return this; }, ilike() { return this; },
    then(res) { res({ data: rows, error: null }); },
  };
  return { from() { return b; } };
}

(async () => {
  console.log('reply_learning:');

  t('editRatio: identical text -> 0', () => {
    assert.strictEqual(editRatio('Hi there, thanks.', 'Hi there, thanks.'), 0);
  });

  t('editRatio: whitespace-only change -> 0 (normalized)', () => {
    assert.strictEqual(editRatio('Hi there,\n\nthanks.', 'Hi there, thanks.  '), 0);
  });

  t('editRatio: total rewrite -> near 1', () => {
    assert.ok(editRatio('yes we can approve that', 'Completely different response entirely here') > 0.6);
  });

  t('editRatio: small tweak -> small but > substantive floor stays modest', () => {
    const r = editRatio('We will trim the tree next week.', 'We will trim the tree back next week.');
    assert.ok(r > 0 && r < 0.2, 'got ' + r);
  });

  await (async () => {
    const rows = [
      { original_draft: 'A', final_sent: 'A2', subject: 's1', classification: 'homeowner_request', community_id: 'c1', edit_ratio: 0.3, created_at: '2026-07-01' },
      { original_draft: 'B', final_sent: 'B2', subject: 's2', classification: 'acc_request',       community_id: 'c1', edit_ratio: 0.4, created_at: '2026-07-20' },
      { original_draft: 'C', final_sent: 'C2', subject: 's3', classification: 'homeowner_request', community_id: 'c9', edit_ratio: 0.5, created_at: '2026-07-25' },
    ];
    t('getReplyExamples: same classification+community ranks first', async () => {
      const ex = await getReplyExamples(fakeSupabase(rows), { persona: 'claire', classification: 'homeowner_request', communityId: 'c1', ownerEmail: 'ed@x.com' });
      assert.strictEqual(ex[0].subject, 's1');   // homeowner_request + c1 wins over newer c9 / other class
    });
  })();

  t('getReplyExamples: no supabase / no persona -> []', async () => {
    assert.deepStrictEqual(await getReplyExamples(null, { persona: 'claire' }), []);
    assert.deepStrictEqual(await getReplyExamples(fakeSupabase([]), {}), []);
  });

  t('getReplyExamples: table-missing error -> [] (degrades cleanly)', async () => {
    const errSupa = { from() { return { select(){return this;}, eq(){return this;}, gte(){return this;}, order(){return this;}, limit(){return this;}, ilike(){return this;}, then(res){res({data:null, error:{message:'relation does not exist'}});} }; } };
    assert.deepStrictEqual(await getReplyExamples(errSupa, { persona: 'claire', classification: 'x' }), []);
  });

  t('formatExamplesForPrompt: empty -> "" ; populated -> labeled block', () => {
    assert.strictEqual(formatExamplesForPrompt([]), '');
    const block = formatExamplesForPrompt([{ subject: 'fence', original_draft: 'draft text', final_sent: 'ed sent text' }]);
    assert.ok(/HOW ED EDITS/.test(block));
    assert.ok(block.includes('draft text') && block.includes('ed sent text'));
  });

  t('SUBSTANTIVE_EDIT_RATIO floor is sane', () => {
    assert.ok(SUBSTANTIVE_EDIT_RATIO > 0 && SUBSTANTIVE_EDIT_RATIO < 0.3);
  });

  console.log(`\nreply_learning: ${passed} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
