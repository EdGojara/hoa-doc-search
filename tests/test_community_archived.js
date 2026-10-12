#!/usr/bin/env node
// tests/test_community_archived.js  (Ed 2026-10-12)
// One active-management rule (lib/community/lifecycle.js): an archived community, a terminated
// one, or a terminating one past its last day receives no new operational activity (checks,
// collections, DRV letters and escalations, scheduled jobs, AI agents); its records stay
// readable. Operational lists never come from "every row in communities".
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/community/lifecycle');
const { isFormerClient } = require('../lib/ap/former_client');
const { lifecycleGroup } = require('../lib/ops/overview');
const CR = require('../lib/payments/check_receipts');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TODAY = '2026-10-12';
const row = (o) => ({ id: 'c', name: 'Community', management_status: 'active', management_end_date: null, financials_active: true, enforcement_active: true, arc_active: true, ...o });

(async () => {
  console.log('Archived communities');

  await t('the rule: archived, terminated and terminating-past-its-last-day are ended; active, onboarding and terminating-in-notice are operational; prospects are not', () => {
    const cases = [
      [row({ management_status: 'archived' }), true, false], [row({ management_status: 'terminated' }), true, false],
      [row({ management_status: 'terminating', management_end_date: '2026-09-30' }), true, false],
      [row({ management_status: 'terminating', management_end_date: '2026-11-30' }), false, true],
      [row({ management_status: 'active' }), false, true], [row({ management_status: 'onboarding' }), false, true],
      [row({ management_status: 'prospect' }), false, false],
    ];
    for (const [r, ended, op] of cases) { assert.strictEqual(L.isEnded(r, TODAY), ended, JSON.stringify(r)); assert.strictEqual(L.isOperational(r, TODAY), op, JSON.stringify(r)); }
  });

  await t('every service is refused for an archived community; reading is never a service; active is allowed', () => {
    const arch = row({ name: 'Eaglewood', management_status: 'archived', management_end_date: '2026-09-30' });
    for (const s of ['financials', 'payments', 'enforcement', 'arc', 'welcome']) { const v = L.evaluate(s, arch, TODAY); assert.strictEqual(v.allowed, false, s); assert.match(v.reason, /Records stay available to read and export/); }
    for (const s of ['financials', 'enforcement', 'arc']) assert.strictEqual(L.evaluate(s, row({}), TODAY).allowed, true);
  });

  await t('the existing readers agree: former client, ops overview group', () => {
    assert.strictEqual(isFormerClient(row({ management_status: 'archived' }), TODAY), true);
    assert.strictEqual(lifecycleGroup(row({ management_status: 'archived' })), 'archived');
    assert.strictEqual(lifecycleGroup(row({ management_status: 'terminating', management_end_date: '2099-01-01' })), 'leaving');
    assert.strictEqual(lifecycleGroup(row({})), 'managed');
  });

  await t('operationalCommunities filters the roster by the rule (never every row)', async () => {
    const rows = [row({ id: 'a', name: 'Active' }), row({ id: 'e', name: 'Eaglewood', management_status: 'archived' }), row({ id: 'p', name: 'Prospect', management_status: 'prospect' }), row({ id: 'n', name: 'Notice', management_status: 'terminating', management_end_date: '2099-01-01' })];
    const fake = { from: () => ({ select() { return this; }, order() { return Promise.resolve({ data: rows, error: null }); } }) };
    assert.deepStrictEqual((await L.operationalCommunities(fake)).map((c) => c.id), ['a', 'n']);
    const bad = { from: () => ({ select() { return this; }, order() { return Promise.resolve({ data: null, error: { message: 'down' } }); } }) };
    await assert.rejects(L.operationalCommunities(bad), /down/, 'fail-closed: a lookup error never yields "all communities"');
  });

  await t('Check Receipts: scanning and recording are refused for a community no longer managed, before any read or posting', async () => {
    const refuse = async () => { throw Object.assign(new Error('Scanning a check refused: Bedrock stopped managing Eaglewood'), { code: 'community_not_operational' }); };
    let extracted = false;
    await assert.rejects(CR.intakeCheck({}, { communityId: 'e', front: { buffer: Buffer.from('x'), mimetype: 'image/png' }, scanBatchId: 'b', actor: 's', extract: async () => { extracted = true; }, gate: refuse }), (e) => e.code === 'community_not_operational');
    assert.strictEqual(extracted, false, 'the check is not even read');
    const db = { from: () => ({ select() { return this; }, eq() { return this; }, single() { return this; }, then(r) { return Promise.resolve({ data: { id: 'r', community_id: 'e', status: 'matched' }, error: null }).then(r); } }), rpc: async () => { throw new Error('must not reach the ledger'); } };
    await assert.rejects(CR.recordReceipt(db, 'r', { actor: 's', gate: refuse, post: async () => { throw new Error('must not post'); } }), (e) => e.code === 'community_not_operational');
  });

  await t('wired everywhere new activity starts (source checks)', () => {
    const cr = read('lib/payments/check_receipts.js');
    assert.ok(/await gate\(communityId, 'Scanning a check'\)/.test(cr) && /await gate\(rc\.community_id, 'Recording a check'\)/.test(cr) && /await gate\(communityId, 'Recording a deposit'\)/.test(cr) && /financialsGate\(rc\.community_id, 'Reversing a check'\)/.test(cr));
    const n = read('lib/collections/notices.js');
    assert.ok(/canDo\('financials', communityId\)/.test(n) && /assertCanDo\('financials', batch\.community_id/.test(n) && /assertCanDo\('financials', n\.community_id/.test(n) && /operationalCommunities\(supabase\)/.test(n));
    const ac = read('api/collections.js');
    assert.ok((ac.match(/assertCanDo\('financials'/g) || []).length >= 3, 'template approval, fee setting, legal-status confirmation');
    assert.ok(/assertCanDo\('enforcement', prop\.community_id, 'Opening a violation'\)/.test(read('lib/enforcement/find_or_continue_violation.js')));
    const en = read('api/enforcement.js');
    assert.ok(/lock-and-batch held/.test(en) && /violationsAll\.filter/.test(en) && /_LCp\.evaluate\('enforcement', c\)\.allowed/.test(en), 'mail queue, cure-lapse escalation, postcard reminders');
    assert.ok(/operationalCommunities\(supabase\)\)\.filter\(\(c\) => !c\.is_demo\)/.test(read('lib/scheduler.js')), 'key_events_capture');
    assert.ok(/canDo\('financials', a\.community_id\)/.test(read('lib/accounting/monthly_runs.js')) && /canDo\('financials', prog\.community_id\)/.test(read('lib/accounting/builder_accrual.js')));
    assert.ok(/isEnded\(community\)/.test(read('lib/amanda/request.js')) && /isEnded\(c\)/.test(read('lib/email/triage.js')));
  });

  await t('no Eaglewood exception is hard-coded in the rule or the gates', () => {
    for (const f of ['lib/community/lifecycle.js', 'lib/payments/check_receipts.js', 'lib/collections/notices.js', 'api/collections.js', 'lib/enforcement/find_or_continue_violation.js']) {
      const code = read(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, (m) => (/eaglewood/i.test(m) ? 'EAGLEWOOD_LITERAL' : '""'));
      assert.ok(!/EAGLEWOOD_LITERAL|a0000000-0000-4000-8000-000000000004/i.test(code), `${f} names Eaglewood in code`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
