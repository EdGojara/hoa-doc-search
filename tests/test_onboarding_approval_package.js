#!/usr/bin/env node
// ============================================================================
// Owner approval package (Ed 2026-10-31): one authenticated action approves the
// selected decisions, but every decision still goes through the existing owner-only
// decideObject / decide path: the owner's id, the in-app channel, the exact
// fingerprint / bridge result, one database decision per item, tagged with the
// package id. Recommendations are pre-selections only. Bulk never rejects, never
// waives, never approves a preflight and never executes.
// ============================================================================
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createOnboardingService } = require('../lib/onboarding/service');
const { buildRouter } = require('../api/onboarding');
const REC = require('../lib/onboarding/approval_recommendations');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const OWNER = { kind: 'human', id: 'u-owner', email: 'owner@example.test', role: 'owner' };
const ADMIN = { kind: 'human', id: 'u-admin', email: 'staff@example.test', role: 'admin' };
const FP = (c) => c.repeat(64);

function world() {
  const calls = [];
  const objects = { B1: { adjustments: [{ id: 'a1', status: 'proposed', fingerprint: FP('a') }, { id: 'a2', status: 'proposed', fingerprint: FP('b') }], policies: [{ id: 'p1', status: 'proposed', fingerprint: FP('c') }], exceptions: [], events: [] } };
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'conversion_objects_view') return objects[args.p_batch] || null;
    if (name === 'conversion_decide_object') {
      if (args.p_object_id === 'a2') { const e = new Error('onboarding: the fingerprint you reviewed is not this adjustment (it may have been superseded)'); e.code = '23514'; throw e; }
      return { id: args.p_object_id, status: args.p_decision };
    }
    if (name === 'onboarding_record_bridge_decisions') return args.p_decisions.map((d, i) => ({ id: 'd' + i, event_key: d.event_key, choice: d.choice }));
    throw new Error('not in this test world: ' + name);
  };
  return { calls, service: createOnboardingService({ rpc, storage: { putOnce: async () => {} } }) };
}

check('only the owner, only in the app: a non-owner or a missing channel is refused before any database call', async () => {
  const { calls, service } = world();
  await assert.rejects(service.approvePackage(ADMIN, { objects: [{ batch_id: 'B1', object_type: 'policy', id: 'p1', fingerprint: FP('c') }] }, { channel: 'in_app' }), /OWNER_ONLY|only the owner/);
  await assert.rejects(service.approvePackage(OWNER, { objects: [{ batch_id: 'B1', object_type: 'policy', id: 'p1', fingerprint: FP('c') }] }, {}), /in the app/);
  await assert.rejects(service.approvePackage(ADMIN, {}, { channel: 'in_app' }), /only the owner/);
  await assert.rejects(service.approvalPackage(ADMIN), /only the owner/);
  assert.strictEqual(calls.length, 0);
});

check('each selected object is its own owner decision with the exact fingerprint, in-app, tagged with the package id; one failure does not stop the rest', async () => {
  const { calls, service } = world();
  const r = await service.approvePackage(OWNER, { objects: [
    { batch_id: 'B1', object_type: 'adjustment', id: 'a1', fingerprint: FP('a') },
    { batch_id: 'B1', object_type: 'adjustment', id: 'a2', fingerprint: FP('b') },
    { batch_id: 'B1', object_type: 'policy', id: 'p1', fingerprint: FP('c') }] }, { channel: 'in_app' });
  const dec = calls.filter((c) => c.name === 'conversion_decide_object');
  assert.strictEqual(dec.length, 3, 'one database decision per item');
  for (const d of dec) {
    assert.strictEqual(d.args.p_actor_kind, 'human'); assert.strictEqual(d.args.p_actor_id, 'u-owner'); assert.strictEqual(d.args.p_channel, 'in_app');
    assert.strictEqual(d.args.p_decision, 'approved'); assert.ok(new RegExp('owner approval package ' + r.package_id).test(d.args.p_note));
  }
  assert.deepStrictEqual(dec.map((d) => d.args.p_fingerprint), [FP('a'), FP('b'), FP('c')]);
  assert.strictEqual(r.approved, 2); assert.strictEqual(r.failed, 1);
  assert.ok(/fingerprint you reviewed/.test(r.results.find((x) => x.id === 'a2').error), 'the refusal is reported, not hidden');
});

check('bridge answers: one recorded call per batch and bridge result, each answer its own row with the package tag; bulk never rejects', async () => {
  const { calls, service } = world();
  await service.approvePackage(OWNER, { bridge: [
    { batch_id: 'B1', completion_id: 'c1', event_key: 'ap:x', choice: 'keep_as_trusted_activity', reason: 'check cleared the bank' },
    { batch_id: 'B1', completion_id: 'c1', event_key: 'ap:y', choice: 'already_in_legacy_books' }] }, { channel: 'in_app' });
  const b = calls.filter((c) => c.name === 'onboarding_record_bridge_decisions');
  assert.strictEqual(b.length, 1); assert.strictEqual(b[0].args.p_completion, 'c1'); assert.strictEqual(b[0].args.p_actor_id, 'u-owner');
  assert.deepStrictEqual(b[0].args.p_decisions.map((d) => d.choice), ['keep_as_trusted_activity', 'already_in_legacy_books']);
  assert.ok(b[0].args.p_decisions.every((d) => /^owner approval package [0-9a-f-]{36}/.test(d.reason)) && /check cleared the bank/.test(b[0].args.p_decisions[0].reason));
  assert.ok(!calls.some((c) => /waive|advance|approve_preflight|execute/.test(c.name)), 'never waives, advances, approves a preflight or executes');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'service.js'), 'utf8');
  const body = src.slice(src.indexOf('async function approvePackage'), src.indexOf('// What the operator needs from a human right now'));
  assert.ok(!/decision: 'rejected'|waive\(|advance\(|approveByHash\(|execute\(/.test(body));
});

check('the API takes the owner from the session and sets the in-app channel itself; an admin is refused', async () => {
  const seen = [];
  const service = { approvalPackage: async (a) => { seen.push(['view', a]); return { batches: [] }; }, approvePackage: async (a, body, opts) => { seen.push(['approve', a, body, opts]); return { ok: true }; } };
  const auth = { OWNER_EMAIL: 'owner@example.test',
    async requireAdmin(req, res) { return { user: { id: 'u-' + req.headers['x-u'] }, email: req.headers['x-u'] === 'owner' ? 'owner@example.test' : 'staff@example.test' }; },
    async requireOwner(req, res) { if (req.headers['x-u'] !== 'owner') { res.status(403).json({ error: 'owner_only' }); return null; } return { user: { id: 'u-owner' }, email: 'owner@example.test' }; } };
  const app = express(); app.use('/api/onboarding', buildRouter({ service, auth, listCommunities: async () => [] }));
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/onboarding`;
  try {
    assert.strictEqual((await fetch(base + '/approval-package', { headers: { 'x-u': 'admin' } })).status, 403);
    assert.strictEqual((await fetch(base + '/approval-package/approve', { method: 'POST', headers: { 'x-u': 'admin', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const r = await fetch(base + '/approval-package/approve', { method: 'POST', headers: { 'x-u': 'owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', actor: { kind: 'agent' }, objects: [{ batch_id: 'B1', object_type: 'policy', id: 'p1', fingerprint: FP('c'), approved_by: 'someone' }] }) });
    assert.strictEqual(r.status, 200);
    const [, actor, body, opts] = seen.find((s) => s[0] === 'approve');
    assert.deepStrictEqual(actor, { kind: 'human', id: 'u-owner', email: 'owner@example.test', role: 'owner' });
    assert.deepStrictEqual(opts, { channel: 'in_app' }, 'the channel comes from the route, never the body');
    assert.ok(!('approved_by' in body.objects[0]), 'only the selection fields reach the service');
  } finally { srv.close(); }
});

check('recommendations are pre-selections keyed to real proposals and choices; an item the bridge does not offer is never recommended', () => {
  assert.deepStrictEqual(REC.forObject('CONV-SCR-20260731', 'a7fd25de-0000').decision, 'approved');
  assert.strictEqual(REC.forObject('CONV-SCR-20260731', 'ffffffff-0000'), null);
  const q = { records: ['ap_payments:faee090b-6480-4547-badc-abe49ccdaf6b'], choices: [{ key: 'already_in_legacy_books' }, { key: 'keep_as_trusted_activity' }] };
  assert.strictEqual(REC.forBridge('CONV-WE-20260731', q).choice, 'keep_as_trusted_activity');
  assert.strictEqual(REC.forBridge('CONV-WE-20260731', { ...q, choices: [{ key: 'record_after_cutoff' }] }), null, 'never a choice the question does not offer');
  const all = Object.values(REC.PACKAGE).flatMap((p) => Object.values(p.bridge).map((x) => x[0]));
  assert.ok(all.every((c) => ['already_in_legacy_books', 'keep_as_trusted_activity'].includes(c)));
  assert.ok(!/Davis|Hamilton|Martinez|Teske/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'approval_recommendations.js'), 'utf8')), 'no homeowner names in a public repo');
});

check('the recording-period question offers "already in the legacy books" (a bill held under another number)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'bridge.js'), 'utf8');
  const fn = src.slice(src.indexOf('function periodDecision'), src.indexOf('function genericDecision'));
  assert.ok(/key: 'already_in_legacy_books'/.test(fn) && /recommended: accrual \? 'accrued_in_legacy_books' : 'record_after_cutoff'/.test(fn));
  const plan = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'conversion_plan.js'), 'utf8');
  assert.ok(/dec\.choice_key === 'already_in_legacy_books'/.test(plan), 'the conversion plan already treats that choice');
});

check('the review screen: one Approve action, recommendations labeled apart from approvals, unticked items stay pending, no execute or preflight control', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  const fn = html.slice(html.indexOf('async function loadApprovalPackage'), html.indexOf('function renderDetail(v)'));
  assert.ok(/\/api\/onboarding\/approval-package\/approve/.test(fn) && /id="pkgApprove"/.test(fn));
  assert.ok(/nothing here is approved until you press Approve/.test(fn) && /'Recommended'/.test(fn) && /Engine suggestion/.test(fn));
  assert.ok(/Unticked items stay pending/.test(fn));
  assert.ok(!/\/execute|\/batches\/.*\/approve'|approveByHash|pfExecute/.test(fn), 'no preflight approval or execute in the package');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Owner approval package');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
