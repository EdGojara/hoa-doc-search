#!/usr/bin/env node
// Former clients stop generating operational work (Ed 2026-10-22), by the lifecycle rule
// (archived, terminated or past management_end_date), never a name list:
//   * Statement Tracker: statements are owed only through the last managed month.
//   * AP intake: a bank account of a former client never matches an invoice, and the last
//     four digits alone never pick a community (they confirm one the bill already names).
// Pure tests (stubbed resolvers, no database).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/community/lifecycle');
const I = require('../lib/ap/intake');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

const CG = { id: 'cg', name: 'Canyon Gate at Cinco Ranch' };
const WV = { id: 'wv', name: 'Waterview Estates' };
const EW = { id: 'ew', name: 'Eaglewood' };
const BY_ID = { cg: CG, wv: WV, ew: EW };
const ACTIVE = { management_status: 'active', management_end_date: null };
const deps = {
  resolveCommunity: async (text) => {
    const s = String(text || '').toLowerCase();
    if (/canyon gate/.test(s)) return { community: CG };
    if (/waterview/.test(s)) return { community: WV };
    return { community: null, candidates: [] };
  },
  resolveCommunityByEmailDomain: async () => null,
  communityById: (id) => BY_ID[id] || { id, name: null },
  bankAccounts: [
    { community_id: 'cg', account_last4: '5313', account_nickname: 'Canyon Gate Operating Checking (NewFirst)', is_active: true, communities: { name: CG.name, ...ACTIVE } },
    { community_id: 'wv', account_last4: '5961', account_nickname: 'Waterview Operating Checking', is_active: true, communities: { name: WV.name, ...ACTIVE } },
    { community_id: 'ew', account_last4: '7385', account_nickname: 'Eaglewood Operating Checking', is_active: true, communities: { name: EW.name, management_status: 'archived', management_end_date: '2026-09-30' } },
  ],
};
const decide = async (args, d = deps) => { const ev = await I.associationEvidence(args, d); return { ev, d: I.decideAssociation(ev) }; };

(async () => {
  console.log('Statement Tracker: statements owed only while Bedrock manages the community');
  await t('an active community owes every month (undefined = no limit)', async () => {
    assert.strictEqual(L.statementsExpectedThrough({ management_status: 'active' }, '2026-10-22'), undefined);
    assert.strictEqual(L.statementsExpectedThrough({ management_status: 'terminating', management_end_date: '2026-12-31' }, '2026-10-22'), undefined, 'still inside its notice period');
  });
  await t('a former client owes statements through its last managed month only (Eaglewood: through 2026-09)', async () => {
    assert.strictEqual(L.statementsExpectedThrough({ management_status: 'archived', management_end_date: '2026-09-30' }, '2026-10-22'), '2026-09');
    assert.strictEqual(L.statementsExpectedThrough({ management_status: 'active', management_end_date: '2026-09-30' }, '2026-10-22'), '2026-09', 'past its last day counts as ended even if the status was not flipped');
  });
  await t('a former client with no last day on file, or a prospect, owes nothing further', async () => {
    assert.strictEqual(L.statementsExpectedThrough({ management_status: 'terminated' }, '2026-10-22'), null);
    assert.strictEqual(L.statementsExpectedThrough({ management_status: 'prospect' }, '2026-10-22'), null);
  });
  await t('wired: the tracker API reads the lifecycle fields and returns expected_through; the page stops counting later months as missing', async () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'checks.js'), 'utf8');
    assert.ok(/community:community_id\(name, management_status, management_end_date\)/.test(api) && /statementsExpectedThrough\(a\.community\)/.test(api) && /expected_through/.test(api));
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'statement-tracker.html'), 'utf8');
    assert.ok(/a\.former_client && \(!a\.expected_through \|\| m\.key > a\.expected_through\)/.test(page), 'months after the last managed month are not counted');
    assert.ok(!/Eaglewood/.test(page), 'no hard-coded community name on the page');
  });

  console.log('AP intake: the paying bank account');
  await t('a former client\'s account never matches an invoice (recorded as ignored, never evidence)', async () => {
    const { ev, d } = await decide({ extracted: { payment_account_last4: '7385' } });
    assert.ok(ev.some((i) => i.kind === 'payment_account' && i.strength === 'ignored' && i.community_id === 'ew' && /former client/.test(i.detail)));
    assert.ok(!ev.some((i) => i.community_id === 'ew' && i.strength !== 'ignored'), 'Eaglewood is never strong or weak evidence');
    assert.strictEqual(d.decision, 'none');
    assert.ok(/former client, not used/.test(I.describeEvidence(ev)), 'the note says the account was not used');
  });
  await t('last four alone never picks a community: only a weak hint, not "selected"', async () => {
    const { ev, d } = await decide({ extracted: { payment_account_last4: '5961' } });
    assert.ok(ev.some((i) => i.kind === 'payment_account' && i.strength === 'weak' && i.community_id === 'wv'));
    assert.notStrictEqual(d.decision, 'selected');
  });
  await t('last four confirming the community the bill names is strong evidence for it', async () => {
    const { d } = await decide({ extracted: { bill_to: 'Canyon Gate at Cinco Ranch HOA', payment_account_last4: '5313' } });
    assert.strictEqual(d.decision, 'selected'); assert.strictEqual(d.community_id, 'cg');
    assert.ok(d.basis.includes('payment_account') && d.basis.includes('bill_to'));
  });
  await t('last four matching a DIFFERENT active community than the bill names cannot move the bill there (weak, recorded as overruled)', async () => {
    const { d } = await decide({ extracted: { bill_to: 'Canyon Gate at Cinco Ranch HOA', payment_account_last4: '5961' } });
    assert.strictEqual(d.decision, 'selected'); assert.strictEqual(d.community_id, 'cg');
    assert.ok(d.overruled.some((i) => i.kind === 'payment_account' && i.community_id === 'wv'));
  });
  await t('a former client\'s account with the same last four as an active one is dropped; the active one still confirms', async () => {
    const d2 = { ...deps, bankAccounts: [...deps.bankAccounts, { community_id: 'ew', account_last4: '0313', account_nickname: 'Eaglewood Savings', is_active: true, communities: { name: EW.name, management_status: 'archived', management_end_date: '2026-09-30' } }] };
    const { d } = await decide({ extracted: { bill_to: 'Canyon Gate at Cinco Ranch HOA', payment_account_last4: '313' } }, d2);
    assert.strictEqual(d.decision, 'selected'); assert.strictEqual(d.community_id, 'cg'); assert.ok(d.basis.includes('payment_account'));
  });
  await t('wired: a weak association (e.g. last four alone) is held for review unless the bill or email confirms it, never posted', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ap', 'intake.js'), 'utf8');
    const at = src.indexOf("if (cid && (cidSource === 'email' || cidSource === 'hint' || assoc.decision === 'weak')) {");
    assert.ok(at > 0, 'the corroboration guard covers every weak decision');
    const guard = src.slice(at, at + 1200);
    assert.ok(/outcome: 'needs_review'/.test(guard) && /community_unconfirmed/.test(guard), 'an unconfirmed weak association is held');
  });
  await t('wired: the intake query loads each account\'s community lifecycle', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ap', 'intake.js'), 'utf8');
    assert.ok(/communities\(name, management_status, management_end_date\)/.test(src) && /isOperational\(a\.communities\)/.test(src));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
