#!/usr/bin/env node
// tests/test_run_approval_channel.js  (Ed 2026-10-13)
// "Chat authorization must be distinguishable from authenticated in-app approval. Do not
// populate an authenticated approver field from chat instructions or bypass approval
// controls with a server key." Kat's runs post only on the owner's signed-in approval:
//   - approveAndPost refuses a plain approver string, a chat authorization or an approval
//     without the signed-in user, before it reads or writes anything;
//   - the approve route builds the approval from the owner's session (requireOwner);
//   - the run history shows audit notes (the 2026-10-13 clarification) in full.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/accounting/monthly_runs');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const untouchable = { from() { throw new Error('the database must not be touched'); }, rpc() { throw new Error('the database must not be touched'); } };

(async () => {
  console.log('Run approval channel');

  await t('refused before any read or write: a plain approver string, a chat authorization, an approval with no signed-in user', async () => {
    const bad = [
      { approver: 'egojara@bedrocktx.com' },
      { approval: 'egojara@bedrocktx.com (approved in chat)' },
      { approval: { channel: 'chat', email: 'egojara@bedrocktx.com', user_id: 'u1' } },
      { approval: { channel: 'server_key', email: 'egojara@bedrocktx.com', user_id: 'u1' } },
      { approval: { channel: 'in_app', email: 'egojara@bedrocktx.com' } },
      {},
    ];
    for (const b of bad) await assert.rejects(R.approveAndPost(untouchable, { run_id: 'r', include: [], ...b }), (e) => e.code === 'approval_required' && /authenticated approval/.test(e.message), JSON.stringify(b));
  });

  await t('an authenticated in-app approval is recorded as such (and only it gets past the gate)', () => {
    assert.strictEqual(R.assertInAppApproval({ channel: 'in_app', user_id: 'u1', email: 'egojara@bedrocktx.com' }), 'egojara@bedrocktx.com (authenticated in-app approval)');
  });

  await t('the approve route builds the approval from the signed-in owner session', () => {
    const api = read('api/accounting_runs.js');
    assert.ok(/run\/:id\/approve'[\s\S]{0,400}requireOwner\(req, res\)[\s\S]{0,400}approval: \{ channel: 'in_app', user_id: u\.user && u\.user\.id, email: u\.email \}/.test(api));
    assert.ok(!/approver: /.test(api), 'no string approver is passed anywhere');
  });

  await t('the run history shows audit notes in full and who approved', () => {
    const ui = read('public/ed.html');
    assert.ok(/e\.event==='note'&&e\.detail&&e\.detail\.text/.test(ui));
    assert.ok(/approved by '\+esc\(run\.approved_by\)/.test(ui));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
