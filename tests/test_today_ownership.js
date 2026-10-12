#!/usr/bin/env node
// Today ownership (Ed 2026-10-12): the owner sees only decisions that need the
// owner's authority; agent work names the agent and its next step; outside waits
// name the party and a follow-up date; finished work is completed. Controls stay
// with the owner: payment release, homeowner billback approval, pre-cutover
// posting, Kat's prepared accounting runs and the final (subjective) ACC decision.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const { classifyItem, buildSections } = require('../lib/feed/build');

let passed = 0; let failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const NOW = Date.parse('2026-10-12T17:00:00Z');
const emma = { key: 'emma', name: 'Emma', role: 'Accounts payable' };
const annie = { key: 'annie', name: 'Annie', role: 'ACC / ARC' };
const amanda = { key: 'amanda', name: 'Amanda', role: 'Operations' };
const obj = (owner_key, title, meta = {}) => ({ kind: 'objective', key: `objective:${title}`, title, why: meta.why || '', specialist: emma, lane: 'now', at: '2026-10-11T12:00:00Z', meta: { owner_key, last_activity_at: '2026-10-11T12:00:00Z', ...meta } });
const acc = (state) => ({ kind: 'acc_decision', key: `acc:${state}`, title: `ACC ${state}`, specialist: annie, lane: 'now', at: '2026-09-01T12:00:00Z', meta: { state, updated_at: '2026-09-01T12:00:00Z', last_activity_at: '2026-09-01T12:00:00Z' } });
const exc = (meta, why = '') => ({ kind: 'ap_exception', key: 'exc', title: 'Bill couldn\'t load', why, specialist: emma, lane: meta.missing ? 'waiting' : 'now', at: '2026-10-01T12:00:00Z', meta });

console.log('Today ownership');

t('payment release stays the owner\'s decision; a paid bill\'s release card is completed', () => {
  assert.strictEqual(classifyItem(obj('legal.payment', 'Payment awaiting release: X ($100.00)', { invoice_status: 'awaiting_approval' }), NOW).bucket, 'decision');
  assert.strictEqual(classifyItem(obj('legal.payment', 'Payment awaiting release: X ($100.00)', { invoice_status: 'paid' }), NOW).bucket, 'done');
});

t('homeowner billback approval stays the owner\'s decision; an approved treatment is completed (283101)', () => {
  assert.strictEqual(classifyItem(obj('legal.recovery', 'Approval required: $170.00 homeowner chargebacks on W 1', { review_status: 'draft' }), NOW).bucket, 'decision');
  assert.strictEqual(classifyItem(obj('legal.recovery', 'Approval required: $1140.00 homeowner chargebacks on D&F 283101', { review_status: 'approved' }), NOW).bucket, 'done');
});

t('a missing document is an outside wait; an unreachable source is the agent\'s next step, never the owner\'s', () => {
  const w = classifyItem(obj('legal.documentation', 'Documentation needed for D&F 280594 ($360.06): 1 missing, 1 source(s) inaccessible', { invoice_status: 'awaiting_approval' }), NOW);
  assert.strictEqual(w.bucket, 'waiting'); assert.ok(w.follow_up);
  assert.strictEqual(classifyItem(obj('legal.documentation', 'Documentation needed for X ($1.00): 0 missing, 3 source(s) inaccessible', { invoice_status: 'awaiting_approval' }), NOW).bucket, 'ai');
  assert.strictEqual(classifyItem(obj('legal.documentation', 'Documentation needed for D&F 278002 ($7559.41): 0 missing, 15 source(s) inaccessible', { invoice_status: 'paid' }), NOW).bucket, 'done');
});

t('pre-cutover posting is the owner\'s decision; a new payee is Emma\'s verification (payment release stays the owner\'s)', () => {
  const inv = (meta) => ({ kind: 'ap_invoice', key: 'i', title: 'bill', specialist: emma, lane: 'now', at: '2026-10-01T12:00:00Z', meta });
  assert.strictEqual(classifyItem(inv({ cutover: true }), NOW).bucket, 'decision');
  const np = classifyItem(inv({ first_payee: true }), NOW);
  assert.strictEqual(np.bucket, 'ai'); assert.match(np.next_action, /W-9/); assert.match(np.next_action, /you still release the payment/);
  assert.strictEqual(classifyItem(inv({ past_due: true }), NOW).decision_type, 'payment_release');
});

t('the subjective ACC decision stays with the owner; reviewing documents and drafting are Annie\'s; an info request waits on the homeowner', () => {
  assert.strictEqual(classifyItem(acc('drafted'), NOW).bucket, 'decision');
  assert.strictEqual(classifyItem(acc('new_documents'), NOW).bucket, 'ai');
  assert.strictEqual(classifyItem(acc('homeowner_wrote'), NOW).bucket, 'ai');
  const nd = classifyItem(acc('not_drafted'), NOW); assert.strictEqual(nd.bucket, 'ai'); assert.match(nd.next_action, /comes to you to approve/);
  const w = classifyItem(acc('info_requested'), NOW); assert.strictEqual(w.bucket, 'waiting'); assert.strictEqual(w.waiting_on, 'the homeowner');
});

t('a bill that could not load is Emma\'s work (ask for the invoice, match the receipt, find the community), not the owner\'s', () => {
  assert.match(classifyItem(exc({ not_invoice: true }), NOW).next_action, /Ask the sender for the actual invoice/);
  assert.strictEqual(classifyItem(exc({ handoff: true }), NOW).bucket, 'ai');
  assert.strictEqual(classifyItem(exc({ missing: 'which community it belongs to' }), NOW).bucket, 'ai');
});

t('a failed job is retried by the agent; it reaches the owner only when it keeps failing', () => {
  const job = (n) => ({ kind: 'cron_run', key: `c${n}`, title: 'Scheduled job failed: x', specialist: amanda, lane: 'now', at: '2026-10-12T10:00:00Z', meta: { job: 'x', failures_24h: n } });
  assert.strictEqual(classifyItem(job(1), NOW).bucket, 'ai');
  assert.strictEqual(classifyItem(job(3), NOW).bucket, 'decision');
});

t('sections: release cards group into one decision; agent cards on one invoice merge; stale agent work is shown as stale, not progress', () => {
  const items = [
    obj('legal.payment', 'Payment awaiting release: A ($100.00)', { invoice_status: 'awaiting_approval', subject_id: 'a' }),
    obj('legal.payment', 'Payment awaiting release: B ($50.50)', { invoice_status: 'awaiting_approval', subject_id: 'b' }),
    obj('legal.recovery', 'Homeowner recovery on C ($9.00): 1 exception', { subject_id: 'c' }),
    obj('legal.documentation', 'Documentation needed for C ($9.00): 1 missing', { subject_id: 'c', invoice_status: 'awaiting_approval' }),
    acc('new_documents'),
  ];
  const S = buildSections(items, [], NOW, { sweepScheduled: false });
  assert.strictEqual(S.decisions.length, 1); assert.strictEqual(S.decisions[0].members.length, 2); assert.strictEqual(S.decisions[0].total_cents, 15050);
  assert.strictEqual(S.waiting.length, 1); assert.strictEqual((S.waiting[0].also || []).length, 1, 'the recovery card folds into the outside wait');
  const a = S.ai_working.find((x) => x.kind === 'acc_decision'); assert.strictEqual(a.status, 'stale'); assert.match(a.status_text, /sweep is off/);
  assert.ok(S.ai_working.every((x) => x.owner && x.next_action), 'every agent card names its owner and next step');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
